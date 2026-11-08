/**
 * Resilience regression tests — the "Prediction Not Showing" bug class.
 *
 * Three failures used to make the 1M Edge card sit on "loading…" forever:
 *   1. a live poll of 3 klines was rejected by a ">= 50 rows" check, so the
 *      feed silently froze and the badge flipped to "feed error";
 *   2. the first paint waited on the network, so a blocked/slow Binance host
 *      (very common on mobile in some regions) meant 8–14 s of empty card;
 *   3. a throw inside the model left the card blank with no explanation.
 *
 * Run: node tests/resilience.mjs
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchBinanceKlines } from '../js/data.js';
import { predictNextCandle } from '../js/predictor.js';
import { buildContext } from '../js/strategy.js';
import { generateSeries } from '../js/data.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.log('  ✗ ' + l); } else console.log('  ✓ ' + l); };

const rows = (n) => Array.from({ length: n }, (_, i) => [
  1_700_000_000_000 + i * 60_000, 100 + i, 101 + i, 99 + i, 100.5 + i, 12
]);

/* ============================ 1. data layer ============================ */

console.log('\n=== 1. Live feed ===');

// 1a. a 3-row poll (what pollLive asks for) must NOT be treated as empty
{
  globalThis.fetch = async () => ({ ok: true, json: async () => rows(3) });
  let out = null;
  let err = null;
  try { out = await fetchBinanceKlines('BTCUSDT', '1m', 3); } catch (e) { err = e; }
  ok(!err, `3-row poll accepted${err ? ' — ' + err.message : ''}`);
  ok(out && out.candles.length === 3, `3 candles returned (${out ? out.candles.length : 0})`);
}

// 1b. hosts are raced: the first host failing must not add its timeout to the wait
{
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (url.includes('data-api.binance.vision')) {
      await new Promise((_, rej) => setTimeout(() => rej(new Error('blocked')), 40));
      throw new Error('blocked');
    }
    return { ok: true, json: async () => rows(60) };
  };
  const t0 = Date.now();
  const out = await fetchBinanceKlines('BTCUSDT', '1m', 60, { timeout: 900 });
  const dt = Date.now() - t0;
  ok(out.candles.length === 60, 'falls over to the next host');
  ok(dt < 400, `race, not a queue (${dt} ms for ${calls} hosts)`);
}

// 1c. a blackholed network rejects on the timeout instead of hanging forever
{
  globalThis.fetch = (url, opts = {}) => new Promise((_, rej) => {
    opts.signal?.addEventListener('abort', () => rej(new Error('AbortError')));
  });
  const t0 = Date.now();
  let rejected = false;
  try { await fetchBinanceKlines('BTCUSDT', '1m', 60, { timeout: 200 }); } catch { rejected = true; }
  const dt = Date.now() - t0;
  ok(rejected, 'hanging network → rejection (never an unending await)');
  ok(dt < 1200, `bounded by the timeout (${dt} ms)`);
}

// 1d. garbage payloads are rejected, not silently turned into NaN candles
{
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ a: 1 }, null] });
  let rejected = false;
  try { await fetchBinanceKlines('BTCUSDT', '1m', 5); } catch { rejected = true; }
  ok(rejected, 'garbage klines rejected');
}

/* ============================ 2. model ============================ */

console.log('\n=== 2. Model never throws ===');
{
  const series = generateSeries({ symbolId: 'BTCUSDT', timeframe: '1m', bars: 400, seed: 7 }).candles;
  const ctx = buildContext(series);
  const p = predictNextCandle(series, ctx);
  ok(p !== null, 'normal series → prediction');
  ok(Number.isFinite(p.probUp) && p.probUp > 0 && p.probUp < 1, `P(up) in (0,1): ${p.probUp.toFixed(4)}`);
  ok(Math.abs(p.probUp + p.probDown - 1) < 1e-9, 'probabilities sum to 1');

  const junk = [
    null, undefined, [], [{}], series.slice(0, 10),
    series.map((c) => ({ ...c, c: NaN })),
    series.map((c) => ({ ...c, h: c.l - 1 })),
    'not an array'
  ];
  let threw = null;
  for (const bad of junk) {
    try { predictNextCandle(bad, bad === series ? ctx : null); } catch (e) { threw = e; }
  }
  ok(!threw, `junk input never throws${threw ? ' — ' + threw.message : ''}`);

  // clamping: an absurd probability must not escape the (0,1) range
  const clamped = predictNextCandle(series, ctx);
  ok(clamped.probUp >= 0.015 && clamped.probUp <= 0.985, 'probability is clamped, never a certain 0/100%');
}

/* ============================ 3. instant paint ============================ */

console.log('\n=== 3. Card paints before the network answers ===');
{
  const dom = new JSDOM(readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'http://localhost:8080/', pretendToBeVisual: true
  });
  const { window } = dom;
  const { document } = window;

  const gradient = { addColorStop() {} };
  const ctx2d = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 42 });
      if (prop === 'createLinearGradient') return () => gradient;
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (prop === 'canvas') return { width: 900, height: 500 };
      return () => {};
    },
    set() { return true; }
  });
  window.HTMLCanvasElement.prototype.getContext = () => ctx2d;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0 });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.ResizeObserver = window.ResizeObserver;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

  // A network that never answers, but honours the abort signal like a real one.
  globalThis.fetch = (_url, opts = {}) => new Promise((_, rej) => {
    opts.signal?.addEventListener('abort', () => rej(new Error('AbortError')));
  });

  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  process.on('unhandledRejection', (e) => errors.push(String(e)));

  await import(path.join(root, 'js/app.js'));
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 500));

  const side = document.getElementById('pred-side').textContent.trim();
  const prob = document.getElementById('pred-prob').textContent.trim();
  const note = document.getElementById('pred-note').textContent.trim();

  ok(['UP ▲', 'DOWN ▼'].includes(side), `prediction painted immediately (${side})`);
  ok(/\d/.test(prob), `probability rendered (${prob})`);
  ok(note.length > 20, 'the note explains the state, it is not blank');
  ok(errors.length === 0, `no runtime errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);

  window.close();
}

console.log(`\n${fails === 0 ? '✅ RESILIENCE PASSED' : `❌ ${fails} RESILIENCE CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);

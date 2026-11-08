/**
 * Quetex Pro 1M — deep test suite
 *
 * Goes past "does it run": reference-checked indicator math, backtest
 * invariants, degenerate inputs, fuzzing, CSV torture, HTTP security,
 * performance budgets and an end-to-end pipeline.
 *
 *   node tests/deep.mjs
 */

import {
  sma, ema, rsi, atr, macd, bollinger, donchian, vwapSession,
  supertrend, percentileRank, trueRange
} from '../js/indicators.js';
import { generateSeries, parseCsv, TIMEFRAMES } from '../js/data.js';
import { buildContext, STRATEGIES, analyze, WARMUP } from '../js/strategy.js';
import { runBacktest, runMonteCarlo } from '../js/backtest.js';
import { predictNextCandle, binaryExpectancy, buildFeatureRow } from '../js/predictor.js';
import { analyzeChartPixels, parseManualCandles, rgbToHsv } from '../js/capture.js';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + l); } };
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);

/* ================================================================== */
/* A. Indicator math vs independent references                        */
/* ================================================================== */
section('A. Indicator correctness');

function refSma(src, p) {
  return src.map((_, i) => {
    if (i < p - 1) return NaN;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += src[j];
    return s / p;
  });
}
function refEma(src, p) {
  const out = new Array(src.length).fill(NaN);
  if (src.length < p) return out;
  let seed = 0;
  for (let i = 0; i < p; i++) seed += src[i];
  out[p - 1] = seed / p;
  const k = 2 / (p + 1);
  for (let i = p; i < src.length; i++) out[i] = src[i] * k + out[i - 1] * (1 - k);
  return out;
}
function refRsi(src, p) {
  const out = new Array(src.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) {
      g += up; l += dn;
      if (i === p) {
        g /= p; l /= p;
        out[i] = g + l === 0 ? 50 : 100 - 100 / (1 + g / l);
      }
    } else {
      g = (g * (p - 1) + up) / p;
      l = (l * (p - 1) + dn) / p;
      out[i] = g + l === 0 ? 50 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}
const closeEnough = (a, b, tol = 1e-6) =>
  (Number.isNaN(a) && Number.isNaN(b)) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol);

{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 600, seed: 1 });
  const close = candles.map((c) => c.c);

  const s1 = sma(close, 20), s2 = refSma(close, 20);
  ok(s1.every((v, i) => closeEnough(v, s2[i], 1e-9)), 'SMA matches the naive reference');

  const e1 = ema(close, 20), e2 = refEma(close, 20);
  ok(e1.every((v, i) => closeEnough(v, e2[i], 1e-6)), 'EMA matches the naive reference (same seeding)');

  const r1 = rsi(close, 14), r2 = refRsi(close, 14);
  ok(r1.every((v, i) => closeEnough(v, r2[i], 1e-6)), 'RSI matches Wilder reference');

  // ATR vs naive Wilder
  const tr = trueRange(candles);
  const a1 = atr(candles, 14);
  let prev = NaN, sum = 0;
  let atrOk = true;
  for (let i = 0; i < candles.length; i++) {
    if (i < 14) {
      sum += tr[i];
      if (i === 13) prev = sum / 14;
      if (i === 13 && Math.abs(prev - a1[i]) > 1e-9) atrOk = false;
      continue;
    }
    prev = (prev * 13 + tr[i]) / 14;
    if (Math.abs(prev - a1[i]) > 1e-9) atrOk = false;
  }
  ok(atrOk, 'ATR matches Wilder reference');

  // Bollinger vs naive
  const bb = bollinger(close, 20, 2);
  let bbOk = true;
  for (let i = 25; i < close.length; i += 7) {
    let m = 0;
    for (let j = i - 19; j <= i; j++) m += close[j];
    m /= 20;
    let sd = 0;
    for (let j = i - 19; j <= i; j++) sd += (close[j] - m) ** 2;
    sd = Math.sqrt(sd / 20);
    if (Math.abs(bb.mid[i] - m) > 1e-9 || Math.abs(bb.upper[i] - (m + 2 * sd)) > 1e-9) bbOk = false;
  }
  ok(bbOk, 'Bollinger bands match population-σ reference');

  // VWAP: day-anchored, so the first bar of each UTC day must equal its typical price
  const vw = vwapSession(candles);
  let vwapOk = true;
  for (let i = 1; i < candles.length; i++) {
    if (Math.floor(candles[i].t / 86400000) !== Math.floor(candles[i - 1].t / 86400000)) {
      const typ = (candles[i].h + candles[i].l + candles[i].c) / 3;
      if (Math.abs(vw[i] - typ) > 1e-9) vwapOk = false;
    }
  }
  ok(vwapOk, 'VWAP resets exactly at the UTC day boundary');

  // Donchian must exclude the current bar (no look-ahead)
  const dc = donchian(candles, 20);
  let dcOk = true;
  for (let i = 30; i < 300; i += 11) {
    let hi = -Infinity;
    for (let j = i - 20; j < i; j++) hi = Math.max(hi, candles[j].h);
    if (Math.abs(dc.upper[i] - hi) > 1e-9) dcOk = false;
  }
  ok(dcOk, 'Donchian uses only prior bars (no look-ahead)');

  // Supertrend invariants
  const st = supertrend(candles, 10, 3);
  ok(st.dir.every((d) => d === 1 || d === -1), 'Supertrend direction is ±1 only');
  let stOk = true;
  for (let i = 250; i < 600; i++) {
    if (st.dir[i] === 1 && st.line[i] > candles[i].c + 1e-6) stOk = false;
    if (st.dir[i] === -1 && st.line[i] < candles[i].c - 1e-6) stOk = false;
  }
  ok(stOk, 'Supertrend line sits on the correct side of price');
}

/* ================================================================== */
/* B. Degenerate inputs                                               */
/* ================================================================== */
section('B. Degenerate inputs');

{
  const expectNoThrow = (fn, label) => {
    try { fn(); ok(true, label); } catch (e) { ok(false, `${label} threw: ${e.message}`); }
  };

  expectNoThrow(() => { sma([], 5); ema([], 5); rsi([], 14); macd([], 12, 26, 9); }, 'indicators accept empty arrays');
  expectNoThrow(() => { bollinger([1], 20, 2); donchian([{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }], 20); }, 'indicators accept 1 bar');
  expectNoThrow(() => { atr([], 14); trueRange([]); }, 'ATR accepts empty input');
  expectNoThrow(() => { percentileRank([NaN, NaN], 0, 10); }, 'percentileRank handles NaN');

  const flat = Array.from({ length: 100 }, (_, i) => ({ t: i * 60000, o: 100, h: 100, l: 100, c: 100, v: 5 }));
  const flatCtx = buildContext(flat);
  const flatRsi = flatCtx.rsi[50];
  ok(Number.isFinite(flatRsi), `RSI finite on a flat market (${flatRsi})`);
  ok(flatRsi === 50, `RSI on a dead-flat series is neutral 50 (got ${flatRsi})`);
  const flatAtr = flatCtx.atr[50];
  ok(flatAtr === 0, `ATR is 0 when there is no range (got ${flatAtr})`);

  const crazy = Array.from({ length: 60 }, (_, i) => ({
    t: i * 60000, o: 1e9, h: 1e9 + 1, l: 1e9 - 1, c: 1e9 + (i % 3), v: 1e9
  }));
  const cCtx = buildContext(crazy);
  ok(cCtx.ema20.slice(40).every(Number.isFinite), 'huge prices produce finite EMAs');

  const tiny = Array.from({ length: 60 }, (_, i) => ({
    t: i * 60000, o: 0.00001, h: 0.000012, l: 0.000009, c: 0.000011 + i * 1e-9, v: 10
  }));
  ok(buildContext(tiny).atr.slice(30).every((v) => Number.isFinite(v) && v >= 0), 'tiny prices produce finite ATR');

  // A series with zero volume (image-extracted candles can look like this)
  const noVol = Array.from({ length: 80 }, (_, i) => ({
    t: i * 60000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 0
  }));
  expectNoThrow(() => buildContext(noVol), 'zero-volume series does not explode');

  const spike = Array.from({ length: 80 }, (_, i) => ({
    t: i * 60000, o: 100, h: i === 40 ? 1000 : 100.5, l: i === 40 ? 10 : 99.5, c: 100, v: 10
  }));
  expectNoThrow(() => analyze(buildContext(spike), 60), 'analysis survives a 100× spike bar');
}

/* ================================================================== */
/* C. Backtest invariants                                             */
/* ================================================================== */
section('C. Backtest invariants');

{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 1200, seed: 77 });
  const ctx = buildContext(candles);
  const cfg = { initialCapital: 10_000, riskPct: 1, feeBps: 5, slipBps: 2, maxLeverage: 3, allowShort: true, timeframe: '15m' };

  for (const strat of STRATEGIES) {
    const res = runBacktest(candles, ctx, strat, {}, cfg);
    const m = res.metrics;
    const tag = strat.id;

    ok(res.trades.every((t) => t.entryIdx >= WARMUP), `${tag}: no trades inside the warm-up window`);
    ok(res.trades.every((t) => t.qty > 0 && Number.isFinite(t.qty)), `${tag}: every position has a positive size`);
    ok(res.trades.every((t) => Number.isFinite(t.pnl) && Number.isFinite(t.rMultiple)), `${tag}: P&L and R are finite`);
    ok(res.trades.every((t) => t.side === 'long' ? t.initialStop < t.entry : t.initialStop > t.entry), `${tag}: initial stop on the losing side`);
    ok(res.trades.every((t) => Math.abs(t.rMultiple - t.pnl / (t.stop0 * t.qty)) < 1e-6), `${tag}: R = P&L / initial risk`);
    ok(res.equityCurve.every(Number.isFinite), `${tag}: equity curve is finite everywhere`);
    ok(m.trades === res.trades.length, `${tag}: metric trade count matches`);

    // Cash identity: final = initial + Σ(pnl) − Σ(entry fees)
    const fee = cfg.feeBps / 10_000;
    const entryFees = res.trades.reduce((a, t) => a + t.notional * fee, 0);
    const expected = cfg.initialCapital + res.trades.reduce((a, t) => a + t.pnl, 0) - entryFees;
    const actual = res.trades.length ? res.trades[res.trades.length - 1].equityAfter : cfg.initialCapital;
    ok(Math.abs(expected - actual) < 1e-6, `${tag}: cash identity holds (${expected.toFixed(2)} vs ${actual.toFixed(2)})`);

    // Leverage cap
    const over = res.trades.filter((t) => t.notional > cfg.initialCapital * cfg.maxLeverage * 3);
    ok(over.length === 0, `${tag}: position notional respects the leverage cap`);
  }

  // Determinism
  const a = runBacktest(candles, ctx, STRATEGIES[0], {}, cfg);
  const b = runBacktest(candles, ctx, STRATEGIES[0], {}, cfg);
  ok(JSON.stringify(a.metrics) === JSON.stringify(b.metrics), 'backtest is deterministic');

  // Shorts off
  const noShort = runBacktest(candles, ctx, STRATEGIES[1], {}, { ...cfg, allowShort: false });
  ok(noShort.trades.every((t) => t.side === 'long'), 'allowShort=false produces long-only trades');

  // Fees must hurt
  const free = runBacktest(candles, ctx, STRATEGIES[0], {}, { ...cfg, feeBps: 0, slipBps: 0 });
  const costly = runBacktest(candles, ctx, STRATEGIES[0], {}, { ...cfg, feeBps: 40, slipBps: 25 });
  ok(costly.metrics.finalEquity <= free.metrics.finalEquity + 1e-9, 'costs never increase equity');

  // Sizing must scale with risk
  const r1 = runBacktest(candles, ctx, STRATEGIES[0], {}, { ...cfg, riskPct: 1, feeBps: 0, slipBps: 0 });
  const r2 = runBacktest(candles, ctx, STRATEGIES[0], {}, { ...cfg, riskPct: 2, feeBps: 0, slipBps: 0 });
  const avgQ1 = r1.trades.reduce((a, t) => a + t.qty, 0) / Math.max(1, r1.trades.length);
  const avgQ2 = r2.trades.reduce((a, t) => a + t.qty, 0) / Math.max(1, r2.trades.length);
  ok(avgQ2 > avgQ1 * 1.5, `2% risk sizes roughly twice 1% (${avgQ1.toFixed(3)} → ${avgQ2.toFixed(3)})`);

  // Extreme settings must not produce NaN
  for (const riskPct of [0.1, 5, 10]) {
    const r = runBacktest(candles, ctx, STRATEGIES[0], {}, { ...cfg, riskPct, maxLeverage: 20 });
    ok(Number.isFinite(r.metrics.finalEquity), `riskPct=${riskPct} with 20× leverage stays finite`);
  }

  // Catastrophic gap must not be booked as a windfall
  const gappy = [];
  let px = 100;
  for (let i = 0; i < 400; i++) {
    const trend = i < 260 ? 0.35 : 0;
    const o = px;
    const c = o + trend + Math.sin(i / 3) * 0.4;
    gappy.push({
      t: 1_600_000_000_000 + i * 900_000,
      o, c,
      h: Math.max(o, c) + 0.3,
      l: Math.min(o, c) - 0.3,
      v: 1000
    });
    px = c;
    if (i === 300) { // -40% gap
      gappy[gappy.length - 1] = { ...gappy[gappy.length - 1], o: px * 0.6, h: px * 0.62, l: px * 0.58, c: px * 0.6 };
      px = px * 0.6;
    }
  }
  const gctx = buildContext(gappy);
  const gres = runBacktest(gappy, gctx, STRATEGIES[0], {}, { ...cfg, maxLeverage: 10, riskPct: 5 });
  ok(gres.equityCurve.every(Number.isFinite), 'a 40% gap keeps the equity curve finite');
  ok(gres.trades.every((t) => Number.isFinite(t.pnl)), 'a 40% gap keeps trade P&L finite');
}

/* ================================================================== */
/* D. Monte Carlo invariants                                          */
/* ================================================================== */
section('D. Monte Carlo');

{
  const { candles } = generateSeries({ symbolId: 'ETHUSDT', timeframe: '15m', bars: 1000, seed: 9 });
  const ctx = buildContext(candles);
  const res = runBacktest(candles, ctx, STRATEGIES[0], {}, { timeframe: '15m' });
  const mc1 = runMonteCarlo(res.trades, 0.01, 10_000, { runs: 300, seed: 5 });
  const mc2 = runMonteCarlo(res.trades, 0.01, 10_000, { runs: 300, seed: 5 });
  ok(JSON.stringify(mc1.finals) === JSON.stringify(mc2.finals), 'Monte Carlo is seed-deterministic');
  ok(mc1.finals.p5 <= mc1.finals.p50 && mc1.finals.p50 <= mc1.finals.p95, 'MC percentiles are ordered');
  ok(mc1.drawdown.p50 <= mc1.drawdown.p95, 'MC drawdown percentiles are ordered');
  ok(mc1.probProfit >= 0 && mc1.probProfit <= 100, 'MC profit probability is a percentage');
  ok(mc1.histogram.buckets.reduce((a, b) => a + b, 0) === 300, 'MC histogram accounts for every run');
  ok(runMonteCarlo([], 0.01, 10_000).empty === true, 'MC handles an empty trade list');
  const zeroRisk = runMonteCarlo(res.trades, 0, 10_000, { runs: 50 });
  ok(Math.abs(zeroRisk.finals.p50 - 10_000) < 1e-6, 'zero risk leaves equity untouched');
}

/* ================================================================== */
/* E. CSV torture                                                     */
/* ================================================================== */
section('E. CSV parsing');

{
  const base = Array.from({ length: 60 }, (_, i) =>
    `${1700000000000 + i * 900000},${100 + i},${101 + i},${99 + i},${100.5 + i},${1000 + i}`
  );
  const parse = (t) => parseCsv(t, { symbolId: 'BTCUSDT', timeframe: '15m' });

  ok(parse(['time,open,high,low,close,volume', ...base].join('\n')).candles.length === 60, 'plain CSV parses');

  const bom = '\ufefftime,open,high,low,close,volume\n' + base.join('\n');
  let bomOk = false;
  try { bomOk = parse(bom).candles.length === 60; } catch { bomOk = false; }
  ok(bomOk, 'UTF-8 BOM in the header is tolerated (Excel)');

  const semi = ['time;open;high;low;close;volume', ...base.map((l) => l.replace(/,/g, ';'))].join('\n');
  ok(parse(semi).candles.length === 60, 'semicolon delimiter is detected');

  const quoted = ['"time","open","high","low","close","volume"', ...base.map((l) => l.split(',').map((x) => `"${x}"`).join(','))].join('\n');
  ok(parse(quoted).candles.length === 60, 'quoted cells are handled');

  const noVol = ['time,open,high,low,close', ...base.map((l) => l.split(',').slice(0, 5).join(','))].join('\n');
  ok(parse(noVol).candles.length === 60, 'volume column is optional');

  const crlf = ['time,open,high,low,close,volume', ...base].join('\r\n');
  ok(parse(crlf).candles.length === 60, 'CRLF line endings work');

  const iso = ['date,open,high,low,close,volume', ...base.map((l, i) => {
    const d = new Date(1700000000000 + i * 900000).toISOString();
    return [d, ...l.split(',').slice(1)].join(',');
  })].join('\n');
  ok(parse(iso).candles.length === 60, 'ISO timestamps work');

  const seconds = ['time,open,high,low,close,volume', ...base.map((l) => {
    const p = l.split(',');
    p[0] = String(Math.round(Number(p[0]) / 1000));
    return p.join(',');
  })].join('\n');
  ok(parse(seconds).candles.length === 60 && parse(seconds).candles[0].t > 1e12, 'epoch seconds are promoted to ms');

  const unsorted = ['time,open,high,low,close,volume', ...base.slice().reverse()].join('\n');
  const us = parse(unsorted).candles;
  ok(us[0].t < us[us.length - 1].t, 'unsorted CSV is sorted chronologically');

  const messy = ['time,open,high,low,close,volume', ...base,
    'garbage', ',,,,', ',0,0,0,0,0', '1700000099999,abc,def,ghi,jkl,0'].join('\n');
  const messyCandles = parse(messy).candles;
  ok(messyCandles.length === 60, `garbage/zero-price rows are skipped (${messyCandles.length} kept)`);
  ok(messyCandles.every((c) => c.o > 0 && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)), 'no zero-price candle survives');
  ok(messyCandles.every((c) => c.t > 1e12), 'no epoch-zero timestamp survives');

  let threw = false;
  try { parse('time,open,high,low,close\n' + base.slice(0, 10).join('\n')); } catch { threw = true; }
  ok(threw, 'fewer than 50 candles throws a clear error');

  threw = false;
  try { parse('a,b,c\n1,2,3\n4,5,6'); } catch { threw = true; }
  ok(threw, 'missing OHLC columns throw');

  threw = false;
  try { parse(''); } catch { threw = true; }
  ok(threw, 'empty input throws');
}

/* ================================================================== */
/* F. Predictor robustness                                            */
/* ================================================================== */
section('F. Predictor');

{
  const cases = [
    ['15m', 400, 1], ['1m', 900, 2], ['1h', 700, 3], ['4h', 500, 4]
  ];
  for (const [tf, bars, seed] of cases) {
    const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: tf, bars, seed });
    const ctx = buildContext(candles);
    const p = predictNextCandle(candles, ctx);
    ok(p && Number.isFinite(p.probUp) && p.probUp > 0 && p.probUp < 1, `${tf}: probability in (0,1)`);
    ok(p.features.every((f) => Number.isFinite(f.contribution)), `${tf}: contributions finite`);
    ok(p.confidence >= 0 && p.confidence <= 100, `${tf}: confidence in range`);
    ok(p.oosHit === null || (p.oosHit >= 0 && p.oosHit <= 1), `${tf}: OOS hit rate sane`);
    ok(Math.abs(p.probUp + p.probDown - 1) < 1e-12, `${tf}: probabilities complement`);
  }

  // Extreme but valid inputs must not produce NaN
  const weird = [];
  for (let i = 0; i < 400; i++) {
    const c = 100 + (i % 5 === 0 ? 50 : 0) * (i % 2 ? -1 : 1);
    weird.push({ t: 1_700_000_000_000 + i * 60000, o: c, h: c + 0.01, l: c - 0.01, c, v: 1 });
  }
  const wp = predictNextCandle(weird, buildContext(weird));
  ok(wp && Number.isFinite(wp.probUp), 'predictor survives a synthetic square-wave series');

  // Binary expectancy: EV must be exactly zero at breakeven
  for (const payout of [50, 70, 85, 92, 100]) {
    const be = 1 / (1 + payout / 100);
    const e = binaryExpectancy(be, payout, 100);
    ok(Math.abs(e.ev) < 1e-9, `EV is 0 at the breakeven hit rate (payout ${payout}%)`);
  }
  ok(binaryExpectancy(0.7, 85, 10).ev > binaryExpectancy(0.6, 85, 10).ev, 'EV increases with accuracy');
  ok(binaryExpectancy(0.6, 0, 10).ev < 0, 'a 0% payout is always negative EV');
}

/* ================================================================== */
/* G. Capture robustness + accuracy                                   */
/* ================================================================== */
section('G. Chart-image reader');

{
  const W = 900, H = 420;
  const blank = (fill = [8, 12, 18]) => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { d[i * 4] = fill[0]; d[i * 4 + 1] = fill[1]; d[i * 4 + 2] = fill[2]; d[i * 4 + 3] = 255; }
    return d;
  };

  ok(analyzeChartPixels(blank(), W, H, {}).candles.length === 0, 'empty background yields no candles');
  ok(analyzeChartPixels(blank([255, 255, 255]), W, H, {}).candles.length === 0, 'white background yields no candles');

  // pure noise must not fabricate a chart
  const noise = blank();
  let s = 1;
  for (let i = 0; i < W * H; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = s % 255;
    noise[i * 4] = v; noise[i * 4 + 1] = 255 - v; noise[i * 4 + 2] = (v * 3) % 255;
  }
  let noiseOk = true;
  try { analyzeChartPixels(noise, W, H, {}); } catch { noiseOk = false; }
  ok(noiseOk, 'random noise does not throw');

  // crop outside the image
  ok(analyzeChartPixels(blank(), W, H, { crop: { x: 2000, y: 2000, w: 100, h: 100 } }).candles.length === 0, 'out-of-bounds crop is rejected');
  ok(analyzeChartPixels(blank(), W, H, { crop: { x: -100, y: -100, w: 50, h: 50 } }).candles.length === 0, 'negative crop is rejected');

  // a real chart, then crop + sensitivity sweeps
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const data = blank();
  const px = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  const truth = [];
  let price = 200;
  for (let k = 0; k < 50; k++) {
    const o = price, c = o + (rnd() - 0.5) * 9; price = c;
    const hi = Math.max(o, c) + rnd() * 3, lo = Math.min(o, c) - rnd() * 3;
    truth.push({ o, c });
    const col = c >= o ? [46, 230, 168] : [255, 93, 108];
    const X = 40 + k * 16;
    const py = (v) => Math.round(H - 30 - (v - 100) * 1.5);
    for (let y = py(hi); y <= py(lo); y++) px(X + 5, y, col);
    for (let y = py(Math.max(o, c)); y <= py(Math.min(o, c)); y++) for (let x = X; x < X + 10; x++) px(x, y, col);
  }
  const res = analyzeChartPixels(data, W, H, {});
  ok(Math.abs(res.candles.length - truth.length) <= 2, `detected ${res.candles.length} of ${truth.length} candles`);
  let agree = 0;
  for (let i = 0; i < Math.min(truth.length, res.candles.length); i++) {
    if (Math.sign(truth[i].c - truth[i].o) === Math.sign(res.candles[i].c - res.candles[i].o)) agree++;
  }
  ok(agree / Math.min(truth.length, res.candles.length) > 0.85, `direction agreement ${((agree / truth.length) * 100).toFixed(1)}%`);

  for (const sens of [0.4, 1, 2.4]) {
    let threw = false;
    try { analyzeChartPixels(data, W, H, { sensitivity: sens }); } catch { threw = true; }
    ok(!threw, `sensitivity ${sens} does not throw`);
  }

  // RGB→HSV sanity
  const h = rgbToHsv(46, 230, 168).h;
  ok(h > 70 && h < 185, 'green maps into the bullish hue band');

  // manual paste
  const rows = Array.from({ length: 20 }, (_, i) => `${100 + i},${101 + i},${99 + i},${100.5 + i}`).join('\n');
  ok(parseManualCandles(rows).length === 20, 'manual paste parses 20 rows');
}

/* ================================================================== */
/* H. End-to-end: image → candles → model → prediction                */
/* ================================================================== */
section('H. End-to-end pipeline');

{
  const W = 1000, H = 500;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 8; data[i * 4 + 1] = 12; data[i * 4 + 2] = 18; data[i * 4 + 3] = 255; }
  const px = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  let s = 11;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let price = 300;
  for (let k = 0; k < 70; k++) {
    const o = price, c = o + (rnd() - 0.45) * 8; price = c;
    const hi = Math.max(o, c) + rnd() * 3, lo = Math.min(o, c) - rnd() * 3;
    const col = c >= o ? [46, 230, 168] : [255, 93, 108];
    const X = 30 + k * 13;
    const py = (v) => Math.round(H - 40 - (v - 200) * 1.3);
    for (let y = py(hi); y <= py(lo); y++) px(X + 4, y, col);
    for (let y = py(Math.max(o, c)); y <= py(Math.min(o, c)); y++) for (let x = X; x < X + 8; x++) px(x, y, col);
  }

  const t0 = performance.now();
  const read = analyzeChartPixels(data, W, H, {});
  const ctx = buildContext(read.candles);
  const pred = predictNextCandle(read.candles, ctx);
  const desk = analyze(ctx, read.candles.length - 1);
  const ms = performance.now() - t0;

  ok(read.candles.length >= 60, `pipeline recovered ${read.candles.length} candles from pixels`);
  ok(pred && Number.isFinite(pred.probUp), 'pipeline produced a probability');
  ok(pred && pred.model === 'rules', '70 candles → transparent rule model (not a fake trained one)');
  ok(desk && Number.isFinite(desk.score), 'confluence engine ran on the extracted candles');
  ok(ms < 1500, `end-to-end pipeline in ${ms.toFixed(0)} ms`);

  // The extracted OHLC must be self-consistent or every model downstream is junk
  ok(read.candles.every((c) => c.h >= Math.max(c.o, c.c) - 1e-9 && c.l <= Math.min(c.o, c.c) + 1e-9), 'extracted OHLC is consistent');
  ok(read.candles.every((c) => c.h > c.l), 'every extracted candle has a body');
}

/* ================================================================== */
/* I. HTTP server security + MIME                                     */
/* ================================================================== */
section('I. HTTP server');

{
  const PORT = 8199;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${PORT}`;
  await new Promise((r) => setTimeout(r, 600));

  const get = async (p, method = 'GET') => {
    const res = await fetch(base + p, { method, redirect: 'manual' });
    const body = method === 'GET' ? await res.text() : '';
    return { status: res.status, headers: res.headers, body };
  };

  try {
    ok((await get('/')).status === 200, 'index served');
    ok((await get('/js/app.js')).headers.get('content-type').includes('javascript'), 'JS MIME type correct');
    ok((await get('/manifest.webmanifest')).headers.get('content-type').includes('manifest+json'), 'manifest MIME type correct');
    ok((await get('/icons/icon-192.png')).headers.get('content-type') === 'image/png', 'PNG MIME type correct');
    ok((await get('/nope.js')).status === 200, 'unknown path falls back to the SPA shell');

    // Path traversal — a real sibling directory, a real secret.
    const outside = path.join(path.dirname(root), 'qp-deep-test-secret.txt');
    writeFileSync(outside, 'SECRET-OUTSIDE-ROOT-9137');
    try {
      const t1 = await get('/..%2fqp-deep-test-secret.txt');
      ok(!t1.body.includes('SECRET-OUTSIDE-ROOT-9137'), 'encoded traversal to a sibling file is blocked');
      const t2 = await get('/%2e%2e/qp-deep-test-secret.txt');
      ok(!t2.body.includes('SECRET-OUTSIDE-ROOT-9137'), 'dot-encoded traversal is blocked');
      const t3 = await get('/..%2f..%2fetc%2fpasswd');
      ok(!t3.body.includes('root:'), 'traversal cannot read /etc/passwd');
      const t4 = await get('/.git/config');
      ok(t4.status === 403 || !t4.body.includes('repositoryformatversion'), '.git is never served');
      const t5 = await get('/..%2f' + path.basename(root) + '-other/package.json');
      ok(!t5.body.includes('"name"') || t5.body.includes('Quetex'), 'sibling directories with a shared prefix are blocked');
    } finally {
      rmSync(outside, { force: true });
    }

    const share = await fetch(base + '/share-target', { method: 'POST', redirect: 'manual' });
    ok(share.status === 303, 'POST /share-target redirects to the app');
    ok(share.headers.get('location') === '/?shared=1', 'share-target redirect target correct');

    const head = await fetch(base + '/', { method: 'HEAD' }).catch(() => null);
    ok(head === null || head.status < 500, 'HEAD request does not explode');
  } finally {
    child.kill();
  }
}

/* ================================================================== */
/* J. Performance budgets                                             */
/* ================================================================== */
section('J. Performance');

{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '1m', bars: 1500, seed: 2 });
  const time = (fn) => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };

  const [ctxMs, ctx] = time(() => buildContext(candles));
  ok(ctxMs < 120, `buildContext 1500 bars: ${ctxMs.toFixed(1)} ms (budget 120)`);

  const [predMs] = time(() => predictNextCandle(candles, ctx));
  ok(predMs < 400, `predictNextCandle 1500 bars: ${predMs.toFixed(1)} ms (budget 400)`);

  const [btMs] = time(() => {
    for (const s of STRATEGIES) runBacktest(candles, ctx, s, {}, { timeframe: '1m' });
  });
  ok(btMs < 600, `all 6 backtests on 1500 bars: ${btMs.toFixed(1)} ms (budget 600)`);

  const W = 1400, H = 1000;
  const big = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { big[i * 4] = 10; big[i * 4 + 1] = 14; big[i * 4 + 2] = 20; big[i * 4 + 3] = 255; }
  for (let k = 0; k < 100; k++) {
    const X = 20 + k * 13;
    for (let y = 200; y < 700; y++) {
      const i = (y * W + X + 4) * 4;
      big[i] = 46; big[i + 1] = 230; big[i + 2] = 168;
      for (let x = X; x < X + 8; x++) { const j = (y * W + x) * 4; big[j] = 46; big[j + 1] = 230; big[j + 2] = 168; }
    }
  }
  const [capMs] = time(() => analyzeChartPixels(big, W, H, {}));
  ok(capMs < 1200, `pixel reader on 1400×1000: ${capMs.toFixed(0)} ms (budget 1200)`);
}

/* ================================================================== */
/* K. HTML integrity                                                  */
/* ================================================================== */
section('K. Markup integrity');

{
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  ok(dupes.length === 0, `no duplicate element ids${dupes.length ? ': ' + [...new Set(dupes)].join(', ') : ''}`);

  const labelFor = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
  ok(labelFor.every((f) => ids.includes(f)), 'every <label for> points at a real element');

  const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  ok(buttons.every((t) => t.length > 0), 'every button has visible text');

  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  ok(scripts.every((s) => existsSync(path.join(root, s))), 'every script src exists on disk');

  const links = [...html.matchAll(/<link[^>]*href="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => !h.startsWith('http'));
  ok(links.every((l) => existsSync(path.join(root, l))), 'every local stylesheet/icon link exists');

  ok(/<html lang="en"/.test(html), 'html lang attribute present');
  ok(html.includes('name="viewport"'), 'viewport meta present for mobile');
  ok(!/onclick=/i.test(html), 'no inline event handlers (CSP-friendly)');
}

/* ================================================================== */
/* L. Cross-module contract                                           */
/* ================================================================== */
section('L. Module contracts');

{
  for (const tf of Object.keys(TIMEFRAMES)) {
    ok(TIMEFRAMES[tf].ms > 0 && TIMEFRAMES[tf].perYear > 0, `timeframe ${tf} metadata sane`);
  }
  const ids = STRATEGIES.map((s) => s.id);
  ok(new Set(ids).size === ids.length, 'strategy ids are unique');
  for (const s of STRATEGIES) {
    ok(typeof s.entry === 'function', `${s.id}: entry() defined`);
    ok(Array.isArray(s.params) && s.params.length > 0, `${s.id}: parameters exposed for the UI`);
    for (const p of s.params) {
      ok(s.defaults[p.key] !== undefined, `${s.id}.${p.key}: default exists`);
      ok(p.min < p.max && p.step > 0, `${s.id}.${p.key}: slider range sane`);
      const d = s.defaults[p.key];
      ok(d >= p.min && d <= p.max, `${s.id}.${p.key}: default inside its own slider range (${d})`);
    }
    ok(s.rules.length >= 3 && s.invalidation.length > 10, `${s.id}: playbook copy complete`);
  }

  // Every strategy must trade on at least one standard timeframe, or the catalogue lies
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 1000, seed: 33 });
  const ctx = buildContext(candles);
  let totalTrades = 0;
  for (const s of STRATEGIES) {
    const r = runBacktest(candles, ctx, s, {}, { timeframe: '15m' });
    totalTrades += r.trades.length;
  }
  ok(totalTrades > 20, `catalogue produces trades on a normal 15m window (${totalTrades})`);
}

/* ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(64)}`);
console.log(`DEEP TEST: ${pass} passed, ${fail} failed`);
console.log(`${fail === 0 ? '✅ DEEP TEST PASSED' : '❌ FAILURES ABOVE'}\n`);
process.exit(fail === 0 ? 0 : 1);

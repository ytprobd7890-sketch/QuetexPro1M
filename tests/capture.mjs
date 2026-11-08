/**
 * Chart-image reader tests.
 * Renders a synthetic candlestick screenshot into a pixel buffer and checks
 * that the reader recovers the right number of candles and their geometry.
 */

import { analyzeChartPixels, parseManualCandles, rgbToHsv } from '../js/capture.js';

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.log('  ✗ ' + l); } else console.log('  ✓ ' + l); };

function makeChart({ W = 900, H = 420, n = 60, pitch = 12, body = 7, x0 = 30, grid = true, seed = 7 }) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 8; data[i * 4 + 1] = 12; data[i * 4 + 2] = 18; data[i * 4 + 3] = 255;
  }
  const px = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };

  if (grid) {
    for (let y = 40; y < H; y += 80) for (let x = 0; x < W; x++) px(x, y, 40, 52, 64);
    for (let x = 70; x < W; x += 140) for (let y = 0; y < H; y++) px(x, y, 40, 52, 64);
  }

  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const truth = [];
  let price = 200;
  const py = (v) => Math.round(H - 30 - (v - 100) * 1.6);

  for (let k = 0; k < n; k++) {
    const o = price;
    const c = o + (rnd() - 0.5) * 10;
    price = c;
    const hi = Math.max(o, c) + rnd() * 4;
    const lo = Math.min(o, c) - rnd() * 4;
    truth.push({ o, h: hi, l: lo, c });

    const up = c >= o;
    const col = up ? [46, 230, 168] : [255, 93, 108];
    const X = x0 + k * pitch;
    for (let y = py(hi); y <= py(lo); y++) px(X + Math.floor(body / 2), y, ...col);
    const top = py(Math.max(o, c));
    const bot = py(Math.min(o, c));
    for (let y = top; y <= bot; y++) for (let x = X; x < X + body; x++) px(x, y, ...col);
  }
  return { data, W, H, truth };
}

console.log('\n=== 1. HSV helper ===');
{
  const green = rgbToHsv(46, 230, 168);
  const red = rgbToHsv(255, 93, 108);
  ok(green.h > 70 && green.h < 185, `green hue ${green.h.toFixed(0)}`);
  ok(red.h > 300 || red.h < 22, `red hue ${red.h.toFixed(0)}`);
}

console.log('\n=== 2. Extraction accuracy ===');
{
  const { data, W, H, truth } = makeChart({});
  const res = analyzeChartPixels(data, W, H, {});
  ok(res.meta.detected >= truth.length - 2, `detected ${res.meta.detected}/${truth.length} candles`);

  let agree = 0;
  const n = Math.min(truth.length, res.candles.length);
  for (let k = 0; k < n; k++) {
    if (Math.sign(truth[k].c - truth[k].o) === Math.sign(res.candles[k].c - res.candles[k].o)) agree++;
  }
  ok(agree / n >= 0.9, `direction agreement ${((agree / n) * 100).toFixed(1)}%`);

  const th = truth.slice(0, n).map((t) => Math.abs(t.c - t.o));
  const eh = res.candles.slice(0, n).map((c) => Math.abs(c.c - c.o));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ma = mean(th), mb = mean(eh);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (th[i] - ma) * (eh[i] - mb); da += (th[i] - ma) ** 2; db += (eh[i] - mb) ** 2; }
  const corr = num / Math.sqrt(da * db);
  ok(corr > 0.9, `body size correlation ${corr.toFixed(3)}`);

  ok(res.candles.every((c) => c.h >= Math.max(c.o, c.c) - 1e-9 && c.l <= Math.min(c.o, c.c) + 1e-9), 'OHLC always consistent');
  ok(res.marks.length === res.candles.length, 'overlay marks for every candle');
}

console.log('\n=== 3. Narrow gaps + touching bodies ===');
{
  const a = makeChart({ pitch: 10, body: 8, seed: 21 });
  const ra = analyzeChartPixels(a.data, a.W, a.H, {});
  ok(ra.meta.detected >= a.truth.length - 3, `2px gaps: detected ${ra.meta.detected}/${a.truth.length}`);

  // Fully touching candles cannot be segmented from pixels — must fail loudly,
  // not fabricate 200 candles.
  const b = makeChart({ pitch: 8, body: 8, seed: 21 });
  const rb = analyzeChartPixels(b.data, b.W, b.H, {});
  ok(rb.candles.length === 0 && /merged|zoom/.test(rb.meta.reason), `touching bodies rejected honestly: "${rb.meta.reason}"`);
}

console.log('\n=== 4. Crop + sensitivity ===');
{
  const { data, W, H, truth } = makeChart({});
  const res = analyzeChartPixels(data, W, H, { crop: { x: 25, y: 20, w: W - 50, h: H - 60 } });
  ok(res.meta.detected >= truth.length - 2, `crop keeps ${res.meta.detected} candles`);
  const noisy = analyzeChartPixels(data, W, H, { sensitivity: 0.4 });
  ok(noisy.meta.detected > 5, 'low sensitivity still finds candles');
}

console.log('\n=== 5. Failure modes ===');
{
  const W = 300, H = 200;
  const blank = new Uint8ClampedArray(W * H * 4).fill(0);
  const res = analyzeChartPixels(blank, W, H, {});
  ok(res.candles.length === 0 && res.meta.reason, `blank image rejected: ${res.meta.reason}`);
  const tiny = analyzeChartPixels(blank, W, H, { crop: { x: 0, y: 0, w: 5, h: 5 } });
  ok(tiny.candles.length === 0, 'tiny crop rejected');
}

console.log('\n=== 6. Manual paste ===');
{
  const text = Array.from({ length: 12 }, (_, i) =>
    `${100 + i},${101 + i},${99 + i},${100.5 + i},${1000 + i}`
  ).join('\n');
  const candles = parseManualCandles(text);
  ok(candles.length === 12, 'parsed 12 pasted candles');
  ok(candles[0].h === 101 && candles[0].l === 99, 'high/low corrected');
  let threw = false;
  try { parseManualCandles('1,2,3,4'); } catch { threw = true; }
  ok(threw, 'too few rows throws');
}

console.log(`\n${fails === 0 ? '✅ CAPTURE PASSED' : `❌ ${fails} CAPTURE CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);

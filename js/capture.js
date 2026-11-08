/**
 * Quetex Pro 1M — chart-image candle reader
 *
 * Turns a screenshot (mobile) or a captured tab frame (desktop) into OHLC data.
 * Pure pixel work: no OCR, no network, nothing leaves the device.
 *
 * Method
 *   1. classify every pixel as bullish / bearish by hue (gridlines, text and
 *      background are low-saturation and drop out)
 *   2. build a per-column occupancy profile
 *   3. split the profile into candle runs (gaps first, merged runs by pitch)
 *   4. per candle: wick extent = highest/lowest coloured pixel,
 *      body extent = rows where the horizontal run is wide (the wick is 1–2px)
 *   5. y → price with a linear flip; absolute scale is irrelevant because every
 *      model feature is normalised by ATR
 */

export function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/** 0 = none, 1 = bullish, 2 = bearish */
function classify(r, g, b, satMin) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx < 45) return 0;              // near-black background
  if (mx - mn < 26) return 0;         // grey: grid, text, white/black bodies
  const { h, s, v } = rgbToHsv(r, g, b);
  if (s < satMin || v < 0.16) return 0;
  if (h >= 70 && h <= 185) return 1;  // green / teal / mint
  if (h >= 300 || h <= 22) return 2;  // red / pink / crimson
  return 0;
}

/**
 * @param {Uint8ClampedArray} data RGBA pixels
 * @param {number} width
 * @param {number} height
 * @param {object} opts { crop:{x,y,w,h}, sensitivity:0.4..2.5, maxCandles }
 */
export function analyzeChartPixels(data, width, height, opts = {}) {
  const crop = opts.crop || { x: 0, y: 0, w: width, h: height };
  const sensitivity = opts.sensitivity ?? 1;
  const satMin = Math.min(0.85, 0.16 / Math.max(0.4, sensitivity));
  const maxCandles = opts.maxCandles ?? 400;

  const x0 = Math.max(0, Math.floor(crop.x));
  const y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(width, Math.ceil(crop.x + crop.w));
  const y1 = Math.min(height, Math.ceil(crop.y + crop.h));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 20 || h < 20) return empty('crop too small');

  // --- pass 1: classify pixels, build column profiles -------------------
  const cls = new Uint8Array(w * h);
  const count = new Int32Array(w);
  const upC = new Int32Array(w);
  const dnC = new Int32Array(w);
  const topY = new Float64Array(w).fill(Infinity);
  const botY = new Float64Array(w).fill(-Infinity);

  for (let y = y0; y < y1; y++) {
    const rowOff = y * width * 4;
    const localRow = (y - y0) * w;
    for (let x = x0; x < x1; x++) {
      const i = rowOff + x * 4;
      if (data[i + 3] < 40) continue;
      const k = classify(data[i], data[i + 1], data[i + 2], satMin);
      if (!k) continue;
      const cx = x - x0;
      cls[localRow + cx] = k;
      count[cx]++;
      if (k === 1) upC[cx]++; else dnC[cx]++;
      if (y < topY[cx]) topY[cx] = y;
      if (y > botY[cx]) botY[cx] = y;
    }
  }

  // --- pass 2: segment into runs ---------------------------------------
  const runs = [];
  let i = 0;
  while (i < w) {
    if (count[i] < 1) { i++; continue; }
    let j = i;
    while (j + 1 < w && count[j + 1] >= 1) j++;
    runs.push([i, j]);
    i = j + 1;
  }
  if (!runs.length) return empty('no coloured candles found');

  // Pitch comes from single-candle runs. If every run is wide, the candles are
  // touching and the pixel reader cannot segment them reliably — say so instead
  // of inventing a grid.
  const widths = runs.map(([a, b]) => b - a + 1).sort((a, b) => a - b);
  const singles = widths.filter((x) => x <= 40);
  if (singles.length < 5) {
    return empty('candles look merged — zoom the chart in so there is a gap between them, or paste the candles manually');
  }
  const medianW = singles[Math.floor(singles.length / 2)] || 1;
  const pitch = Math.max(2, Math.round(medianW * 1.06));

  const segments = [];
  for (const [a, b] of runs) {
    const width = b - a + 1;
    if (width <= pitch * 1.7) { segments.push([a, b]); continue; }
    const parts = Math.max(1, Math.min(Math.round(width / pitch), maxCandles));
    const step = width / parts;
    for (let k = 0; k < parts; k++) {
      const sa = Math.round(a + k * step);
      const sb = Math.min(b, Math.round(a + (k + 1) * step) - 1);
      if (sb >= sa) segments.push([sa, sb]);
    }
  }

  // --- pass 3: build candles -------------------------------------------
  const candles = [];
  const marks = [];

  for (const [a, b] of segments) {
    let up = 0, dn = 0;
    for (let x = a; x <= b; x++) { up += upC[x]; dn += dnC[x]; }
    if (up + dn < 3) continue;
    const dir = up >= dn ? 1 : 2;

    const rowCount = new Int32Array(h);
    let hiY = Infinity, loY = -Infinity;

    for (let x = a; x <= b; x++) {
      if (!Number.isFinite(topY[x]) || !Number.isFinite(botY[x])) continue;
      for (let y = topY[x]; y <= botY[x]; y++) {
        if (cls[(y - y0) * w + x] !== dir) continue;
        if (y < hiY) hiY = y;
        if (y > loY) loY = y;
        rowCount[y - y0]++;
      }
    }
    if (!Number.isFinite(hiY) || loY < 0) continue;

    let rowMax = 0;
    for (let y = 0; y < h; y++) if (rowCount[y] > rowMax) rowMax = rowCount[y];
    if (!rowMax) continue;

    const bodyMin = Math.max(2, Math.ceil(rowMax * 0.62));
    let bTop = -1, bBot = -1;
    for (let y = 0; y < h; y++) {
      if (rowCount[y] >= bodyMin) { if (bTop < 0) bTop = y; bBot = y; }
    }
    if (bTop < 0) {
      for (let y = 0; y < h; y++) if (rowCount[y] === rowMax) { bTop = bBot = y; break; }
    }
    if (bTop < 0) continue;

    const priceOf = (yAbs) => y1 - yAbs; // linear flip; unit scale is arbitrary
    const high = priceOf(hiY);
    const low = priceOf(loY);
    const bTopP = priceOf(y0 + bTop);
    const bBotP = priceOf(y0 + bBot);

    let o, c;
    if (dir === 1) { o = Math.min(bBotP, bTopP); c = Math.max(bBotP, bTopP); }
    else { o = Math.max(bBotP, bTopP); c = Math.min(bBotP, bTopP); }
    o = Math.min(high, Math.max(low, o));
    c = Math.min(high, Math.max(low, c));

    candles.push({ t: 0, o, h: high, l: low, c, v: Math.max(0.0001, high - low) });
    marks.push({
      x0: a + x0, x1: b + x0,
      highY: hiY, lowY: loY,
      bodyTopY: y0 + bTop, bodyBotY: y0 + bBot,
      dir
    });

    if (candles.length >= maxCandles) break;
  }

  if (candles.length < 8) return empty('too few candles detected — crop tighter on the candles');

  const now = Date.now();
  const n = candles.length;
  candles.forEach((cd, k) => { cd.t = now - (n - 1 - k) * 60_000; });

  return {
    candles,
    marks,
    meta: {
      pitch,
      columns: w,
      runs: runs.length,
      detected: candles.length,
      bullish: candles.filter((c) => c.c >= c.o).length,
      crop: { x: x0, y: y0, w, h },
      method: segments.length > runs.length ? 'split-merged' : 'gap'
    }
  };
}

function empty(reason) {
  return { candles: [], marks: [], meta: { detected: 0, reason } };
}

/** Read a canvas (already drawn at display size) into candles. */
export function analyzeCanvas(canvas, opts = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return analyzeChartPixels(img.data, canvas.width, canvas.height, opts);
}

/** Parse pasted `open,high,low,close[,volume]` rows, oldest first. */
export function parseManualCandles(text) {
  const rows = (text || '').trim().split(/\r?\n/).filter((l) => l.trim());
  const candles = [];
  for (const line of rows) {
    const parts = line.split(/[,\s;|]+/).map(Number).filter((v) => Number.isFinite(v));
    if (parts.length < 4) continue;
    const [o, h, l, c, v] = parts;
    candles.push({
      t: 0,
      o,
      h: Math.max(o, h, l, c),
      l: Math.min(o, h, l, c),
      c,
      v: Number.isFinite(v) && v > 0 ? v : Math.max(0.0001, Math.abs(h - l))
    });
  }
  if (candles.length < 8) throw new Error('Need at least 8 candles (open,high,low,close per line)');
  const now = Date.now();
  candles.forEach((cd, k) => { cd.t = now - (candles.length - 1 - k) * 60_000; });
  return candles;
}

/**
 * Quetex Pro 1M — indicator engine
 * All functions return arrays aligned to the input length.
 * Bars that cannot be computed are NaN (never silently zero), so
 * strategies can use Number.isFinite() as a warm-up guard.
 */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Simple moving average. */
export function sma(src, period) {
  const out = new Array(src.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded from the first SMA window. */
export function ema(src, period) {
  const out = new Array(src.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  const seed = [];
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) { out[i] = prev; continue; }
    if (!Number.isFinite(prev)) {
      seed.push(v);
      if (seed.length === period) {
        prev = seed.reduce((a, b) => a + b, 0) / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI from average gain/loss. No movement at all = neutral 50, not overbought 100. */
function rsiFrom(gain, loss) {
  if (gain + loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder's RSI. */
export function rsi(src, period = 14) {
  const out = new Array(src.length).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    const up = Math.max(d, 0);
    const dn = Math.max(-d, 0);
    if (i <= period) {
      gain += up; loss += dn;
      if (i === period) {
        gain /= period; loss /= period;
        out[i] = rsiFrom(gain, loss);
      }
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + dn) / period;
      out[i] = rsiFrom(gain, loss);
    }
  }
  return out;
}

/** True range series. */
export function trueRange(candles) {
  const out = new Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) { out[i] = c.h - c.l; continue; }
    const p = candles[i - 1].c;
    out[i] = Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p));
  }
  return out;
}

/** Wilder's ATR — the volatility unit used for every risk decision. */
export function atr(candles, period = 14) {
  const tr = trueRange(candles);
  const out = new Array(tr.length).fill(NaN);
  let prev = NaN;
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period) {
      sum += tr[i];
      if (i === period - 1) { prev = sum / period; out[i] = prev; }
      continue;
    }
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** MACD line / signal / histogram. */
export function macd(src, fast = 12, slow = 26, signalPeriod = 9) {
  const fastE = ema(src, fast);
  const slowE = ema(src, slow);
  const line = src.map((_, i) =>
    Number.isFinite(fastE[i]) && Number.isFinite(slowE[i]) ? fastE[i] - slowE[i] : NaN
  );
  const sig = ema(line, signalPeriod);
  const hist = line.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(sig[i]) ? v - sig[i] : NaN
  );
  return { line, signal: sig, hist };
}

/** Bollinger bands (population standard deviation). */
export function bollinger(src, period = 20, mult = 2) {
  const mid = sma(src, period);
  const upper = new Array(src.length).fill(NaN);
  const lower = new Array(src.length).fill(NaN);
  const width = new Array(src.length).fill(NaN);
  for (let i = period - 1; i < src.length; i++) {
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (src[j] - mid[i]) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] ? ((upper[i] - lower[i]) / mid[i]) * 100 : NaN;
  }
  return { mid, upper, lower, width };
}

/**
 * Donchian channel of the *prior* `period` bars (excludes the current bar),
 * so `close > upper[i]` is a genuine breakout with no look-ahead.
 */
export function donchian(candles, period = 20) {
  const upper = new Array(candles.length).fill(NaN);
  const lower = new Array(candles.length).fill(NaN);
  const mid = new Array(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const from = Math.max(0, i - period);
    if (i - from < Math.min(period, 5)) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = from; j < i; j++) {
      if (candles[j].h > hi) hi = candles[j].h;
      if (candles[j].l < lo) lo = candles[j].l;
    }
    upper[i] = hi; lower[i] = lo; mid[i] = (hi + lo) / 2;
  }
  return { upper, lower, mid };
}

/** Session VWAP — resets on each UTC calendar day. */
export function vwapSession(candles) {
  const out = new Array(candles.length).fill(NaN);
  let day = -1, pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.t / 86400000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const typical = (c.h + c.l + c.c) / 3;
    pv += typical * c.v;
    vol += c.v;
    out[i] = vol > 0 ? pv / vol : c.c;
  }
  return out;
}

/** Supertrend (ATR bands with trend flip). dir: 1 = bullish, -1 = bearish. */
export function supertrend(candles, period = 10, mult = 3) {
  const a = atr(candles, period);
  const line = new Array(candles.length).fill(NaN);
  const dir = new Array(candles.length).fill(1);
  let upper = NaN, lower = NaN, trend = 1;

  for (let i = 0; i < candles.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const up = hl2 + mult * a[i];
    const dn = hl2 - mult * a[i];

    const prevUpper = upper, prevLower = lower;
    upper = Number.isFinite(prevUpper) && candles[i - 1] && candles[i - 1].c <= prevUpper
      ? Math.min(up, prevUpper) : up;
    lower = Number.isFinite(prevLower) && candles[i - 1] && candles[i - 1].c >= prevLower
      ? Math.max(dn, prevLower) : dn;

    if (trend === 1 && candles[i].c < lower) trend = -1;
    else if (trend === -1 && candles[i].c > upper) trend = 1;

    dir[i] = trend;
    line[i] = trend === 1 ? lower : upper;
  }
  return { line, dir };
}

/** Percentile rank of series[i] within the trailing `lookback` bars (0..1). */
export function percentileRank(series, i, lookback = 200) {
  const v = series[i];
  if (!Number.isFinite(v)) return 0.5;
  let below = 0, total = 0;
  for (let j = Math.max(0, i - lookback); j <= i; j++) {
    if (!Number.isFinite(series[j])) continue;
    total++;
    if (series[j] <= v) below++;
  }
  return total ? below / total : 0.5;
}

/** Rolling standard deviation of returns — realised volatility, annualised. */
export function realisedVol(closes, period = 20, barsPerYear = 525600) {
  const out = new Array(closes.length).fill(NaN);
  for (let i = period; i < closes.length; i++) {
    const rets = [];
    for (let j = i - period + 1; j <= i; j++) rets.push(Math.log(closes[j] / closes[j - 1]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    out[i] = Math.sqrt(varr) * Math.sqrt(barsPerYear) * 100;
  }
  return out;
}

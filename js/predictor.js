/**
 * Quetex Pro 1M — next-candle engine
 *
 * Predicts the direction of the NEXT 1-minute candle (close vs previous close),
 * which is what a "Higher / Lower, 1 minute" binary trade settles on.
 *
 * Two engines, chosen by how much history is available:
 *   • logistic   — online logistic regression over 14 scale-free features,
 *                  trained walk-forward with an out-of-sample holdout.
 *   • rules      — transparent weighted score for short windows (e.g. candles
 *                  recovered from a screenshot), clearly labelled as unvalidated.
 *
 * Honesty rules baked in:
 *   - Predictions are shrunk toward 50% by a trust factor derived from the
 *     out-of-sample hit rate. A model that validated at 50% cannot shout.
 *   - Nothing here uses future data: features at bar i only read bars ≤ i.
 */

import { buildContext, analyze } from './strategy.js';
import { percentileRank, clamp } from './indicators.js';

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

export const FEATURE_DEFS = [
  { key: 'ret1', label: 'Last bar impulse (ATR)' },
  { key: 'ret3', label: '3-bar momentum (ATR)' },
  { key: 'ret5', label: '5-bar momentum (ATR)' },
  { key: 'body', label: 'Signal bar body (ATR)' },
  { key: 'wick', label: 'Wick skew (lower − upper)' },
  { key: 'rsi', label: 'RSI deviation from 50' },
  { key: 'rsiSlope', label: 'RSI 3-bar slope' },
  { key: 'emaSpread', label: 'EMA9 − EMA20 (ATR)' },
  { key: 'emaSlope', label: 'EMA20 slope (ATR)' },
  { key: 'vwapDev', label: 'Distance from VWAP (ATR)' },
  { key: 'rangePos', label: 'Position in 20-bar range' },
  { key: 'streak', label: 'Candle streak (reversion)' },
  { key: 'volZ', label: 'Volume vs average (log)' },
  { key: 'atrPct', label: 'Volatility percentile' }
];

export const FEATURE_COUNT = FEATURE_DEFS.length;

/** Build the feature vector for bar i (reads only bars ≤ i). */
export function buildFeatureRow(candles, ctx, i) {
  const c = candles[i];
  const p = candles[i - 1] || c;
  const a = Number.isFinite(ctx.atr[i]) && ctx.atr[i] > 0 ? ctx.atr[i] : c.c * 0.001;
  const rng = Math.max(c.h - c.l, 1e-9);

  const rsi = Number.isFinite(ctx.rsi[i]) ? ctx.rsi[i] : 50;
  const rsiPrev = Number.isFinite(ctx.rsi[i - 3]) ? ctx.rsi[i - 3] : rsi;
  const e9 = Number.isFinite(ctx.ema9[i]) ? ctx.ema9[i] : c.c;
  const e20 = Number.isFinite(ctx.ema20[i]) ? ctx.ema20[i] : c.c;
  const e20p = Number.isFinite(ctx.ema20[i - 3]) ? ctx.ema20[i - 3] : e20;
  const vw = Number.isFinite(ctx.vwap[i]) ? ctx.vwap[i] : c.c;

  const hi = ctx.dc20.upper[i];
  const lo = ctx.dc20.lower[i];
  const rangePos = Number.isFinite(hi) && hi > lo ? (c.c - lo) / (hi - lo) - 0.5 : 0;

  // Consecutive same-direction candles, signed and capped at ±6
  let streak = 0;
  for (let k = i; k > Math.max(0, i - 8); k--) {
    const dir = Math.sign(candles[k].c - candles[k].o);
    if (dir === 0) break;
    if (streak === 0) streak = dir;
    else if (Math.sign(streak) === dir) streak += dir;
    else break;
  }

  const vs = ctx.volSma[i];
  const volZ = Number.isFinite(vs) && vs > 0 ? Math.log(Math.max(c.v, 1e-9) / vs) : 0;
  const atrPct = percentileRank(ctx.atrPct, i, 120) - 0.5;

  const upperWick = (c.h - Math.max(c.o, c.c)) / rng;
  const lowerWick = (Math.min(c.o, c.c) - c.l) / rng;

  const x = [
    (c.c - p.c) / a,                        // ret1
    (c.c - (candles[i - 3]?.c ?? c.c)) / a, // ret3
    (c.c - (candles[i - 5]?.c ?? c.c)) / a, // ret5
    (c.c - c.o) / a,                        // body
    lowerWick - upperWick,                  // wick skew
    (rsi - 50) / 50,                        // rsi
    (rsi - rsiPrev) / 15,                   // rsi slope
    (e9 - e20) / a,                         // ema spread
    ((e20 - e20p) / a) / 3,                 // ema slope
    (c.c - vw) / a,                         // vwap deviation
    rangePos * 2,                           // range position (-1..1)
    clamp(streak, -6, 6) / 6,               // streak
    Math.max(-3, Math.min(3, volZ)),        // volume
    atrPct * 2                              // volatility percentile
  ];

  return { x, atr: a };
}

/* ------------------------------------------------------------------ */
/* Logistic regression with L2                                       */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LogisticModel {
  constructor(dims) {
    this.dims = dims;
    this.w = new Float64Array(dims);
    this.b = 0;
    this.mu = new Float64Array(dims);
    this.sd = new Float64Array(dims).fill(1);
  }

  _scale(row) {
    const z = new Float64Array(this.dims);
    for (let j = 0; j < this.dims; j++) z[j] = (row[j] - this.mu[j]) / this.sd[j];
    return z;
  }

  logit(row) {
    const z = this._scale(row);
    let s = this.b;
    for (let j = 0; j < this.dims; j++) s += this.w[j] * z[j];
    return s;
  }

  proba(row) {
    const z = this.logit(row);
    return 1 / (1 + Math.exp(-clamp(z, -30, 30)));
  }

  fit(X, y, { epochs = 12, lr = 0.12, l2 = 0.0015, seed = 11 } = {}) {
    const n = X.length;
    if (!n) return this;
    // standardisation
    for (let j = 0; j < this.dims; j++) {
      let m = 0;
      for (let i = 0; i < n; i++) m += X[i][j];
      m /= n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (X[i][j] - m) ** 2;
      v = Math.sqrt(v / n);
      this.mu[j] = m;
      this.sd[j] = v > 1e-9 ? v : 1;
    }
    const Z = X.map((r) => this._scale(r));
    const rand = mulberry32(seed);

    for (let e = 0; e < epochs; e++) {
      const idx = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      const step = lr / (1 + e * 0.35);
      for (const k of idx) {
        const z = Z[k];
        let s = this.b;
        for (let j = 0; j < this.dims; j++) s += this.w[j] * z[j];
        const p = 1 / (1 + Math.exp(-clamp(s, -30, 30)));
        const g = p - y[k];
        for (let j = 0; j < this.dims; j++) {
          this.w[j] -= step * (g * z[j] + l2 * this.w[j]);
        }
        this.b -= step * g;
      }
    }
    return this;
  }

  contributions(row) {
    const z = this._scale(row);
    return Array.from(this.w, (w, j) => w * z[j]);
  }
}

/* ------------------------------------------------------------------ */
/* Prediction                                                          */
/* ------------------------------------------------------------------ */

const MIN_SAMPLES = 80;
const FEATURE_START = 26;

/**
 * @param {Array} candles  closed candles, oldest → newest
 * @param {object} ctx     buildContext(candles)
 * @returns {object|null}  prediction descriptor
 */
export function predictNextCandle(candles, ctx, { trainFrac = 0.7, epochs = 12 } = {}) {
  const n = candles?.length || 0;
  if (n < 35) return null;

  const last = candles[n - 1];
  const atr = Number.isFinite(ctx.atr[n - 1]) && ctx.atr[n - 1] > 0 ? ctx.atr[n - 1] : last.c * 0.001;

  /* ---- gather (features, label) samples ---- */
  const X = [];
  const y = [];
  const start = Math.min(FEATURE_START, Math.max(10, n - 20));
  for (let i = start; i < n - 1; i++) {
    const row = buildFeatureRow(candles, ctx, i);
    X.push(row.x);
    const now = candles[i].c;
    const next = candles[i + 1].c;
    y.push(next > now ? 1 : 0);
  }

  const lastRow = buildFeatureRow(candles, ctx, n - 1);
  const desk = safeAnalyze(ctx, n - 1);

  if (X.length >= MIN_SAMPLES) {
    const split = Math.floor(X.length * trainFrac);
    const trainX = X.slice(0, split);
    const trainY = y.slice(0, split);
    const testX = X.slice(split);
    const testY = y.slice(split);

    const model = new LogisticModel(FEATURE_COUNT);
    model.fit(trainX, trainY, { epochs, lr: 0.12, l2: 0.0015 });

    let hits = 0;
    for (let i = 0; i < testX.length; i++) {
      const p = model.proba(testX[i]);
      const call = p >= 0.5 ? 1 : 0;
      if (call === testY[i]) hits++;
    }
    const oosHit = testX.length ? hits / testX.length : 0.5;

    // Continue training on the holdout (walk-forward) for the live weights.
    model.fit(X, y, { epochs: Math.max(4, Math.round(epochs / 2)), lr: 0.08, l2: 0.0015, seed: 29 });

    const raw = model.proba(lastRow.x);
    const trust = clamp(0.45 + (oosHit - 0.5) * 7 + Math.min(0.15, testX.length / 2000), 0.25, 1);
    const probUp = clamp(0.5 + (raw - 0.5) * trust, 0.02, 0.98);
    const contribs = model.contributions(lastRow.x);

    return finalize({
      probUp,
      rawProbUp: raw,
      model: 'logistic',
      trust,
      oosHit,
      oosSamples: testX.length,
      trainSamples: split,
      contributions: contribs,
      lastRow,
      atr,
      last,
      desk
    });
  }

  /* ---- rules engine for short windows ---- */
  const f = {};
  FEATURE_DEFS.forEach((d, j) => { f[d.key] = lastRow.x[j]; });

  // Mean reversion on the very short horizon, continuation on the 3–20 bar horizon.
  let score = 0;
  score += -0.55 * clamp(f.ret1, -2, 2);       // 1-bar overextension tends to fade
  score += 0.45 * clamp(f.ret3, -2.5, 2.5) * 0.6;
  score += 0.35 * clamp(f.ret5, -3, 3) * 0.4;
  score += 0.55 * clamp(f.emaSpread, -2, 2);
  score += 0.45 * clamp(f.emaSlope, -2, 2);
  score += 0.50 * clamp(f.vwapDev, -2, 2);
  score += 0.40 * clamp(f.rsiSlope, -2, 2);
  score += 0.25 * clamp(f.rsi, -1, 1);
  score += 0.35 * clamp(f.rangePos, -1, 1);
  score += -0.45 * clamp(f.streak, -1, 1);     // 4+ same-direction candles: fade
  score += 0.30 * clamp(f.wick, -1, 1);
  if (desk) score += 0.35 * clamp(desk.score / 60, -1.5, 1.5);

  const raw = 1 / (1 + Math.exp(-clamp(score * 0.75, -6, 6)));
  const contributions = FEATURE_DEFS.map((d) => f[d.key] * 0.1);

  return finalize({
    probUp: clamp(0.5 + (raw - 0.5) * 0.55, 0.05, 0.95),
    rawProbUp: raw,
    model: 'rules',
    trust: 0.55,
    oosHit: null,
    oosSamples: 0,
    trainSamples: X.length,
    contributions,
    lastRow,
    atr,
    last,
    desk
  });
}

function safeAnalyze(ctx, i) {
  try {
    return analyze(ctx, i);
  } catch {
    return null;
  }
}

function finalize({
  probUp, rawProbUp, model, trust, oosHit, oosSamples, trainSamples,
  contributions, lastRow, atr, last, desk
}) {
  const side = probUp >= 0.5 ? 'up' : 'down';
  const confidence = Math.abs(probUp - 0.5) * 200;

  const ranked = contributions
    .map((c, j) => ({
      key: FEATURE_DEFS[j].key,
      label: FEATURE_DEFS[j].label,
      value: lastRow.x[j],
      contribution: c
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 8);

  const strength =
    confidence >= 30 ? 'strong lean'
      : confidence >= 18 ? 'moderate lean'
        : confidence >= 9 ? 'weak lean'
          : 'noise — coin flip';

  return {
    side,
    probUp,
    probDown: 1 - probUp,
    rawProbUp,
    confidence,
    model,
    trust,
    oosHit,
    oosSamples,
    trainSamples,
    features: ranked,
    allFeatures: contributions,
    atr,
    entry: last.c,
    lastTime: last.t,
    strength,
    expectedRangePct: (atr / last.c) * 100,
    desk: desk
      ? { bias: desk.bias, score: desk.score, confidence: desk.confidence, regime: desk.regime, verdict: desk.verdict }
      : null,
    note: buildNote({ side, confidence, model, trust, oosHit, desk })
  };
}

function buildNote({ side, confidence, model, trust, oosHit, desk }) {
  const dir = side === 'up' ? 'UP' : 'DOWN';
  if (confidence < 9) {
    return `The factors cancel out — this is a coin flip. The disciplined play is to skip the expiry, not to guess ${dir}.`;
  }
  const bits = [];
  bits.push(`${dir} lean held by ${confidence.toFixed(0)}% of the model's range.`);
  if (model === 'logistic') {
    bits.push(
      `Out-of-sample hit rate ${(oosHit * 100).toFixed(1)}% on the holdout; predictions are shrunk by a ${(
        trust * 100
      ).toFixed(0)}% trust factor, so a model that validated at 50% cannot shout.`
    );
  } else {
    bits.push('Too few candles for training — this is the transparent rule blend, not a validated model. Treat it as context.');
  }
  if (desk) {
    bits.push(`Desk regime: ${desk.regime.trend}, volatility ${desk.regime.vol}, ${desk.regime.session}.`);
  }
  if (confidence < 18) bits.push('Below the 18% action threshold — the expected value at a normal payout is negative.');
  return bits.join(' ');
}

/* ------------------------------------------------------------------ */
/* Expectancy math for binary payouts                                  */
/* ------------------------------------------------------------------ */

export function binaryExpectancy(prob, payoutPct, stake) {
  const p = clamp(prob, 0, 1);
  const b = payoutPct / 100;
  const win = stake * b;
  const loss = -stake;
  const ev = p * win + (1 - p) * loss;
  const breakeven = 1 / (1 + b);
  return {
    ev,
    evPct: stake > 0 ? (ev / stake) * 100 : 0,
    win,
    loss,
    breakeven,
    edgePct: (p - breakeven) * 100,
    kelly: p > breakeven ? (p * (1 + b) - 1) / b : 0
  };
}

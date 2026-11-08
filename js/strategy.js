/**
 * Quetex Pro 1M — strategy + confluence engine
 *
 * Every strategy is a pure function over a pre-computed context.
 * Signals are evaluated on the CLOSE of bar i and filled at the OPEN of i+1,
 * so nothing in this file can leak future information.
 */

import {
  sma, ema, rsi, atr, macd, bollinger, donchian, vwapSession,
  supertrend, percentileRank, clamp
} from './indicators.js';
import { sessionName, utcHour } from './utils.js';

export function buildContext(candles) {
  const close = candles.map((c) => c.c);
  const vol = candles.map((c) => c.v);
  const ctx = { candles, close };
  ctx.ema9 = ema(close, 9);
  ctx.ema20 = ema(close, 20);
  ctx.ema50 = ema(close, 50);
  ctx.ema200 = ema(close, 200);
  ctx.rsi = rsi(close, 14);
  ctx.atr = atr(candles, 14);
  ctx.macd = macd(close, 12, 26, 9);
  ctx.bb = bollinger(close, 20, 2);
  ctx.dc10 = donchian(candles, 10);
  ctx.dc20 = donchian(candles, 20);
  ctx.dc55 = donchian(candles, 55);
  ctx.vwap = vwapSession(candles);
  ctx.volSma = sma(vol, 20);
  ctx.st = supertrend(candles, 10, 3);
  ctx.atrPct = candles.map((c, i) => (Number.isFinite(ctx.atr[i]) ? (ctx.atr[i] / c.c) * 100 : NaN));
  return ctx;
}

export const WARMUP = 205;

const bodyUp = (c) => c.c > c.o;
const bodyDown = (c) => c.c < c.o;

/* ------------------------------------------------------------------ */
/* Strategy catalogue                                                  */
/* ------------------------------------------------------------------ */

export const STRATEGIES = [
  {
    id: 'ema-pullback',
    name: 'EMA Pullback Continuation',
    tag: 'Trend',
    bestTf: '5m · 15m · 1h',
    summary:
      'Buy the first orderly pullback into the 20 EMA while the 20/50/200 stack is bullish. Trend is the edge; the pullback is the entry timing.',
    rules: [
      'EMA20 > EMA50 > EMA200 (full bullish stack)',
      'Previous bar trades into / tags the 20 EMA',
      'Current bar closes back above the 20 EMA and above its open',
      'RSI(14) above the trend threshold (default 50)'
    ],
    invalidation: 'A close below the 50 EMA, or the EMA stack compressing flat, ends the setup.',
    defaults: { rsiMin: 50, stopAtr: 1.6, targetR: 2.0, trailAtr: 2.0 },
    params: [
      { key: 'rsiMin', label: 'RSI trend floor', min: 40, max: 65, step: 1 },
      { key: 'stopAtr', label: 'Stop distance (× ATR)', min: 0.8, max: 3.5, step: 0.1 },
      { key: 'targetR', label: 'Target (R multiple)', min: 1, max: 5, step: 0.1 },
      { key: 'trailAtr', label: 'Trail after 1R (× ATR)', min: 0.5, max: 4, step: 0.1 }
    ],
    entry(ctx, i, p) {
      const { candles, ema20, ema50, ema200, rsi: R } = ctx;
      const c = candles[i], prev = candles[i - 1];
      if (![ema20[i], ema50[i], ema200[i], R[i], ctx.atr[i]].every(Number.isFinite)) return 0;
      const bullStack = ema20[i] > ema50[i] && ema50[i] > ema200[i];
      const bearStack = ema20[i] < ema50[i] && ema50[i] < ema200[i];
      if (bullStack && prev.l <= ema20[i - 1] * 1.0005 && c.c > ema20[i] && bodyUp(c) && R[i] >= p.rsiMin) return 1;
      if (bearStack && prev.h >= ema20[i - 1] * 0.9995 && c.c < ema20[i] && bodyDown(c) && R[i] <= 100 - p.rsiMin) return -1;
      return 0;
    },
    exit(ctx, i, p, pos) {
      const { candles, ema50 } = ctx;
      const c = candles[i].c;
      if (!Number.isFinite(ema50[i])) return false;
      return pos.side === 'long' ? c < ema50[i] * 0.998 : c > ema50[i] * 1.002;
    }
  },
  {
    id: 'donchian-break',
    name: 'Donchian Breakout + Volume',
    tag: 'Breakout',
    bestTf: '15m · 1h · 4h',
    summary:
      'Trade expansion out of a 20-bar range only when the break carries above-average volume and sits with the higher-timeframe trend.',
    rules: [
      'Close above the prior 20-bar high (or below the low)',
      'Breakout bar volume ≥ 1.25× the 20-bar average',
      'EMA50 on the correct side of EMA200',
      'ATR expanding versus its 20-bar median'
    ],
    invalidation: 'A close back inside the range within 3 bars — the break failed; do not re-arm until a new range forms.',
    defaults: { volMult: 1.25, stopAtr: 1.8, targetR: 2.5, trailAtr: 2.2 },
    params: [
      { key: 'volMult', label: 'Volume filter (× avg)', min: 0.8, max: 3, step: 0.05 },
      { key: 'stopAtr', label: 'Stop distance (× ATR)', min: 0.8, max: 3.5, step: 0.1 },
      { key: 'targetR', label: 'Target (R multiple)', min: 1, max: 6, step: 0.1 },
      { key: 'trailAtr', label: 'Trail after 1R (× ATR)', min: 0.5, max: 4, step: 0.1 }
    ],
    entry(ctx, i, p) {
      const { candles, dc20, volSma, ema50, ema200 } = ctx;
      const c = candles[i];
      if (![dc20.upper[i], volSma[i], ema50[i], ema200[i]].every(Number.isFinite)) return 0;
      const volOk = c.v >= volSma[i] * p.volMult;
      if (!volOk) return 0;
      if (c.c > dc20.upper[i] && ema50[i] > ema200[i]) return 1;
      if (c.c < dc20.lower[i] && ema50[i] < ema200[i]) return -1;
      return 0;
    },
    exit(ctx, i, p, pos) {
      const { candles, dc20 } = ctx;
      const mid = dc20.mid[i];
      if (!Number.isFinite(mid)) return false;
      const c = candles[i].c;
      return pos.side === 'long' ? c < mid : c > mid;
    }
  },
  {
    id: 'rsi-reversion',
    name: 'RSI Band Reversion',
    tag: 'Mean reversion',
    bestTf: '5m · 15m',
    summary:
      'Fade exhaustion into the lower/upper Bollinger band when RSI turns back from an extreme. Works in range regimes, dies in trends — the regime filter is mandatory.',
    rules: [
      'RSI(14) crosses back above 30 (long) / below 70 (short)',
      'Price closed outside the 2σ band on the signal bar',
      'Volatility percentile below 0.85 (no shock tape)',
      'Target is the 20-period mean, not a fixed R'
    ],
    invalidation: 'A second close outside the band with rising ATR — step aside, the move is impulsive.',
    defaults: { rsiLevel: 30, stopAtr: 2.0, targetR: 1.2, trailAtr: 0 },
    params: [
      { key: 'rsiLevel', label: 'RSI extreme', min: 15, max: 40, step: 1 },
      { key: 'stopAtr', label: 'Stop distance (× ATR)', min: 1, max: 4, step: 0.1 },
      { key: 'targetR', label: 'Max target (R)', min: 0.5, max: 3, step: 0.1 },
      { key: 'trailAtr', label: 'Trail after 1R (× ATR)', min: 0, max: 3, step: 0.1 }
    ],
    entry(ctx, i, p) {
      const { candles, rsi: R, bb, atrPct } = ctx;
      const c = candles[i];
      if (![R[i], R[i - 1], bb.lower[i], bb.upper[i]].every(Number.isFinite)) return 0;
      if (percentileRank(atrPct, i, 120) > 0.85) return 0;
      if (R[i - 1] <= p.rsiLevel && R[i] > p.rsiLevel) return 1;
      if (R[i - 1] >= 100 - p.rsiLevel && R[i] < 100 - p.rsiLevel) return -1;
      return 0;
    },
    exit(ctx, i, p, pos) {
      const { candles, bb, rsi: R } = ctx;
      const c = candles[i];
      const mid = bb.mid[i];
      if (!Number.isFinite(mid)) return false;
      if (pos.side === 'long') return c.c >= mid || R[i] > 62 || c.c < bb.lower[i] * 0.985;
      return c.c <= mid || R[i] < 38 || c.c > bb.upper[i] * 1.015;
    },
    risk(ctx, i, side) {
      const mid = ctx.bb.mid[i];
      const a = ctx.atr[i];
      if (!Number.isFinite(mid) || !Number.isFinite(a)) return null;
      const close = ctx.candles[i].c;
      return side === 'long'
        ? { stop: close - a * 2, target: Math.min(mid, close + a * 4) }
        : { stop: close + a * 2, target: Math.max(mid, close - a * 4) };
    }
  },
  {
    id: 'macd-momentum',
    name: 'MACD Momentum Shift',
    tag: 'Momentum',
    bestTf: '15m · 1h · 4h',
    summary:
      'Enter when the MACD histogram flips positive while price holds above a rising 200 EMA — a slower, fewer-trades confirmation engine.',
    rules: [
      'MACD histogram crosses above zero (below for shorts)',
      'MACD line above zero for longs',
      'Close above EMA200 and EMA200 rising over 20 bars',
      'Skip if ATR percentile > 0.9 (news shock)'
    ],
    invalidation: 'Histogram flips back against the position, or price closes through the 50 EMA.',
    defaults: { stopAtr: 2.0, targetR: 2.2, trailAtr: 2.4 },
    params: [
      { key: 'stopAtr', label: 'Stop distance (× ATR)', min: 0.8, max: 4, step: 0.1 },
      { key: 'targetR', label: 'Target (R multiple)', min: 1, max: 6, step: 0.1 },
      { key: 'trailAtr', label: 'Trail after 1R (× ATR)', min: 0, max: 4, step: 0.1 }
    ],
    entry(ctx, i) {
      const { candles, macd: M, ema200, ema50, atrPct } = ctx;
      const c = candles[i];
      if (![M.hist[i], M.hist[i - 1], M.line[i], ema200[i], ema200[i - 20]].every(Number.isFinite)) return 0;
      if (percentileRank(atrPct, i, 150) > 0.9) return 0;
      const rising = ema200[i] > ema200[i - 20];
      if (M.hist[i - 1] <= 0 && M.hist[i] > 0 && M.line[i] > 0 && c.c > ema200[i] && rising) return 1;
      if (M.hist[i - 1] >= 0 && M.hist[i] < 0 && M.line[i] < 0 && c.c < ema200[i] && !rising) return -1;
      return 0;
    },
    exit(ctx, i, p, pos) {
      const { macd: M } = ctx;
      const h = M.hist[i], hp = M.hist[i - 1];
      if (!Number.isFinite(h) || !Number.isFinite(hp)) return false;
      return pos.side === 'long' ? hp > 0 && h <= 0 : hp < 0 && h >= 0;
    }
  },
  {
    id: 'supertrend',
    name: 'Supertrend Flip',
    tag: 'Trend following',
    bestTf: '15m · 1h · 4h',
    summary:
      'Systematic trend capture: take the Supertrend(10, 3) flip in the direction of the 200 EMA, then let the ATR trail do the work.',
    rules: [
      'Supertrend flips bullish (bearish) this bar',
      'Close above (below) the 200 EMA',
      'ATR above its 40-bar median — avoid dead tape',
      'Hard time-stop of 120 bars if the trail never engages'
    ],
    invalidation: 'Flip back to the opposite side of the Supertrend line.',
    defaults: { stopAtr: 2.0, targetR: 3.0, trailAtr: 1.8 },
    params: [
      { key: 'stopAtr', label: 'Stop distance (× ATR)', min: 0.8, max: 4, step: 0.1 },
      { key: 'targetR', label: 'Target (R multiple)', min: 1, max: 8, step: 0.1 },
      { key: 'trailAtr', label: 'Trail (× ATR)', min: 0.5, max: 4, step: 0.1 }
    ],
    entry(ctx, i) {
      const { candles, st, ema200, atr, atrPct } = ctx;
      const c = candles[i];
      if (![st.dir[i], st.dir[i - 1], ema200[i], atr[i]].every(Number.isFinite)) return 0;
      if (percentileRank(atrPct, i, 60) < 0.35) return 0;
      if (st.dir[i] === 1 && st.dir[i - 1] === -1 && c.c > ema200[i]) return 1;
      if (st.dir[i] === -1 && st.dir[i - 1] === 1 && c.c < ema200[i]) return -1;
      return 0;
    },
    exit(ctx, i, p, pos) {
      const { st } = ctx;
      if (pos.side === 'long') return st.dir[i] === -1;
      return st.dir[i] === 1;
    }
  },
  {
    id: 'vwap-scalp',
    name: 'VWAP Reclaim Scalp (1M)',
    tag: 'Intraday scalping',
    bestTf: '1m · 5m',
    summary:
      'The 1-minute workhorse: price lost VWAP, based, then reclaimed it with short-term trend agreement. Tight ATR stop, fast 1.5R target, time-boxed.',
    rules: [
      'Price crosses from below session VWAP to above it (reverse for shorts)',
      'EMA20 above EMA50 on the signal bar',
      'RSI between 45 and 70 — momentum without exhaustion',
      'Only inside London / New York hours (06:00–21:00 UTC)',
      'Exit on the 12-bar time stop or a close back under the 20 EMA'
    ],
    invalidation: 'A 1-minute close back below VWAP within 3 bars kills the reclaim.',
    defaults: { stopAtr: 1.1, targetR: 1.5, trailAtr: 0, maxBars: 12, rsiLo: 45, rsiHi: 70 },
    params: [
      { key: 'stopAtr', label: 'Stop distance (× ATR)', min: 0.6, max: 2.5, step: 0.1 },
      { key: 'targetR', label: 'Target (R multiple)', min: 0.8, max: 3, step: 0.1 },
      { key: 'maxBars', label: 'Time stop (bars)', min: 5, max: 60, step: 1 },
      { key: 'rsiLo', label: 'RSI floor', min: 35, max: 60, step: 1 }
    ],
    entry(ctx, i, p) {
      const { candles, vwap, ema20, ema50, rsi: R } = ctx;
      const c = candles[i], prev = candles[i - 1];
      if (![vwap[i], vwap[i - 1], ema20[i], ema50[i], R[i]].every(Number.isFinite)) return 0;
      const h = utcHour(c.t);
      if (h < 6 || h >= 21) return 0;
      const reclaim = prev.c <= vwap[i - 1] && c.c > vwap[i];
      const reject = prev.c >= vwap[i - 1] && c.c < vwap[i];
      if (reclaim && ema20[i] > ema50[i] && R[i] >= p.rsiLo && R[i] <= (p.rsiHi ?? 70)) return 1;
      if (reject && ema20[i] < ema50[i] && R[i] <= 100 - p.rsiLo && R[i] >= 100 - (p.rsiHi ?? 70)) return -1;
      return 0;
    },
    exit(ctx, i, p, pos) {
      const { candles, ema20 } = ctx;
      if (!Number.isFinite(ema20[i])) return false;
      return pos.side === 'long' ? candles[i].c < ema20[i] : candles[i].c > ema20[i];
    }
  }
];

export const getStrategy = (id) => STRATEGIES.find((s) => s.id === id) || STRATEGIES[0];

/* ------------------------------------------------------------------ */
/* Confluence engine — the "desk note" behind every trade              */
/* ------------------------------------------------------------------ */

export function analyze(ctx, i) {
  const { candles, close } = ctx;
  const c = candles[i] || candles[candles.length - 1];
  const idx = candles[i] ? i : candles.length - 1;
  const a = Number.isFinite(ctx.atr[idx]) ? ctx.atr[idx] : c.c * 0.002;
  const digits = digitsFromPrice(c.c);

  const e20 = ctx.ema20[idx], e50 = ctx.ema50[idx], e200 = ctx.ema200[idx];
  const R = ctx.rsi[idx];
  const hist = ctx.macd.hist[idx], histPrev = ctx.macd.hist[idx - 1];
  const vw = ctx.vwap[idx];
  const vr = ctx.volSma[idx] ? c.v / ctx.volSma[idx] : 1;
  const atrPctile = percentileRank(ctx.atrPct, idx, 200);
  const atrPct = ctx.atrPct[idx];

  const components = [];

  // --- 1. Trend ------------------------------------------------------
  let trend = 0;
  if (Number.isFinite(e20) && Number.isFinite(e50)) trend += e20 > e50 ? 32 : -32;
  if (Number.isFinite(e50) && Number.isFinite(e200)) trend += e50 > e200 ? 38 : -38;
  const slope = Number.isFinite(ctx.ema50[idx - 10]) ? (e50 - ctx.ema50[idx - 10]) / a : 0;
  trend += clamp(slope * 14, -30, 30);
  components.push({
    key: 'trend',
    label: 'Trend structure',
    weight: 0.3,
    score: clamp(trend, -100, 100),
    detail: `EMA20 ${fmtPx(e20, digits)} · EMA50 ${fmtPx(e50, digits)} · EMA200 ${fmtPx(e200, digits)}`
  });

  // --- 2. Structure --------------------------------------------------
  const dc = ctx.dc20;
  let structure = 0;
  if (Number.isFinite(dc.mid[idx])) structure = clamp(((c.c - dc.mid[idx]) / a) * 16, -55, 55);
  if (c.c > dc.upper[idx] || c.h >= dc.upper[idx]) structure += 32;
  if (c.c < dc.lower[idx] || c.l <= dc.lower[idx]) structure -= 32;
  components.push({
    key: 'structure',
    label: 'Range structure',
    weight: 0.22,
    score: clamp(structure, -100, 100),
    detail: `20-bar range ${fmtPx(dc.lower[idx], digits)} – ${fmtPx(dc.upper[idx], digits)}`
  });

  // --- 3. Momentum ---------------------------------------------------
  let momentum = clamp((R - 50) * 1.9, -75, 75);
  if (Number.isFinite(hist)) momentum += hist > 0 ? 14 : -14;
  if (Number.isFinite(hist) && Number.isFinite(histPrev)) momentum += hist > histPrev ? 11 : -11;
  components.push({
    key: 'momentum',
    label: 'Momentum',
    weight: 0.22,
    score: clamp(momentum, -100, 100),
    detail: `RSI ${Number.isFinite(R) ? R.toFixed(1) : '—'} · MACD hist ${Number.isFinite(hist) ? (hist > 0 ? '+' : '') + hist.toFixed(digits > 3 ? 5 : 2) : '—'}`
  });

  // --- 4. VWAP -------------------------------------------------------
  const vwapScore = Number.isFinite(vw) ? clamp(((c.c - vw) / a) * 24, -70, 70) : 0;
  components.push({
    key: 'vwap',
    label: 'VWAP position',
    weight: 0.14,
    score: vwapScore,
    detail: `Session VWAP ${fmtPx(vw, digits)} · price ${c.c >= vw ? 'above' : 'below'}`
  });

  // --- 5. Volume / participation --------------------------------------
  const volScore = clamp(((vr - 1) * 70) * Math.sign(structure || 1), -60, 60);
  components.push({
    key: 'volume',
    label: 'Participation',
    weight: 0.12,
    score: volScore,
    detail: `Volume ${vr.toFixed(2)}× 20-bar average`
  });

  const rawScore = components.reduce((s, x) => s + x.score * x.weight, 0);
  const score = clamp(rawScore, -100, 100);

  // --- Regime --------------------------------------------------------
  const emaSpread = Number.isFinite(e50) ? Math.abs(e50 - e200) / a : 0;
  const trendRegime = emaSpread > 3.5
    ? (e50 > e200 ? 'Uptrend' : 'Downtrend')
    : 'Range / chop';
  const volRegime = atrPctile > 0.78 ? 'Expanding' : atrPctile < 0.3 ? 'Contracting' : 'Normal';
  const session = sessionName(c.t);

  // Confidence: directional conviction, lightly damped for hostile regimes
  let confidence = Math.abs(score) * 1.6;
  if (trendRegime === 'Range / chop') confidence *= 0.9;
  if (volRegime === 'Expanding') confidence *= 0.95;
  if (session.quality === 'Low') confidence *= 0.94;
  confidence = clamp(confidence, 0, 99);

  let side = 'neutral';
  if (score >= 18) side = 'long';
  else if (score <= -18) side = 'short';

  // --- Trade plan ----------------------------------------------------
  const atrMult = volRegime === 'Expanding' ? 2.1 : 1.7;
  const entry = c.c;
  const stop = side === 'short' ? entry + a * atrMult : entry - a * atrMult;
  const risk = Math.abs(entry - stop);
  const tp1 = side === 'short' ? entry - risk : entry + risk;
  const tp2 = side === 'short' ? entry - risk * 2 : entry + risk * 2;
  const tp3 = side === 'short' ? entry - risk * 3 : entry + risk * 3;

  const pullback = side === 'long'
    ? Math.max(e20, entry - a * 0.8)
    : Math.min(e20, entry + a * 0.8);

  const checklist = [
    {
      ok: side === 'long' ? c.c > e200 : c.c < e200,
      label: 'Price on the correct side of the 200 EMA',
      detail: `${fmtPx(e200, digits)}`
    },
    {
      ok: side === 'long' ? e20 > e50 : e20 < e50,
      label: 'Short-term trend agrees (20 vs 50 EMA)',
      detail: `${fmtPx(e20, digits)} vs ${fmtPx(e50, digits)}`
    },
    {
      ok: side === 'long' ? R >= 50 && R <= 72 : R <= 50 && R >= 28,
      label: 'RSI in the momentum sweet spot',
      detail: `${Number.isFinite(R) ? R.toFixed(1) : '—'}`
    },
    {
      ok: side === 'long' ? hist > 0 : hist < 0,
      label: 'MACD histogram supports direction',
      detail: `${Number.isFinite(hist) ? hist.toFixed(4) : '—'}`
    },
    { ok: vr >= 1, label: 'Volume at or above average', detail: `${vr.toFixed(2)}×` },
    {
      ok: side === 'long' ? c.c > vw : c.c < vw,
      label: 'Aligned with session VWAP',
      detail: `${fmtPx(vw, digits)}`
    },
    {
      ok: atrPctile <= 0.9,
      label: 'Volatility not overheated',
      detail: `ATR ${(atrPct || 0).toFixed(2)}% · pct ${(atrPctile * 100).toFixed(0)}`
    },
    {
      ok: session.quality === 'High' || session.quality === 'Highest',
      label: 'Liquid session window',
      detail: session.name
    }
  ];

  const passed = checklist.filter((x) => x.ok).length;

  return {
    index: idx,
    time: c.t,
    side,
    bias: side === 'long' ? 'Bullish' : side === 'short' ? 'Bearish' : 'Neutral',
    score,
    confidence,
    components,
    regime: {
      trend: trendRegime,
      vol: volRegime,
      atrPct: atrPct || 0,
      atrPctile,
      session: session.name,
      sessionQuality: session.quality,
      sessionNote: session.note
    },
    plan: {
      entry,
      pullback: Number.isFinite(pullback) ? pullback : entry,
      stop,
      tp1, tp2, tp3,
      risk,
      atr: a,
      rr: side === 'neutral' ? 0 : 2,
      stopPct: (risk / entry) * 100
    },
    checklist,
    passed,
    totalChecks: checklist.length,
    verdict:
      confidence >= 65 && passed >= 6 ? 'A-setup'
        : confidence >= 45 && passed >= 4 ? 'B-setup — reduce size'
          : 'No trade — wait for alignment',
    note: buildDeskNote({ side, trendRegime, volRegime, session, passed, confidence, vr })
  };
}

function buildDeskNote({ side, trendRegime, volRegime, session, passed, confidence, vr }) {
  if (side === 'neutral') {
    return `No directional edge: the 20/50/200 stack and momentum disagree. In ${trendRegime.toLowerCase()} with ${volRegime.toLowerCase()} volatility, the highest-probability play is to wait for a range edge rather than pay the spread in the middle.`;
  }
  const bits = [];
  bits.push(`${trendRegime === 'Range / chop' ? 'Range conditions' : `${trendRegime} conditions`} favour the ${side} side.`);
  if (volRegime === 'Expanding') bits.push('Volatility is expanding — widen the stop, cut size by a third.');
  if (volRegime === 'Contracting') bits.push('Volatility is compressed — expect a breakout, avoid fading the first push.');
  if (vr < 1) bits.push('Participation is thin; a break without volume usually retraces.');
  if (session.quality === 'Low') bits.push('Off-hours tape: treat this as a B-setup.');
  bits.push(`${passed}/8 checks aligned — ${confidence >= 65 ? 'execute the A-plan' : confidence >= 45 ? 'execute at 50–60% size' : 'stand down'}.`);
  return bits.join(' ');
}

function digitsFromPrice(p) {
  if (p >= 1000) return 2;
  if (p >= 10) return 2;
  if (p >= 1) return 4;
  return 5;
}

function fmtPx(v, d) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

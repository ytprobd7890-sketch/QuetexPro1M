/**
 * Quetex Pro 1M — event-driven backtester
 *
 * Fill model: a signal is read on the CLOSE of bar i and filled at the OPEN of i+1.
 * Stops and targets are evaluated intrabar, stop-first when both are touched.
 * Fees are charged per side; slippage is applied against the fill.
 */

import { WARMUP } from './strategy.js';
import { TIMEFRAMES } from './data.js';

export const DEFAULT_CFG = {
  initialCapital: 10_000,
  riskPct: 1,
  feeBps: 4,
  slipBps: 1.5,
  maxLeverage: 3,
  allowShort: true
};

export function runBacktest(candles, ctx, strategy, rawParams = {}, cfg = {}) {
  const p = { ...strategy.defaults, ...rawParams };
  const conf = { ...DEFAULT_CFG, ...cfg };
  const { initialCapital, riskPct, feeBps, slipBps, maxLeverage, allowShort, timeframe = '15m' } = conf;

  const risk = riskPct / 100;
  const fee = feeBps / 10_000;
  const slip = slipBps / 10_000;
  const barsPerYear = TIMEFRAMES[timeframe]?.perYear ?? 35_040;

  let cash = initialCapital;
  let pos = null;
  let pending = null;
  let totalFees = 0;
  const trades = [];
  const equityCurve = new Array(candles.length).fill(null);
  let exposureBars = 0;
  const startIdx = Math.min(WARMUP, Math.max(0, candles.length - 2));

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];

    /* ---------- 1. fill a pending signal at this bar's open ---------- */
    if (pending && !pos) {
      const sign = pending.side === 'long' ? 1 : -1;
      const fill = c.o * (1 + sign * slip);
      const stopDist = Math.abs(fill - pending.stop);
      if (fill > 0 && stopDist > 0) {
        let qty = (cash * risk) / stopDist;
        const maxQty = (cash * maxLeverage) / fill;
        if (!Number.isFinite(qty) || qty <= 0) qty = 0;
        qty = Math.min(qty, maxQty);
        if (qty > 0) {
          const entryFee = qty * fill * fee;
          cash -= entryFee;
          totalFees += entryFee;
          pos = {
            side: pending.side,
            sign,
            entry: fill,
            qty,
            stop: pending.stop,
            initialStop: pending.stop,
            target: pending.target,
            stop0: stopDist,
            entryIdx: i,
            entryTime: c.t,
            entryFee,
            bars: 0,
            mfe: 0,
            mae: 0,
            trailMoved: false,
            riskAmount: qty * stopDist,
            setup: strategy.name
          };
        }
      }
      pending = null;
    }

    /* ---------- 2. manage the open position ---------- */
    if (pos) {
      pos.bars++;
      exposureBars++;

      const isLong = pos.sign === 1;
      const fav = isLong ? c.h - pos.entry : pos.entry - c.l;
      const adv = isLong ? pos.entry - c.l : c.h - pos.entry;
      if (fav > pos.mfe) pos.mfe = fav;
      if (adv > pos.mae) pos.mae = adv;

      let exitPx = null;
      let reason = '';

      const stopHit = isLong ? c.l <= pos.stop : c.h >= pos.stop;
      const targetHit = isLong ? c.h >= pos.target : c.l <= pos.target;

      if (stopHit) {
        exitPx = isLong ? Math.min(c.o, pos.stop) : Math.max(c.o, pos.stop);
        reason = pos.trailMoved ? 'Trail stop' : 'Stop loss';
      } else if (targetHit) {
        exitPx = isLong ? Math.max(c.o, pos.target) : Math.min(c.o, pos.target);
        reason = 'Take profit';
      } else if (p.maxBars && pos.bars >= p.maxBars) {
        exitPx = c.c;
        reason = 'Time stop';
      } else if (typeof strategy.exit === 'function' && strategy.exit(ctx, i, p, pos)) {
        exitPx = c.c;
        reason = 'Exit signal';
      }

      if (exitPx !== null) {
        const fill = exitPx * (1 - pos.sign * slip);
        const gross = (fill - pos.entry) * pos.qty * pos.sign;
        const exitFee = Math.abs(fill * pos.qty) * fee;
        totalFees += exitFee;
        const pnl = gross - exitFee;
        cash += gross - exitFee;

        trades.push({
          id: trades.length + 1,
          side: pos.side,
          setup: pos.setup,
          entryIdx: pos.entryIdx,
          exitIdx: i,
          entryTime: pos.entryTime,
          exitTime: c.t,
          entry: pos.entry,
          exit: fill,
          qty: pos.qty,
          notional: pos.entry * pos.qty,
          stop: pos.stop,
          initialStop: pos.initialStop,
          target: pos.target,
          stop0: pos.stop0,
          pnl,
          pnlPct: (pnl / (pos.entry * pos.qty)) * 100,
          rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
          bars: pos.bars,
          mfeR: pos.stop0 > 0 ? pos.mfe / pos.stop0 : 0,
          maeR: pos.stop0 > 0 ? pos.mae / pos.stop0 : 0,
          reason,
          equityAfter: cash
        });
        pos = null;
      } else if (p.trailAtr > 0) {
        // Trail only on closed-bar data (ATR from the prior bar) — no look-ahead.
        const aPrev = ctx.atr[i - 1];
        if (Number.isFinite(aPrev)) {
          const profitDist = pos.sign * (c.c - pos.entry);
          if (profitDist >= pos.stop0) {
            const candidate = c.c - pos.sign * p.trailAtr * aPrev;
            const improves = isLong ? candidate > pos.stop : candidate < pos.stop;
            if (improves) { pos.stop = candidate; pos.trailMoved = true; }
          }
        }
      }
    }

    /* ---------- 3. mark to market ---------- */
    const openPnl = pos ? (c.c - pos.entry) * pos.qty * pos.sign : 0;
    equityCurve[i] = cash + openPnl;

    /* ---------- 4. arm the next signal ---------- */
    if (!pos && !pending && i < candles.length - 1) {
      const sig = strategy.entry(ctx, i, p);
      if (sig !== 0 && (sig > 0 || allowShort)) {
        const side = sig > 0 ? 'long' : 'short';
        const a = ctx.atr[i];
        let stop = NaN;
        let target = NaN;

        const custom = typeof strategy.risk === 'function' ? strategy.risk(ctx, i, side, p) : null;
        if (custom && Number.isFinite(custom.stop) && Number.isFinite(custom.target)) {
          stop = custom.stop;
          target = custom.target;
        } else if (Number.isFinite(a) && p.stopAtr > 0) {
          stop = side === 'long' ? c.c - a * p.stopAtr : c.c + a * p.stopAtr;
          target = side === 'long' ? c.c + a * p.stopAtr * p.targetR : c.c - a * p.stopAtr * p.targetR;
        }

        const directional = side === 'long' ? stop < c.c && target > c.c : stop > c.c && target < c.c;
        if (Number.isFinite(stop) && Number.isFinite(target) && directional) {
          pending = { side, stop, target };
        }
      }
    }
  }

  /* ---------- 5. force-close any runner at the last print ---------- */
  if (pos) {
    const last = candles[candles.length - 1];
    const gross = (last.c - pos.entry) * pos.qty * pos.sign;
    const exitFee = Math.abs(last.c * pos.qty) * fee;
    totalFees += exitFee;
    cash += gross - exitFee;
    trades.push({
      id: trades.length + 1,
      side: pos.side,
      setup: pos.setup,
      entryIdx: pos.entryIdx,
      exitIdx: candles.length - 1,
      entryTime: pos.entryTime,
      exitTime: last.t,
      entry: pos.entry,
      exit: last.c,
      qty: pos.qty,
      notional: pos.entry * pos.qty,
      stop: pos.stop,
      initialStop: pos.initialStop,
      target: pos.target,
      stop0: pos.stop0,
      pnl: gross - exitFee,
      pnlPct: (gross / (pos.entry * pos.qty)) * 100,
      rMultiple: pos.riskAmount > 0 ? (gross - exitFee) / pos.riskAmount : 0,
      bars: pos.bars,
      mfeR: pos.stop0 > 0 ? pos.mfe / pos.stop0 : 0,
      maeR: pos.stop0 > 0 ? pos.mae / pos.stop0 : 0,
      reason: 'Open at end',
      equityAfter: cash
    });
    equityCurve[candles.length - 1] = cash;
    pos = null;
  }

  const filled = equityCurve.map((v, i) => (v === null ? (i === 0 ? initialCapital : equityCurve[i - 1] ?? initialCapital) : v));
  for (let i = 1; i < filled.length; i++) if (filled[i] === null) filled[i] = filled[i - 1];

  const metrics = computeMetrics({
    curve: filled,
    trades,
    initialCapital,
    barsPerYear,
    exposureBars,
    totalFees,
    bars: candles.length - startIdx,
    candles,
    startIdx
  });

  const monteCarlo = runMonteCarlo(trades, risk, initialCapital);

  return { trades, equityCurve: filled, metrics, monteCarlo, startIdx, params: p, cfg: conf };
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

function computeMetrics({ curve, trades, initialCapital, barsPerYear, exposureBars, totalFees = 0, bars, candles, startIdx }) {
  const finalEquity = curve[curve.length - 1] ?? initialCapital;
  const netProfit = finalEquity - initialCapital;
  const returnPct = (netProfit / initialCapital) * 100;

  // Drawdown
  let peak = curve[startIdx] ?? initialCapital;
  let maxDD = 0, maxDDAbs = 0, ddStartIdx = startIdx, ddEndIdx = startIdx;
  for (let i = startIdx; i < curve.length; i++) {
    if (curve[i] > peak) { peak = curve[i]; ddStartIdx = i; }
    const dd = peak > 0 ? ((peak - curve[i]) / peak) * 100 : 0;
    if (dd > maxDD) { maxDD = dd; maxDDAbs = peak - curve[i]; ddEndIdx = i; }
  }

  // Bar-level returns for Sharpe / Sortino
  const rets = [];
  for (let i = startIdx + 1; i < curve.length; i++) {
    if (curve[i - 1] > 0) rets.push(curve[i] / curve[i - 1] - 1);
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) : 0;
  const ann = Math.sqrt(barsPerYear);
  const sharpe = sd > 0 ? (mean / sd) * ann : 0;
  const sortino = dsd > 0 ? (mean / dsd) * ann : 0;

  // Trade stats
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const expectancyR = trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0;
  const avgR = expectancyR;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 0;

  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curWin++; curLoss = 0; } else { curLoss++; curWin = 0; }
    maxWinStreak = Math.max(maxWinStreak, curWin);
    maxLossStreak = Math.max(maxLossStreak, curLoss);
  }

  const avgBars = trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : 0;

  const startPrice = candles[startIdx]?.c ?? candles[0].c;
  const endPrice = candles[candles.length - 1].c;
  const buyHoldPct = ((endPrice - startPrice) / startPrice) * 100;

  const cagr = finalEquity > 0 && bars > 0
    ? (Math.pow(finalEquity / initialCapital, barsPerYear / bars) - 1) * 100
    : 0;

  return {
    initialCapital,
    finalEquity,
    netProfit,
    returnPct,
    cagr,
    maxDD,
    maxDDAbs,
    maxDDStart: candles[ddStartIdx]?.t,
    maxDDEnd: candles[ddEndIdx]?.t,
    recoveryFactor: maxDDAbs > 0 ? netProfit / maxDDAbs : 0,
    sharpe,
    sortino,
    calmar: maxDD > 0 ? cagr / maxDD : 0,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    profitFactor,
    expectancyR,
    avgR,
    payoff,
    avgWin,
    avgLoss,
    avgBars,
    maxWinStreak,
    maxLossStreak,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.pnl)) : 0,
    exposure: bars > 0 ? (exposureBars / bars) * 100 : 0,
    buyHoldPct,
    alpha: returnPct - buyHoldPct,
    totalFees
  };
}

/* ------------------------------------------------------------------ */
/* Monte Carlo                                                         */
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

export function runMonteCarlo(trades, riskFraction, initialCapital, { runs = 1000, seed = 7 } = {}) {
  if (!trades.length) return { runs: 0, empty: true };
  const rand = mulberry32(seed);
  const rs = trades.map((t) => t.rMultiple);
  const finals = [];
  const maxDDs = [];
  const paths = [];

  for (let r = 0; r < runs; r++) {
    let eq = initialCapital;
    let peak = eq;
    let dd = 0;
    const path = [eq];
    for (let k = 0; k < rs.length; k++) {
      const R = rs[Math.floor(rand() * rs.length)];
      eq *= 1 + R * riskFraction;
      if (eq <= 0) { eq = 0.0001; }
      if (eq > peak) peak = eq;
      const curDD = ((peak - eq) / peak) * 100;
      if (curDD > dd) dd = curDD;
      path.push(eq);
    }
    finals.push(eq);
    maxDDs.push(dd);
    if (r < 5) paths.push(path);
  }

  const pct = (arr, q) => {
    const s = [...arr].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
    return s[i];
  };

  const finalsPct = {
    p5: pct(finals, 0.05),
    p25: pct(finals, 0.25),
    p50: pct(finals, 0.5),
    p75: pct(finals, 0.75),
    p95: pct(finals, 0.95)
  };
  const ddPct = {
    p50: pct(maxDDs, 0.5),
    p75: pct(maxDDs, 0.75),
    p95: pct(maxDDs, 0.95),
    worst: Math.max(...maxDDs)
  };
  const probProfit = (finals.filter((f) => f > initialCapital).length / finals.length) * 100;

  // Histogram of ending equity (30 buckets, clipped at p99 to avoid a single outlier flattening it)
  const clip = pct(finals, 0.99);
  const buckets = new Array(30).fill(0);
  const lo = initialCapital * 0.2;
  const hi = Math.max(clip, initialCapital * 1.01);
  for (const f of finals) {
    const b = Math.min(29, Math.max(0, Math.floor(((Math.min(f, hi) - lo) / (hi - lo)) * 30)));
    buckets[b]++;
  }

  return {
    runs,
    empty: false,
    finals: finalsPct,
    drawdown: ddPct,
    probProfit,
    medianReturnPct: ((finalsPct.p50 / initialCapital) - 1) * 100,
    p5ReturnPct: ((finalsPct.p5 / initialCapital) - 1) * 100,
    p95ReturnPct: ((finalsPct.p95 / initialCapital) - 1) * 100,
    histogram: { buckets, lo, hi },
    paths
  };
}

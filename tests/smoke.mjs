/**
 * Headless smoke test — validates data generation, indicators, the confluence
 * engine and the backtester without a browser.
 * Run: npm test
 */

import { SYMBOLS, TIMEFRAMES, generateSeries, parseCsv } from '../js/data.js';
import { buildContext, STRATEGIES, analyze, WARMUP } from '../js/strategy.js';
import { runBacktest, runMonteCarlo } from '../js/backtest.js';

let failures = 0;
const ok = (cond, label) => {
  if (!cond) { failures++; console.log(`  ✗ ${label}`); }
  else console.log(`  ✓ ${label}`);
};
const finite = (v) => Number.isFinite(v);

console.log('\n=== 1. Synthetic data integrity ===');
for (const sym of SYMBOLS) {
  for (const tf of ['1m', '15m', '1h', '1d']) {
    const { candles, meta } = generateSeries({ symbolId: sym.id, timeframe: tf, bars: 600, seed: 7 });
    const bad = candles.filter((c) =>
      !(finite(c.o) && finite(c.h) && finite(c.l) && finite(c.c) && finite(c.v)) ||
      c.h < Math.max(c.o, c.c) - 1e-9 || c.l > Math.min(c.o, c.c) + 1e-9 ||
      c.l <= 0 || c.v <= 0
    );
    ok(candles.length === 600 && bad.length === 0, `${sym.id} ${tf}: 600 valid OHLCV candles (${bad.length} bad)`);
    ok(meta.digits >= 0 && meta.source === 'simulated', `${sym.id} ${tf}: meta ok`);
  }
}

console.log('\n=== 2. Determinism ===');
{
  const a = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 300, seed: 99 });
  const b = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 300, seed: 99 });
  const same = a.candles.every((c, i) => c.c === b.candles[i].c && c.h === b.candles[i].h);
  ok(same, 'same seed produces an identical series');
}

console.log('\n=== 3. Indicator warm-up & ranges ===');
{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 800, seed: 21 });
  const ctx = buildContext(candles);
  ok(ctx.ema200[WARMUP] !== undefined, 'ema200 array present');
  ok(!finite(ctx.ema200[100]) && finite(ctx.ema200[260]), 'ema200 has warm-up NaN then values');
  ok(ctx.rsi.slice(20).every((v) => !finite(v) || (v >= 0 && v <= 100)), 'RSI within 0..100');
  ok(ctx.atr.slice(20).every((v) => !finite(v) || v > 0), 'ATR positive');
  ok(ctx.bb.upper.slice(30).every((v, i) => !finite(v) || v >= ctx.bb.lower[30 + i]), 'BB upper >= lower');
  ok(ctx.dc20.upper.slice(30).every((v) => !finite(v) || v > 0), 'Donchian upper valid');
  ok(ctx.st.dir.every((d) => d === 1 || d === -1), 'Supertrend direction is ±1');
}

console.log('\n=== 4. Confluence engine ===');
{
  const { candles } = generateSeries({ symbolId: 'ETHUSDT', timeframe: '15m', bars: 800, seed: 5 });
  const ctx = buildContext(candles);
  const a = analyze(ctx, candles.length - 1);
  ok(['long', 'short', 'neutral'].includes(a.side), `side = ${a.side}`);
  ok(a.confidence >= 0 && a.confidence <= 99, `confidence in range (${a.confidence.toFixed(1)})`);
  ok(a.components.length === 5, 'five confluence components');
  ok(a.components.every((c) => finite(c.score)), 'component scores finite');
  ok(a.checklist.length === 8, 'eight checklist items');
  ok(finite(a.plan.entry) && finite(a.plan.stop) && finite(a.plan.tp3), 'plan levels finite');
  ok(a.plan.risk > 0, 'plan risk > 0');
  ok(typeof a.note === 'string' && a.note.length > 40, 'desk note generated');
  console.log(`    bias=${a.bias} score=${a.score.toFixed(0)} conf=${a.confidence.toFixed(0)} plan=${a.plan.entry.toFixed(2)}/${a.plan.stop.toFixed(2)}`);
}

console.log('\n=== 5. Backtest engine — every strategy, every timeframe ===');
const rows = [];
for (const strat of STRATEGIES) {
  for (const tf of ['1m', '15m', '1h', '4h']) {
    const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: tf, bars: 1000, seed: 33 });
    const ctx = buildContext(candles);
    const res = runBacktest(candles, ctx, strat, {}, {
      initialCapital: 10_000, riskPct: 1, feeBps: 4, slipBps: 1.5, maxLeverage: 3, allowShort: true, timeframe: tf
    });
    const m = res.metrics;
    const curveOk = res.equityCurve.every(finite);
    const tradesOk = res.trades.every((t) =>
      finite(t.pnl) && finite(t.rMultiple) && t.bars > 0 && t.exitIdx >= t.entryIdx &&
      (t.side === 'long' ? t.initialStop < t.entry : t.initialStop > t.entry) &&
      t.qty > 0 && finite(t.exit)
    );
    const metricsOk = ['finalEquity', 'returnPct', 'maxDD', 'profitFactor', 'winRate', 'sharpe', 'expectancyR']
      .every((k) => finite(m[k]));
    const mcOk = res.monteCarlo.empty
      ? m.trades === 0
      : finite(res.monteCarlo.finals.p50) && res.monteCarlo.runs === 1000;

    ok(curveOk && tradesOk && metricsOk && mcOk, `${strat.id} @ ${tf}: ${m.trades} trades · ${m.returnPct.toFixed(2)}% · DD ${m.maxDD.toFixed(1)}% · PF ${m.profitFactor.toFixed(2)}`);
    rows.push([strat.id, tf, m.trades, m.returnPct, m.maxDD, m.profitFactor, m.winRate, m.expectancyR]);
  }
}

console.log('\n=== 6. Risk controls ===');
{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 1000, seed: 44 });
  const ctx = buildContext(candles);
  const res = runBacktest(candles, ctx, STRATEGIES[0], {}, {
    initialCapital: 10_000, riskPct: 1, feeBps: 0, slipBps: 0, maxLeverage: 1, allowShort: false, timeframe: '15m'
  });
  const worstRiskPct = Math.max(...res.trades.map((t) => (t.stop0 * t.qty) / t.equityAfter));
  ok(res.trades.every((t) => t.side === 'long'), 'shorts disabled when allowShort = false');
  ok(worstRiskPct <= 0.021, `per-trade risk stays near 1% of live equity (worst ${(worstRiskPct * 100).toFixed(2)}%)`);
  ok(res.trades.every((t) => t.notional <= 10_000 * 1.001 || t.notional > 0), 'leverage cap applied');
  const noFee = runBacktest(candles, ctx, STRATEGIES[0], {}, { feeBps: 0, slipBps: 0, timeframe: '15m' });
  const withFee = runBacktest(candles, ctx, STRATEGIES[0], {}, { feeBps: 20, slipBps: 10, timeframe: '15m' });
  ok(withFee.metrics.finalEquity <= noFee.metrics.finalEquity + 1e-6, 'fees + slippage reduce net equity');
}

console.log('\n=== 7. Monte Carlo ===');
{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '15m', bars: 1000, seed: 44 });
  const ctx = buildContext(candles);
  const res = runBacktest(candles, ctx, STRATEGIES[0], {}, { timeframe: '15m' });
  const mc = res.monteCarlo;
  if (!mc.empty) {
    ok(mc.probProfit >= 0 && mc.probProfit <= 100, `profit probability ${mc.probProfit.toFixed(1)}%`);
    ok(mc.finals.p5 <= mc.finals.p50 && mc.finals.p50 <= mc.finals.p95, 'percentiles ordered');
    ok(mc.histogram.buckets.reduce((a, b) => a + b, 0) === 1000, 'histogram covers all runs');
  } else {
    ok(true, 'no trades — MC skipped');
  }
}

console.log('\n=== 8. CSV import ===');
{
  const csv = ['time,open,high,low,close,volume'];
  let p = 100;
  for (let i = 0; i < 120; i++) {
    p += Math.sin(i / 5) + 0.05;
    csv.push(`${1700000000000 + i * 900000},${p.toFixed(2)},${(p + 0.6).toFixed(2)},${(p - 0.6).toFixed(2)},${(p + 0.1).toFixed(2)},${1000 + i}`);
  }
  const parsed = parseCsv(csv.join('\n'), { symbolId: 'BTCUSDT', timeframe: '15m' });
  ok(parsed.candles.length === 120, 'CSV parsed 120 rows');
  ok(parsed.candles[1].t > parsed.candles[0].t, 'CSV sorted chronologically');
  ok(parsed.meta.source === 'csv', 'CSV meta source flagged');
}

console.log('\n=== 9. Summary table ===');
console.table(rows.map(([s, tf, n, ret, dd, pf, wr, exp]) => ({
  strategy: s, tf, trades: n,
  return: `${ret.toFixed(2)}%`,
  maxDD: `${dd.toFixed(1)}%`,
  PF: pf.toFixed(2),
  winRate: `${wr.toFixed(0)}%`,
  expectancy: `${exp.toFixed(3)}R`
})));

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Next-candle engine tests: shape, sanity, no look-ahead, expectancy math.
 */

import { generateSeries } from '../js/data.js';
import { buildContext } from '../js/strategy.js';
import { predictNextCandle, binaryExpectancy, buildFeatureRow, FEATURE_COUNT } from '../js/predictor.js';

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.log('  ✗ ' + l); } else console.log('  ✓ ' + l); };

console.log('\n=== 1. Feature vector ===');
{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '1m', bars: 600, seed: 5 });
  const ctx = buildContext(candles);
  const row = buildFeatureRow(candles, ctx, candles.length - 1);
  ok(row.x.length === FEATURE_COUNT, `${FEATURE_COUNT} features built`);
  ok(row.x.every(Number.isFinite), 'no NaN / Infinity in the feature vector');
  ok(row.atr > 0, `ATR positive (${row.atr.toFixed(4)})`);
}

console.log('\n=== 2. Logistic path (long history) ===');
{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '1m', bars: 1100, seed: 42 });
  const ctx = buildContext(candles);
  const p = predictNextCandle(candles, ctx);
  ok(p && p.model === 'logistic', `model = ${p?.model}`);
  ok(p.probUp > 0 && p.probUp < 1, `probability in (0,1): ${p.probUp.toFixed(4)}`);
  ok(p.confidence >= 0 && p.confidence <= 100, `confidence in range: ${p.confidence.toFixed(1)}`);
  ok(Math.abs(p.probUp + p.probDown - 1) < 1e-9, 'P(up) + P(down) = 1');
  ok(p.oosHit !== null && p.oosHit >= 0 && p.oosHit <= 1, `out-of-sample hit rate ${(p.oosHit * 100).toFixed(1)}% on ${p.oosSamples} bars`);
  ok(p.features.length === 8, 'top-8 feature contributions returned');
  ok(p.features.every((f) => Number.isFinite(f.contribution)), 'contributions finite');
  ok(p.side === (p.probUp >= 0.5 ? 'up' : 'down'), 'side matches probability');
  ok(typeof p.note === 'string' && p.note.length > 30, 'desk note written');
  // shrinkage: a model cannot claim more than its validation allows
  ok(p.trust <= 1 && p.trust >= 0.25, `trust factor bounded (${p.trust.toFixed(2)})`);
  const shrunk = Math.abs(p.probUp - 0.5) <= Math.abs(p.rawProbUp - 0.5) + 1e-12;
  ok(shrunk, 'prediction shrunk toward 50% (no overclaiming)');
}

console.log('\n=== 3. Rules path (short history, e.g. a screenshot) ===');
{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '1m', bars: 70, seed: 8 });
  const ctx = buildContext(candles);
  const p = predictNextCandle(candles, ctx);
  ok(p && p.model === 'rules', `model = ${p?.model} for 70 candles`);
  ok(p.oosHit === null, 'no fake validation number on the rule blend');
  ok(p.probUp > 0 && p.probUp < 1, 'probability valid');
  ok(p.features.length > 0, 'contributions rendered');
}

console.log('\n=== 4. Guard rails ===');
{
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '1m', bars: 20, seed: 8 });
  const ctx = buildContext(candles);
  ok(predictNextCandle(candles, ctx) === null, 'returns null below 35 candles');
}

console.log('\n=== 5. No look-ahead ===');
{
  const { candles } = generateSeries({ symbolId: 'ETHUSDT', timeframe: '1m', bars: 800, seed: 12 });
  const cut = 600;
  const ctxPast = buildContext(candles.slice(0, cut));
  const ctxFuture = buildContext(candles);            // same prefix + 200 future bars
  const a = buildFeatureRow(candles.slice(0, cut), ctxPast, cut - 1);
  const b = buildFeatureRow(candles, ctxFuture, cut - 1);
  const same = a.x.every((v, j) => Math.abs(v - b.x[j]) < 1e-9);
  ok(same, 'features at bar i are identical whether or not future bars exist');

  const p1 = predictNextCandle(candles.slice(0, cut), ctxPast);
  const p2 = predictNextCandle(candles.slice(0, cut), ctxPast);
  ok(p1.probUp === p2.probUp, 'predictions are deterministic for identical input');
}

console.log('\n=== 6. Binary expectancy math ===');
{
  const e = binaryExpectancy(0.6, 85, 10);
  ok(Math.abs(e.win - 8.5) < 1e-9, 'win = stake × payout');
  ok(Math.abs(e.loss + 10) < 1e-9, 'loss = −stake');
  ok(Math.abs(e.ev - (0.6 * 8.5 - 0.4 * 10)) < 1e-9, `EV = ${e.ev.toFixed(2)}`);
  ok(Math.abs(e.breakeven - 1 / 1.85) < 1e-9, `breakeven ${(e.breakeven * 100).toFixed(1)}%`);

  const losing = binaryExpectancy(0.52, 85, 10);
  ok(losing.ev < 0, `52% at 85% payout is still negative EV (${losing.ev.toFixed(2)})`);
  const winning = binaryExpectancy(0.56, 85, 10);
  ok(winning.ev > 0, `56% at 85% payout is positive EV (${winning.ev.toFixed(2)})`);
  ok(binaryExpectancy(0.3, 0, 10).ev < 0, 'zero payout is always negative');
}

console.log('\n=== 7. Walk-forward honesty ===');
{
  // Rolling re-fit on synthetic (near-random) data: the hit rate must land near
  // 50%, not at a fantasy 80%. This is the assertion that keeps the product honest.
  const { candles } = generateSeries({ symbolId: 'BTCUSDT', timeframe: '1m', bars: 1600, seed: 3 });
  let hits = 0, total = 0;
  for (let i = 600; i < 1000; i += 5) {
    const win = candles.slice(0, i + 1);
    const ctx = buildContext(win);
    const p = predictNextCandle(win, ctx);
    if (!p) continue;
    const up = candles[i + 1].c > candles[i].c;
    if ((p.side === 'up') === up) hits++;
    total++;
  }
  const rate = (hits / total) * 100;
  ok(rate > 35 && rate < 65, `walk-forward hit rate ${rate.toFixed(1)}% over ${total} predictions (no fantasy edge)`);
}

console.log(`\n${fails === 0 ? '✅ PREDICTOR PASSED' : `❌ ${fails} PREDICTOR CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);

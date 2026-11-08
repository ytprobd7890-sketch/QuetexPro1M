# Quetex Pro 1M — Desk Playbook

The operating manual behind the terminal. Six setups, one risk model, one routine.

---

## 0. First principles

1. **The market pays for asymmetry, not activity.** A 1% risk with a 2R average winner needs only
   ~40% accuracy to compound.
2. **The stop defines the trade.** If the structural invalidation is too far for the target to pay
   2R, there is no trade — the setup does not become valid because you want it to.
3. **Regime beats signal.** The same signal is A-grade in a trending London session and a coin flip
   in a compressed Asian range. The engine grades regimes for a reason.
4. **You are trading a distribution.** Any single result is noise. Judge the process over 30+ trades.
5. **Survival first.** The account that survives the 5th-percentile Monte Carlo path gets to compound.

---

## 1. The five-factor confluence

| Factor | Weight | Bullish reading | Bearish reading |
|---|---|---|---|
| Trend structure | 30% | EMA20 > EMA50 > EMA200, 50-EMA sloping up in ATR units | The mirror |
| Range structure | 22% | Price in the top third of the 20-bar range, or a clean break of it | Bottom third / break down |
| Momentum | 22% | RSI 50–70 with MACD histogram positive and rising | RSI 30–50, histogram negative and falling |
| VWAP | 14% | Price holding above session VWAP | Holding below |
| Participation | 12% | Volume ≥ 20-bar average on the signal bar | Thin volume |

**Grading**

| Grade | Condition | Action |
|---|---|---|
| A | Confidence ≥ 65 and ≥ 6 of 8 checks | Full plan size |
| B | Confidence ≥ 45 and ≥ 4 checks | 50–60% size, tighter management |
| — | Otherwise | No trade |

A "no trade" is a position. Cash has zero drawdown.

---

## 2. The six setups

### 2.1 EMA Pullback Continuation — *trend, 5m–1h*
**Thesis:** trend is the edge, the pullback is the entry timing. You are buying a discount inside an
uptrend, not predicting a reversal.

- **Trigger:** EMA20 > EMA50 > EMA200; the prior bar tags the 20 EMA; the current bar closes back
  above it, green, with RSI ≥ 50.
- **Stop:** 1.6 × ATR below entry (below the pullback low).
- **Target:** 2R, trail with 2 × ATR once +1R is banked.
- **Invalidation:** a close back under the 50 EMA, or the EMA stack flattening into compression.
- **Failure mode:** entering on the third or fourth consecutive tag. First pullback after a range
  break is the highest-quality one.

### 2.2 Donchian Breakout + Volume — *breakout, 15m–4h*
**Thesis:** expansion out of a 20-bar range only pays when it is sponsored by volume and aligned
with the higher-timeframe trend.

- **Trigger:** close beyond the prior 20-bar extreme, volume ≥ 1.25× the 20-bar average,
  EMA50 on the correct side of EMA200.
- **Stop:** 1.8 × ATR. **Target:** 2.5R, trail 2.2 × ATR.
- **Invalidation:** price closes back inside the range within three bars — the break failed; wait
  for a new range.
- **Failure mode:** chasing the third push after the break. The first retest that holds is the trade.

### 2.3 RSI Band Reversion — *mean reversion, 5m–15m*
**Thesis:** fade exhaustion into the 2σ band when momentum turns, but only in a non-trending,
non-shock regime.

- **Trigger:** RSI crosses back above 30 (below 70 for shorts); price closed outside the band on the
  signal bar; ATR percentile < 0.85.
- **Stop:** 2 × ATR. **Target:** the 20-period mean, capped at 4 × ATR.
- **Invalidation:** a second close outside the band with rising ATR — step aside.
- **Failure mode:** fading a trend. This model is the first to die in a directional tape; the regime
  filter is not optional.

### 2.4 MACD Momentum Shift — *momentum, 15m–4h*
**Thesis:** slower confirmation, fewer trades, cleaner trends.

- **Trigger:** histogram flips positive with the MACD line above zero, price above a rising 200 EMA,
  ATR percentile < 0.9.
- **Stop:** 2 × ATR. **Target:** 2.2R, trail 2.4 × ATR.
- **Invalidation:** histogram flips back against the position.
- **Failure mode:** taking it in a flat 200 EMA. Rising slope is part of the trigger.

### 2.5 Supertrend Flip — *trend following, 15m–4h*
**Thesis:** systematic trend capture. The trail does the work; you do not need to be right often.

- **Trigger:** Supertrend(10, 3) flips in the direction of the 200 EMA, ATR above its 40-bar median.
- **Stop:** 2 × ATR. **Target:** 3R with a 1.8 × ATR trail, 120-bar time stop.
- **Invalidation:** flip back across the Supertrend line.
- **Failure mode:** taking the flip in dead volatility — whipsaw. The median-ATR filter exists for this.

### 2.6 VWAP Reclaim Scalp — *intraday, 1m–5m*
**Thesis:** the 1-minute workhorse. Price loses VWAP, bases, then reclaims it with short-term trend
agreement; you are trading the return of control to the buyers.

- **Trigger:** close crosses from below session VWAP to above it; EMA20 > EMA50; RSI 45–70; inside
  06:00–21:00 UTC.
- **Stop:** 1.1 × ATR. **Target:** 1.5R, 12-bar time stop, exit on a close back under the 20 EMA.
- **Invalidation:** a 1-minute close back below VWAP within three bars.
- **Failure mode:** scalping the session open before VWAP has any meaning. Wait for the first hour
  to build the volume profile.

---

## 2.7 The 1-minute desk (binary / fixed-time)

The 1M Edge tab predicts the **next** candle (close vs previous close) — exactly what a
"Higher/Lower, 1 minute" contract settles on. Rules for trading it:

1. **Breakeven first.** At an 85% payout you need **54.1%** accuracy just to break even
   (`1 / 1.85`). The app prints this next to the model's probability; if EV is negative, the
   correct position is no position.
2. **Only trade A-grade.** Edge ≥ 5 probability points *and* positive EV *and* the out-of-sample
   hit rate above breakeven. Everything else is entertainment.
3. **Flat stake, never martingale.** Seven doublings from 10 is 1,270 — and a seven-loss run is
   practically guaranteed over a few hundred trades.
4. **Three trades a day, −2R stops the desk.** The edge, if any, is in selectivity.
5. **Verify the read.** After uploading a screenshot, check the green/red boxes sit on the actual
   candles before you trust a number.
6. **Log every call** in the session record, including the ones you skipped. The hit rate you
   measure beats the hit rate you remember.

---

## 3. Position sizing

```
riskAmount = equity × riskPct
stopDist   = |entry − stop|
qty        = riskAmount / stopDist
notional   = qty × entry
leverage   = notional / equity        ← an output, capped, never a target
```

Worked example — BTC at 68,000, ATR(14) on 15m = 260, 1.6 × ATR stop = 416 points, 10,000 account,
1% risk:

```
riskAmount = 100
qty        = 100 / 416 = 0.2404 BTC
notional   = 16,347          → 1.63× leverage
loss if stopped = 100 (−1%)
profit at 2R    = 200 (+2%)
```

If that leverage exceeds your cap, **reduce risk**, do not widen the stop.

---

## 4. Session map (UTC)

| Window | Session | Quality | Bias |
|---|---|---|---|
| 00:00–06:00 | Asia / Tokyo | Moderate | Range. Fade extremes, half size. |
| 06:00–11:00 | London | High | Breakouts and pullbacks both work after 07:00. |
| 11:00–16:00 | London / New York overlap | Highest | Peak liquidity. Best follow-through — full size. |
| 16:00–21:00 | New York | High | Trend continuation; watch 19:00 reversals. |
| 21:00–24:00 | Late NY / Sydney | Low | No fresh breakout risk. |

Weekends: FX and metals thin out (the simulator damps them to 22%). Crypto keeps trading but with
lower participation — treat breakout signals there as B-grade.

---

## 5. Trade management

- **Entry:** at the open of the bar after the signal, or on a limit at the pullback level. If price
  runs more than 0.5 × ATR past the signal close, the trade is gone — do not chase.
- **+1R:** stop to breakeven, then trail at 2 × ATR from the extreme. Never move a stop against you.
- **+2R:** take partial (50%) on trend models; let the rest run to the trail.
- **Time stop:** if the setup has not moved 1R in 12–20 bars, the thesis is stale — exit flat.
- **Correlation:** BTC/ETH/SOL count as one position for the 3% concurrent risk cap.

---

## 6. Daily routine

**Before the session**
1. Mark the higher-timeframe bias: daily/4h 200 EMA and the previous session high/low.
2. Mark the 20-bar range and the VWAP anchor. These are the only levels that matter early.
3. Check the calendar: CPI, FOMC, NFP, and the token-specific unlocks. Shocks invalidate technicals.

**During**
4. Set alerts at the levels. Take the first A-setup; skip the middle of the range.
5. Log every trade as it closes: screenshot, setup name, R outcome, whether you followed the plan.

**After**
6. Stop at −2R or three losses. Close the platform — revenge trading is a strategy with negative
   expectancy and infinite size.
7. Weekly: review 20 trades. If expectancy < 0 after 40 trades on one model, retire it. Do not
   "improve" it by adding filters derived from the same data.

---

## 7. Journal template

| Field | Example |
|---|---|
| Date / session | 2026-03-14, London |
| Symbol / TF | BTCUSDT 15m |
| Setup | EMA Pullback Continuation |
| Grade | A (7/8 checks, conf 71) |
| Entry / stop / target | 68,120 / 67,704 / 68,952 |
| Size | 0.24 BTC · 1.63× · 1% risk |
| Outcome | +2.0R, 3h 15m |
| Followed plan? | Yes — partial at 2R, runner trailed out at 2.4R |
| Note | Third tag would have been a skip; first pullback after range break |

---

## 8. Known failure modes

| Symptom | Real cause | Fix |
|---|---|---|
| Win rate 70% but flat equity | Targets too small, losers run | Enforce 2R minimum, trail the winners |
| Great backtest, terrible live | Fees/slippage/spread ignored | Raise costs in the lab until the edge survives |
| Constant small losses | Trading the middle of the range | Only take edges and breaks |
| One huge month then blow-up | Size increased after wins | Fixed fractional risk, always |
| Model works on one symbol only | Curve-fit | Test across symbols and timeframes in the lab |

---

*Research tool. Not investment advice. Validate on your own venue, with your own costs, before
risking capital.*

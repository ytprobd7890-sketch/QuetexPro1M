# Quetex Pro 1M

**A 1-minute confluence trading terminal, strategy lab and backtester in one page.**

Quetex Pro 1M turns raw OHLCV into a structured desk note: trend, structure, momentum, VWAP and
participation are scored against each other, a bias is produced, and the trade plan that follows is
sized off the ATR stop — not off a feeling. Everything that produces a number is testable, and
everything testable is in this repository.

```
npm start        # → http://localhost:8080
npm test         # 6 suites: engine, capture, predictor, PWA, Android, UI smoke
npm run test:deep # 269-check deep audit: reference math, invariants, fuzz, security, perf
```

No build step, no framework, no charting library. Plain ES modules + canvas.

---

## What you get

### 0. 1M Edge — next-candle engine (mobile first)

The default tab answers one question: **what does the next 1-minute candle do?**

| Input | How | Where it works |
|---|---|---|
| **Live** | Binance 1m klines, polled every 4 s, countdown to the close | Any browser (falls back to a clearly-labelled demo tape if the venue is blocked) |
| **Capture** | Screenshot of your broker chart → pixel analysis recovers the candles | Mobile ✅ · Desktop ✅ |
| **Tab share** | `getDisplayMedia` grabs a frame of the broker tab | Desktop only — **mobile browsers do not implement it** |
| **Share sheet** | Install the PWA, then Share any screenshot → Quetex 1M | Android ✅ (2 taps, crop remembered) |
| **Auto-capture** | Desktop: share the tab once, frames re-read every 6 s | Desktop ✅ · Android via `android/` shell |
| **Camera / paste** | Rear camera or clipboard image | Everywhere |
| **Paste** | `open,high,low,close` lines | Everywhere |

The engine scores 14 scale-free features with a logistic regression trained walk-forward
(70% train / 30% out-of-sample holdout), then **shrinks the prediction toward 50% by the measured
trust factor** — a model that validated at coin-flip cannot shout. Under ~80 candles it falls back to
a transparent rule blend and says so. It also shows the binary-options math live: breakeven hit rate,
EV per trade, and a red warning when the bet is mathematically losing.

📖 **বাংলায় সম্পূর্ণ গাইড: [`docs/1M-EDGE-BN.md`](docs/1M-EDGE-BN.md)**  
🔍 **Why iframes can't do this, and what a backend browser would really cost:
[`docs/MOBILE-CAPTURE.md`](docs/MOBILE-CAPTURE.md)**

### 1. Terminal
- Candlestick chart with EMA 20/50/200, session VWAP, Bollinger bands and Supertrend overlays,
  volume, and an RSI or MACD sub-pane. Scroll to zoom, drag to pan, crosshair with OHLC readout.
- **Signal engine** — a weighted five-factor confluence score, a confidence figure, the market
  regime (trend / volatility / session), a full trade plan (entry, pullback level, stop, TP1–TP3),
  and position sizing for your account and risk budget.
- **Pre-trade checklist** — the eight conditions that must line up before the setup is an A-grade.
- Desk note written from the regime, the checks passed and the participation level.

### 2. Backtest Lab
- Six complete strategies, each with parameters, stop model and exit logic.
- Event-driven engine: signal on bar close, fill on next bar open, intrabar stop/target with
  stop-first resolution, per-side fees and slippage, leverage and short-selling caps.
- 12 KPIs, equity curve, drawdown curve, trade log and a 1,000-path **Monte Carlo** resample of the
  trade distribution (profit probability, 5–95% ending equity band, drawdown percentiles).

### 3. Strategy Playbook
- The rules, best timeframes and invalidation for every model.
- The risk model, the session map and the daily routine.

---

## Data sources

| Source | Provider | Symbols | Notes |
|---|---|---|---|
| **Live** | Binance public REST (`data-api.binance.vision`, fallback `api.binance.com`) | BTC, ETH, SOL, BNB vs USDT | Browser-side fetch, CORS-enabled, up to 1,000 bars |
| **Simulated** | Built-in generator | All symbols | Deterministic per seed: regime-switching drift, GARCH-style volatility clustering, session seasonality, fat-tailed wicks, weekend damping for FX/metals |
| **CSV** | Your file | Anything | Headers `time,open,high,low,close,volume` (aliases accepted), epoch ms/s or ISO dates |

The terminal defaults to **Auto**: it tries the live feed, and falls back to the simulated tape if the
venue is unreachable or blocked in your region. The status pill always tells you which one you are
looking at — never analyse a simulated tape thinking it is live.

---

## The method

Five factors, each scored −100…+100, combined by weight:

| Factor | Weight | What it measures |
|---|---|---|
| Trend structure | 30% | EMA20/50/200 stack + 50-EMA slope in ATR units |
| Range structure | 22% | Position inside the 20-bar Donchian range, breakouts |
| Momentum | 22% | RSI level, MACD histogram sign and acceleration |
| VWAP position | 14% | Distance from session VWAP, normalised by ATR |
| Participation | 12% | Volume versus its 20-bar average, signed by structure |

**Score** → direction (long ≥ +18, short ≤ −18). **Confidence** → |score| damped for hostile regime
(range, expanding volatility, off-hours session).

**Grade**: A-setup needs confidence ≥ 65 and at least 6 of 8 checks. B-setup ≥ 45 and 4 checks —
execute at reduced size. Anything else is no trade.

### Risk model
- 1% of live equity per trade (0.5% when ATR percentile > 0.8 or the session is off-hours).
- Stop = structural ATR distance (1.5–2.0×), never widened after entry.
- Targets 1R / 2R / 3R, or the 20-period mean for mean reversion.
- Position size **derived** from the stop distance: `qty = (equity × risk) / stopDistance`.
  Leverage is an output, capped by the account setting.
- Daily circuit-breaker: −2R stops the desk for the day.

---

## Backtest methodology

| Concern | How it is handled |
|---|---|
| Look-ahead | Signals are read on the close of bar *i*, filled at the open of *i+1*. Trailing stops use the prior bar's ATR. |
| Intrabar ambiguity | If a bar touches both stop and target, the **stop** is assumed first (conservative). Gaps fill at the open, not at the stop. |
| Costs | Fee in basis points per side + slippage against every fill. Both are visible in the UI. |
| Sizing | Risk-based, compounding, capped by max leverage. |
| Survival | Monte Carlo bootstraps the realised R-multiples 1,000 times to show the distribution of outcomes, not a single lucky path. |
| Honesty | Strategies are not curve-fitted to one symbol. Expect a mix of winners and losers — that is the point. |

> A backtest is a hypothesis test, not a forecast. Fees, funding, spreads and slippage on the real
> venue are usually worse than the model. Forward-test on small size before anything else.

---

## Reading the metrics

- **Profit factor** — gross wins ÷ gross losses. Below 1.2 is not a business; above 1.5 is interesting if the sample is >100 trades.
- **Expectancy (R)** — average R per trade. This, not win rate, is the engine of the account.
- **Max drawdown** — the number that decides whether you can actually trade the model. If you cannot sit through it, you cannot harvest the edge.
- **Sharpe / Sortino** — bar-level risk-adjusted return, annualised for the timeframe. Across 20–40 trades these are noisy; use them to compare models, not to certify one.
- **Exposure** — time in market. Low exposure with high expectancy means patience is doing the work.
- **Alpha vs HODL** — does the model add anything over simply holding the asset? If not, the edge is beta, not skill.
- **Monte Carlo band** — the 5th percentile is the "bad but plausible" outcome. Size the account so that outcome is survivable.

---

## Project structure

```
index.html            shell, panels, labels
css/styles.css        design system (dark desk theme, responsive)
js/app.js             state, wiring, rendering
js/data.js            live / simulated / CSV providers + symbol profiles
js/indicators.js      SMA, EMA, RSI, ATR, MACD, Bollinger, Donchian, VWAP, Supertrend
js/strategy.js        six strategies + weighted confluence engine
js/backtest.js        event-driven engine, metrics, Monte Carlo
js/chart.js           canvas candlestick, line and histogram renderers
js/predictor.js       next-candle engine (logistic + rule blend + binary EV)
js/capture.js         screenshot → OHLC pixel reader
js/edge.js            1M Edge tab controller (live feed, capture, auto-capture, session log)
tests/smoke.mjs       data / indicator / strategy / backtest assertions
tests/capture.mjs     candle extraction from synthetic screenshots
tests/predictor.mjs   next-candle engine, look-ahead and EV math
tests/android.mjs     Android shell wiring (manifest, service, resources, bridge)
tests/pwa.mjs         manifest, service worker, share-target, icons
tests/deep.mjs        deep audit: indicators vs naive refs, backtest invariants, CSV fuzz, server security
tests/ui.mjs          full DOM boot inside jsdom
docs/PLAYBOOK.md      the desk manual
android/              MediaProjection capture shell (Kotlin, build with Android Studio)
server.js             static server (0.0.0.0, no dependencies)
```

### Adding a strategy

Append an object to `STRATEGIES` in `js/strategy.js`:

```js
{
  id: 'my-setup', name: 'My Setup', tag: 'Trend', bestTf: '15m',
  summary: 'one paragraph', rules: ['...'], invalidation: '...',
  defaults: { stopAtr: 1.8, targetR: 2.5, trailAtr: 0 },
  params: [{ key: 'stopAtr', label: 'Stop (× ATR)', min: 0.8, max: 4, step: 0.1 }],
  entry(ctx, i, p) { return 0; },          // 1 long, -1 short, 0 flat
  exit(ctx, i, p, pos) { return false; },   // optional
  risk(ctx, i, side, p) { return null; }    // optional { stop, target } override
}
```

It appears in the selector, the backtester and the playbook automatically — and `npm test` will
exercise it against every timeframe.

---

## Honest limits of the 1-minute engine

- A one-minute candle is close to a coin flip. Any edge is thin, regime-dependent and can vanish.
- The pixel reader needs **green/red candles with a visible gap between them**. White/blue candles,
  line charts and fully touching candles are rejected with a message instead of a guess.
- Mobile browsers cannot capture a tab (`getDisplayMedia` is unavailable on Chrome Android and iOS
  Safari). Install the PWA and use the Android **share sheet**, or upload/paste — same pipeline.
- An `<iframe>` around a broker page cannot work: the brokers block framing (`X-Frame-Options`/CSP)
  and cross-origin frames expose neither DOM nor pixels. See `docs/MOBILE-CAPTURE.md`.
- Backtests and probabilities are computed locally from the data you feed in. Nothing is sent
  anywhere, and no broker account is ever connected.

## Disclaimer

Quetex Pro 1M is an analysis and research tool. Nothing in this repository is investment advice or a
solicitation to trade. Markets can and will exceed every backtested drawdown. Past performance is
not indicative of future results. Use at your own risk.

MIT © 2026 Ytt P

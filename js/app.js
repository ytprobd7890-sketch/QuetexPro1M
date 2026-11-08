/**
 * Quetex Pro 1M — application shell
 * Wires data → context → confluence analysis → chart + backtest UI.
 */

import {
  TIMEFRAMES, SYMBOLS, getSymbol, generateSeries, fetchBinanceKlines, parseCsv
} from './data.js';
import { buildContext, STRATEGIES, getStrategy, analyze, WARMUP } from './strategy.js';
import { runBacktest, DEFAULT_CFG } from './backtest.js';
import { PriceChart, LineChart, HistogramChart } from './chart.js';
import {
  fmt, fmtPrice, fmtPct, fmtMoney, fmtCompact, fmtTime, fmtDate,
  sessionName, clamp
} from './utils.js';

const $ = (id) => document.getElementById(id);

const state = {
  symbol: 'BTCUSDT',
  timeframe: '15m',
  bars: 600,
  seed: 42,
  source: 'auto',
  candles: [],
  meta: null,
  ctx: null,
  overlays: { ema20: true, ema50: true, ema200: true, vwap: true, bb: false, st: false },
  sub: 'rsi',
  account: 10_000,
  riskPct: 1,
  strategyId: 'ema-pullback',
  params: {},
  cfg: { ...DEFAULT_CFG },
  result: null,
  analysis: null
};

let priceChart, equityChart, ddChart, mcChart;

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  // selects
  $('symbol-select').innerHTML = SYMBOLS.map(
    (s) => `<option value="${s.id}">${s.label}</option>`
  ).join('');
  $('tf-select').innerHTML = Object.entries(TIMEFRAMES).map(
    ([k, v]) => `<option value="${k}">${v.label}</option>`
  ).join('');

  $('symbol-select').value = state.symbol;
  $('tf-select').value = state.timeframe;

  // charts
  priceChart = new PriceChart($('price-chart'));
  equityChart = new LineChart($('equity-chart'), { color: '#2ee6a8', currency: '$' });
  ddChart = new LineChart($('dd-chart'), { color: '#ff5d6c', currency: '%', fill: true, baseline: 0 });
  mcChart = new HistogramChart($('mc-chart'));

  buildOverlayToggles();
  buildStrategyUI();
  renderPlaybook();
  bindEvents();

  const s = sessionName(Date.now());
  $('session-pill').innerHTML = `Session <strong>${s.name}</strong> · ${s.quality}`;

  loadData();
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('symbol-select').addEventListener('change', (e) => {
    state.symbol = e.target.value;
    state.params = {};
    loadData();
  });
  $('tf-select').addEventListener('change', (e) => {
    state.timeframe = e.target.value;
    loadData();
  });
  $('source-select').addEventListener('change', (e) => {
    state.source = e.target.value;
    loadData();
  });
  $('bars-select').addEventListener('change', (e) => {
    state.bars = Number(e.target.value);
    loadData();
  });
  $('load-btn').addEventListener('click', () => loadData());
  $('seed-btn').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 99_999) + 1;
    loadData({ forceSim: true });
  });

  $('csv-btn').addEventListener('click', () => $('csv-input').click());
  $('csv-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseCsv(text, { symbolId: state.symbol, timeframe: state.timeframe });
      applyData(parsed);
      setStatus('sim', `CSV imported · ${parsed.candles.length} bars from ${file.name}`);
    } catch (err) {
      setStatus('error', `CSV import failed: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
      requestAnimationFrame(() => {
        priceChart?.draw();
        equityChart?.draw();
        ddChart?.draw();
        mcChart?.draw();
      });
    });
  });

  document.querySelectorAll('#sub-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#sub-toggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.sub = b.dataset.sub;
      priceChart.setData({ sub: state.sub });
    });
  });

  const acct = $('acct-input');
  const risk = $('risk-input');
  acct.value = String(state.account);
  risk.value = String(state.riskPct);
  const onRisk = () => {
    state.account = Math.max(1, Number(acct.value) || 10_000);
    state.riskPct = clamp(Number(risk.value) || 1, 0.1, 10);
    if (state.analysis) renderSignal(state.analysis);
  };
  acct.addEventListener('input', onRisk);
  risk.addEventListener('input', onRisk);

  $('copy-plan').addEventListener('click', copyPlan);
  $('jump-backtest').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="backtest"]').click();
    runAndRender();
  });

  $('strategy-select').addEventListener('change', (e) => {
    state.strategyId = e.target.value;
    state.params = {};
    buildStrategyUI();
    runAndRender();
  });

  $('run-btn').addEventListener('click', runAndRender);
}

function setStatus(kind, text) {
  const el = $('status');
  el.className = 'status ' + (kind || '');
  $('status-text').textContent = text;
}

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

async function loadData({ forceSim = false } = {}) {
  setStatus('', 'Loading market data…');
  const sym = getSymbol(state.symbol);
  let payload = null;

  if (!forceSim && state.source !== 'sim' && sym.binance) {
    try {
      payload = await fetchBinanceKlines(state.symbol, state.timeframe, state.bars);
    } catch (err) {
      if (state.source === 'live') {
        setStatus('error', `Live feed blocked (${err.message}) — falling back to simulated tape`);
      }
    }
  }

  if (!payload) {
    payload = generateSeries({
      symbolId: state.symbol,
      timeframe: state.timeframe,
      bars: state.bars,
      seed: state.seed
    });
  }

  applyData(payload);

  const src = payload.meta.source;
  setStatus(src, src === 'live'
    ? `LIVE · Binance ${state.timeframe} · ${payload.candles.length} bars`
    : `SIMULATED · ${TIMEFRAMES[state.timeframe].label} · seed ${state.seed}`);
}

function applyData({ candles, meta }) {
  const m = meta;
  state.candles = candles;
  state.meta = m;
  state.ctx = buildContext(candles);

  $('data-credit').textContent = `${m.label || m.symbol} · ${m.timeframe} · ${m.note || ''}`;

  renderHeader();
  renderChart();
  renderAnalysis();
  runAndRender();
}

function renderHeader() {
  const m = state.meta;
  const c = state.candles;
  if (!m || !c.length) return;
  const last = c[c.length - 1];
  const prev = c[c.length - 2] || last;
  const chg = ((last.c - prev.c) / prev.c) * 100;
  const dayAgo = c[Math.max(0, c.length - 30)] || c[0];
  const chg30 = ((last.c - dayAgo.c) / dayAgo.c) * 100;

  $('pair-title').textContent = m.label || m.symbol;
  $('pair-meta').textContent = `${m.timeframe} · ${c.length} bars · ${m.source === 'live' ? 'live feed' : m.source === 'csv' ? 'CSV import' : 'simulated'}`;
  $('last-price').textContent = `${m.currency || ''}${fmtPrice(last.c, m.digits)}`;
  const el = $('last-change');
  el.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% · 30b ${chg30 >= 0 ? '+' : ''}${chg30.toFixed(2)}%`;
  el.style.color = chg >= 0 ? 'var(--up)' : 'var(--down)';
}

function renderChart() {
  if (!state.meta) return;
  priceChart.setData({
    candles: state.candles,
    ctx: state.ctx,
    overlays: state.overlays,
    sub: state.sub,
    trades: state.result?.trades || [],
    digits: state.meta.digits,
    timeframe: state.meta.timeframe,
    symbol: state.meta.label
  });
}

function buildOverlayToggles() {
  const defs = [
    ['ema20', 'EMA20'], ['ema50', 'EMA50'], ['ema200', 'EMA200'],
    ['vwap', 'VWAP'], ['bb', 'BB(20,2)'], ['st', 'ST(10,3)']
  ];
  const host = $('overlay-toggles');
  host.innerHTML = defs.map(
    ([k, l]) => `<button data-ov="${k}" class="${state.overlays[k] ? 'on' : ''}">${l}</button>`
  ).join('');
  host.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.ov;
      state.overlays[k] = !state.overlays[k];
      b.classList.toggle('on', state.overlays[k]);
      priceChart.setData({ overlays: state.overlays });
    });
  });
}

/* ------------------------------------------------------------------ */
/* confluence panel                                                    */
/* ------------------------------------------------------------------ */

function renderAnalysis() {
  if (!state.ctx) return;
  const i = state.candles.length - 1;
  const a = analyze(state.ctx, i);
  state.analysis = a;
  renderSignal(a);
}

function renderSignal(a) {
  const m = state.meta;
  const d = m.digits;

  const biasEl = $('bias');
  biasEl.textContent = a.side === 'long' ? 'LONG BIAS' : a.side === 'short' ? 'SHORT BIAS' : 'NO TRADE';
  biasEl.className = 'bias ' + (a.side === 'long' ? 'long' : a.side === 'short' ? 'short' : '');

  $('conf-value').textContent = `${Math.round(a.confidence)}`;
  const fill = $('conf-fill');
  fill.style.width = `${clamp(a.confidence, 0, 100)}%`;
  fill.style.background = a.side === 'short'
    ? 'linear-gradient(90deg, #ffb85c, #ff5d6c)'
    : 'linear-gradient(90deg, #ffb85c, #2ee6a8)';

  $('analysis-time').textContent = fmtTime(a.time, m.timeframe);

  $('regime-chips').innerHTML = [
    `<span class="chip ${a.regime.trend === 'Uptrend' ? 'up' : a.regime.trend === 'Downtrend' ? 'down' : 'warn'}">${a.regime.trend}</span>`,
    `<span class="chip ${a.regime.vol === 'Expanding' ? 'warn' : ''}">Vol ${a.regime.vol}</span>`,
    `<span class="chip">ATR ${a.regime.atrPct.toFixed(2)}%</span>`,
    `<span class="chip ${a.regime.sessionQuality === 'Highest' || a.regime.sessionQuality === 'High' ? 'up' : 'warn'}">${a.regime.session}</span>`
  ].join('');

  $('verdict').innerHTML = `<strong style="color:var(--text)">${a.verdict}</strong> · score ${a.score > 0 ? '+' : ''}${a.score.toFixed(0)} · ${a.passed}/${a.totalChecks} checks`;

  const neutral = a.side === 'neutral';
  const px = (v) => `${m.currency || ''}${fmtPrice(v, d)}`;
  $('plan-entry').textContent = px(a.plan.entry);
  $('plan-pullback').textContent = px(a.plan.pullback);
  $('plan-stop').textContent = neutral ? '—' : px(a.plan.stop);
  $('plan-tp1').textContent = neutral ? '—' : fmtPrice(a.plan.tp1, d);
  $('plan-tp2').textContent = neutral ? '—' : fmtPrice(a.plan.tp2, d);
  $('plan-tp3').textContent = neutral ? '—' : fmtPrice(a.plan.tp3, d);
  $('plan-stopdist').textContent = neutral
    ? 'waiting for alignment'
    : `${fmt(a.plan.risk, d)} (${a.plan.stopPct.toFixed(2)}%)`;

  const qty = !neutral && a.plan.risk > 0 ? (state.account * state.riskPct / 100) / a.plan.risk : 0;
  const notional = qty * a.plan.entry;
  $('size-qty').textContent = qty > 0 ? `${fmtCompact(qty)} ${baseAsset(m.symbol)}` : '—';
  $('size-notional').textContent = notional > 0 ? `${m.currency || ''}${fmtCompact(notional)}` : '—';
  $('size-risk').textContent = qty > 0 ? `${m.currency || ''}${fmt(a.plan.risk * qty, 2)} (${state.riskPct}%)` : '—';
  $('size-lev').textContent = notional > 0 ? `${(notional / state.account).toFixed(2)}×` : '—';

  $('desk-note').textContent = a.note;

  // components
  $('components').innerHTML = a.components.map((c) => {
    const w = Math.min(50, Math.abs(c.score) / 2);
    const left = c.score >= 0 ? 50 : 50 - w;
    const color = c.score >= 0 ? 'var(--up)' : 'var(--down)';
    return `
      <div class="comp">
        <div class="comp-top"><span>${c.label} <small style="color:var(--muted-2)">${(c.weight * 100).toFixed(0)}%</small></span>
          <span style="color:${color}">${c.score > 0 ? '+' : ''}${c.score.toFixed(0)}</span></div>
        <div class="comp-bar"><i style="left:${left}%;width:${w}%;background:${color};opacity:.75"></i></div>
        <div class="comp-detail">${c.detail}</div>
      </div>`;
  }).join('');

  // checklist
  $('check-count').textContent = `${a.passed}/${a.totalChecks}`;
  $('checklist').innerHTML = a.checklist.map((c) => `
    <li class="${c.ok ? 'ok' : 'no'}">
      <span class="tick">${c.ok ? '✓' : '✕'}</span>
      <div><b>${c.label}</b><small>${c.detail}</small></div>
    </li>`).join('');
}

function baseAsset(symbol) {
  if (!symbol) return '';
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  if (symbol.endsWith('USD')) return symbol.slice(0, -3);
  return symbol;
}

async function copyPlan() {
  const a = state.analysis;
  if (!a) return;
  const m = state.meta;
  const d = m.digits;
  const qty = a.plan.risk > 0 ? (state.account * state.riskPct / 100) / a.plan.risk : 0;
  const text = [
    `QUETEX PRO 1M — ${m.label} ${m.timeframe}`,
    `Signal time: ${fmtTime(a.time, m.timeframe)}`,
    `Bias: ${a.bias} (score ${a.score.toFixed(0)}, confluence ${a.confidence.toFixed(0)}%)`,
    `Regime: ${a.regime.trend} · vol ${a.regime.vol} · ${a.regime.session}`,
    ``,
    `Entry: ${fmtPrice(a.plan.entry, d)}  (pullback ${fmtPrice(a.plan.pullback, d)})`,
    `Stop:  ${fmtPrice(a.plan.stop, d)}  (${a.plan.stopPct.toFixed(2)}%)`,
    `TP1:   ${fmtPrice(a.plan.tp1, d)}    TP2: ${fmtPrice(a.plan.tp2, d)}    TP3: ${fmtPrice(a.plan.tp3, d)}`,
    `Size:  ${fmt(qty, 4)} ${baseAsset(m.symbol)} · notional ${fmtMoney(qty * a.plan.entry, m.currency || '$', 2)} · risk ${state.riskPct}%`,
    ``,
    `Checks: ${a.passed}/${a.totalChecks} — ${a.verdict}`,
    `Note: ${a.note}`,
    ``,
    `Research output, not investment advice.`
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
    const btn = $('copy-plan');
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch {
    window.prompt('Copy the trade plan:', text);
  }
}

/* ------------------------------------------------------------------ */
/* backtest                                                            */
/* ------------------------------------------------------------------ */

function buildStrategyUI() {
  $('strategy-select').innerHTML = STRATEGIES.map(
    (s) => `<option value="${s.id}">${s.name}</option>`
  ).join('');
  $('strategy-select').value = state.strategyId;

  const strat = getStrategy(state.strategyId);
  $('strategy-blurb').textContent = strat.summary;

  if (!Object.keys(state.params).length) state.params = { ...strat.defaults };

  $('params').innerHTML = strat.params.map((p) => {
    const val = state.params[p.key] ?? strat.defaults[p.key];
    return `
      <div class="param">
        <div class="param-top"><span>${p.label}</span><b data-val="${p.key}">${val}</b></div>
        <input type="range" data-param="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}" />
      </div>`;
  }).join('');

  $('params').querySelectorAll('input[type="range"]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const key = e.target.dataset.param;
      state.params[key] = Number(e.target.value);
      const label = $('params').querySelector(`b[data-val="${key}"]`);
      if (label) label.textContent = e.target.value;
    });
    inp.addEventListener('change', runAndRender);
  });

  $('cfg-capital').value = state.cfg.initialCapital;
  $('cfg-risk').value = state.cfg.riskPct;
  $('cfg-fee').value = state.cfg.feeBps;
  $('cfg-slip').value = state.cfg.slipBps;
  $('cfg-lev').value = state.cfg.maxLeverage;
  $('cfg-short').checked = state.cfg.allowShort;

  ['cfg-capital', 'cfg-risk', 'cfg-fee', 'cfg-slip', 'cfg-lev', 'cfg-short'].forEach((id) => {
    const el = $(id);
    el.onchange = () => {
      state.cfg = {
        initialCapital: Math.max(100, Number($('cfg-capital').value) || 10_000),
        riskPct: clamp(Number($('cfg-risk').value) || 1, 0.1, 10),
        feeBps: Math.max(0, Number($('cfg-fee').value) || 0),
        slipBps: Math.max(0, Number($('cfg-slip').value) || 0),
        maxLeverage: clamp(Number($('cfg-lev').value) || 1, 1, 20),
        allowShort: $('cfg-short').checked
      };
      runAndRender();
    };
  });
}

function runAndRender() {
  if (!state.candles.length || !state.ctx) return;
  const strat = getStrategy(state.strategyId);
  try {
    const result = runBacktest(state.candles, state.ctx, strat, state.params, {
      ...state.cfg,
      timeframe: state.timeframe
    });
    state.result = result;
    renderBacktest(result);
    renderChart();
  } catch (err) {
    console.error(err);
    setStatus('error', `Backtest error: ${err.message}`);
  }
}

function renderBacktest(res) {
  const m = res.metrics;
  const d = state.meta.digits;
  const cur = state.meta.currency || '$';

  const kpis = [
    ['Net P&L', `${m.netProfit >= 0 ? '+' : '-'}${fmtMoney(Math.abs(m.netProfit), cur, 0)}`, `${fmtPct(m.returnPct)} on capital`, m.netProfit >= 0 ? 'pos' : 'neg'],
    ['Max drawdown', `-${fmt(m.maxDD, 2)}%`, `${fmtMoney(m.maxDDAbs, cur, 0)} peak-to-trough`, m.maxDD > 25 ? 'neg' : ''],
    ['Profit factor', fmt(m.profitFactor, 2), `${m.wins}W / ${m.losses}L`, m.profitFactor >= 1.3 ? 'pos' : m.profitFactor < 1 ? 'neg' : ''],
    ['Win rate', `${fmt(m.winRate, 1)}%`, `payoff ${fmt(m.payoff, 2)}`, m.winRate >= 45 ? 'pos' : ''],
    ['Expectancy', `${m.expectancyR >= 0 ? '+' : ''}${fmt(m.expectancyR, 3)}R`, `${m.trades} trades`, m.expectancyR > 0 ? 'pos' : 'neg'],
    ['Sharpe', fmt(m.sharpe, 2), `sortino ${fmt(m.sortino, 2)}`, m.sharpe >= 1 ? 'pos' : ''],
    ['Calmar', fmt(m.calmar, 2), `CAGR ${fmtPct(m.cagr, 1)}`, m.calmar >= 1 ? 'pos' : ''],
    ['Exposure', `${fmt(m.exposure, 0)}%`, `avg ${fmt(m.avgBars, 0)} bars/trade`, ''],
    ['Buy & hold', fmtPct(m.buyHoldPct), `${state.meta.timeframe} window`, m.buyHoldPct >= 0 ? 'pos' : 'neg'],
    ['Alpha vs HODL', fmtPct(m.alpha), m.alpha >= 0 ? 'model is additive' : 'model lags the benchmark', m.alpha >= 0 ? 'pos' : 'neg'],
    ['Best / worst', `${fmtMoney(m.bestTrade, cur, 0)}`, `${fmtMoney(m.worstTrade, cur, 0)}`, ''],
    ['Streaks', `${m.maxWinStreak}W`, `${m.maxLossStreak}L in a row`, '']
  ];

  $('kpi-grid').innerHTML = kpis.map(([label, val, sub, cls]) => `
    <div class="kpi ${cls}">
      <span>${label}</span>
      <strong>${val}</strong>
      <small>${sub}</small>
    </div>`).join('');

  // equity
  const curve = res.equityCurve.slice(res.startIdx);
  equityChart.setData({ series: curve, baseline: state.cfg.initialCapital });

  // drawdown
  let peak = curve[0] || state.cfg.initialCapital;
  const dd = curve.map((v) => {
    if (v > peak) peak = v;
    return -((peak - v) / peak) * 100;
  });
  ddChart.setData({ series: dd, baseline: 0 });

  // monte carlo
  const mc = res.monteCarlo;
  if (mc && !mc.empty) {
    mcChart.setData({ ...mc.histogram, initial: state.cfg.initialCapital });
    $('mc-stamp').textContent = `${mc.runs} runs`;
    $('mc-facts').innerHTML = [
      `Profit probability <b style="color:var(--up)">${fmt(mc.probProfit, 1)}%</b>`,
      `Median ending eq ${fmtMoney(mc.finals.p50, cur, 0)}`,
      `5–95% band ${fmtMoney(mc.finals.p5, cur, 0)} → ${fmtMoney(mc.finals.p95, cur, 0)}`,
      `Median max DD ${fmt(mc.drawdown.p50, 1)}% · 95th ${fmt(mc.drawdown.p95, 1)}%`
    ].join('<br/>');
  } else {
    $('mc-facts').textContent = 'No trades to resample.';
    $('mc-stamp').textContent = '—';
  }

  // trades table
  const rows = res.trades.slice(-250).reverse();
  $('trade-stamp').textContent = `${res.trades.length} trades · fees ${fmtMoney(m.totalFees, cur, 0)}`;
  const tbody = $('trades-table').querySelector('tbody');
  tbody.innerHTML = rows.length ? rows.map((t) => `
    <tr>
      <td class="muted">${t.id}</td>
      <td style="color:${t.side === 'long' ? 'var(--up)' : 'var(--down)'}">${t.side === 'long' ? 'LONG' : 'SHORT'}</td>
      <td>${fmtPrice(t.entry, d)}</td>
      <td>${fmtPrice(t.exit, d)}</td>
      <td class="muted">${t.bars}</td>
      <td class="${t.rMultiple >= 0 ? 'win' : 'loss'}">${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R</td>
      <td class="${t.pnl >= 0 ? 'win' : 'loss'}">${t.pnl >= 0 ? '+' : ''}${fmtMoney(Math.abs(t.pnl), cur, 2)}</td>
      <td class="muted">${t.reason}</td>
      <td class="muted">${fmtTime(t.entryTime, state.timeframe)}</td>
    </tr>`).join('') : '<tr><td colspan="9" class="muted">No trades — the filters did not line up in this window.</td></tr>';
}

/* ------------------------------------------------------------------ */
/* playbook                                                            */
/* ------------------------------------------------------------------ */

function renderPlaybook() {
  $('pb-strategies').innerHTML = STRATEGIES.map((s) => `
    <div class="card pb-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h3>${s.name}</h3>
        <span class="pb-tag">${s.tag}</span>
      </div>
      <p>${s.summary}</p>
      <ul>${s.rules.map((r) => `<li>${r}</li>`).join('')}</ul>
      <div class="pb-meta">Best on ${s.bestTf} · invalidation: ${s.invalidation}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* go                                                                  */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', boot);

/**
 * Quetex Pro 1M — "1M Edge" tab controller
 *
 * Three inputs, one engine:
 *   live      Binance 1-minute klines (polled every 4 s)
 *   capture   screenshot / shared tab → candles via pixel analysis
 *   paste     manual open,high,low,close rows
 *
 * Everything that predicts goes through predictNextCandle() in predictor.js.
 */

import { SYMBOLS, getSymbol, generateSeries, fetchBinanceKlines } from './data.js';
import { buildContext } from './strategy.js';
import { predictNextCandle, binaryExpectancy } from './predictor.js';
import { analyzeCanvas, parseManualCandles } from './capture.js';
import { clamp, fmt, sessionName } from './utils.js';

const $ = (id) => document.getElementById(id);

const E = {
  symbol: 'BTCUSDT',
  candles: [],
  closed: [],
  forming: null,
  ctx: null,
  pred: null,
  live: false,
  mode: 'live',
  lastClosedT: null,
  pollId: null,
  tickId: null,
  busy: false,
  pending: null,
  stake: 10,
  payout: 85,
  session: { calls: 0, wins: 0, losses: 0, streak: 0, best: 0 },
  installPrompt: null,
  cap: {
    src: null, crop: null, dims: null, sens: 1, marks: [], result: null,
    stream: null, video: null, drag: null, autoId: null, autoAnalyze: true
  }
};

let booted = false;

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

export function initEdge() {
  if (booted) return;
  booted = true;

  $('edge-symbol').innerHTML = SYMBOLS.map(
    (s) => `<option value="${s.id}">${s.label}${s.binance ? '' : ' · sim'}</option>`
  ).join('');
  $('edge-symbol').value = E.symbol;

  $('edge-symbol').addEventListener('change', (e) => {
    E.symbol = e.target.value;
    startLive();
  });

  $('stake-input').addEventListener('input', (e) => {
    E.stake = Math.max(1, Number(e.target.value) || 10);
    renderEV();
  });
  $('payout-input').addEventListener('input', (e) => {
    E.payout = clamp(Number(e.target.value) || 85, 1, 200);
    renderEV();
  });

  $('log-call').addEventListener('click', logCall);
  $('reset-session').addEventListener('click', () => {
    E.session = { calls: 0, wins: 0, losses: 0, streak: 0, best: 0 };
    E.pending = null;
    renderSession();
  });

  $('share-tab').addEventListener('click', shareTab);
  $('upload-img').addEventListener('click', () => $('img-input').click());
  $('camera-img').addEventListener('click', () => $('cam-input').click());
  $('img-input').addEventListener('change', onImagePicked);
  $('cam-input').addEventListener('change', onImagePicked);
  $('install-app').addEventListener('click', promptInstall);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    E.installPrompt = e;
    $('install-app').hidden = false;
  });
  document.addEventListener('paste', onPaste);

  // iOS never fires beforeinstallprompt — show the button so the instructions
  // are one tap away instead of buried in a menu.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '');
  if (isIOS && !window.navigator.standalone) $('install-app').hidden = false;
  $('sens').addEventListener('input', (e) => {
    E.cap.sens = Number(e.target.value);
    $('sens-val').textContent = E.cap.sens.toFixed(1);
    if (E.cap.src) analyzeCapture();
  });
  $('cap-analyze').addEventListener('click', () => useCapturedChart());
  $('clear-crop').addEventListener('click', clearSavedCrop);
  $('auto-capture').addEventListener('change', (e) => {
    if (e.target.checked) startAutoCapture();
    else stopAutoCapture();
  });
  $('manual-apply').addEventListener('click', applyManual);

  bindCrop();

  startLive();
  intakeShared();
  E.tickId = setInterval(renderCountdown, 250);

  const s = sessionName(Date.now());
  $('edge-source').textContent = `${s.name}`;
}

/* ------------------------------------------------------------------ */
/* live feed                                                           */
/* ------------------------------------------------------------------ */

function stopTimers() {
  if (E.pollId) { clearInterval(E.pollId); E.pollId = null; }
}

async function startLive() {
  stopTimers();
  E.mode = 'live';
  setSource('loading…', '');
  $('pred-side').className = 'pred-side flat';
  $('pred-side').textContent = '…';
  $('pred-prob').textContent = '—';
  $('pred-sub').textContent = 'loading 1-minute feed';

  const sym = getSymbol(E.symbol);
  let payload = null;

  if (sym.binance) {
    try {
      payload = await fetchBinanceKlines(E.symbol, '1m', 500);
    } catch { /* fall through */ }
  }

  E.live = Boolean(payload);
  if (!payload) {
    payload = generateSeries({ symbolId: E.symbol, timeframe: '1m', bars: 500, seed: 4242 });
  }

  E.candles = payload.candles;
  E.lastClosedT = null;
  E.forming = null;
  E.pending = null;

  onBarUpdate(true);
  setSource(E.live ? 'LIVE' : 'DEMO', E.live ? 'live' : 'warn');

  if (E.live) E.pollId = setInterval(pollLive, 4000);
  else {
    $('pred-note').textContent =
      'Live Binance feed is blocked in this browser/region, so you are looking at a simulated tape. ' +
      'That is useless for real money — use “Upload” with a screenshot of your broker chart instead.';
  }
  renderCountdown();
}

async function pollLive() {
  if (E.busy || !E.live) return;
  E.busy = true;
  try {
    const res = await fetchBinanceKlines(E.symbol, '1m', 3);
    for (const k of res.candles) {
      const i = E.candles.findIndex((c) => c.t === k.t);
      if (i >= 0) E.candles[i] = k;
      else E.candles.push(k);
    }
    E.candles.sort((a, b) => a.t - b.t);
    if (E.candles.length > 520) E.candles = E.candles.slice(-520);
    onBarUpdate();
  } catch {
    setSource('feed error', 'error');
  } finally {
    E.busy = false;
  }
}

function splitClosed(candles) {
  if (!candles.length) return [];
  const last = candles[candles.length - 1];
  const now = Date.now();
  return last.t + 60_000 > now ? candles.slice(0, -1) : candles.slice();
}

function onBarUpdate(force = false) {
  const closed = splitClosed(E.candles);
  if (closed.length < 35) return;
  const lastT = closed[closed.length - 1].t;
  E.forming = E.candles[E.candles.length - 1];

  if (force || lastT !== E.lastClosedT) {
    // settle a logged call whose candle has now closed
    if (E.pending) {
      const bar = closed.find((c) => c.t === E.pending.barTime);
      if (bar) settle(bar.c >= E.pending.entry ? 'up' : 'down');
    }
    E.closed = closed;
    E.lastClosedT = lastT;
    E.ctx = buildContext(closed);
    E.pred = predictNextCandle(closed, E.ctx);
    E.mode = 'live';
    renderPrediction();
    renderSession();
  }
  renderCountdown();
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function setSource(text, cls) {
  const el = $('edge-source');
  el.textContent = text;
  el.className = 'chip' + (cls ? ' ' + cls : '');
}

function renderPrediction() {
  const p = E.pred;
  if (!p) {
    $('pred-side').className = 'pred-side flat';
    $('pred-side').textContent = 'NO DATA';
    $('pred-prob').textContent = '—';
    $('pred-sub').textContent = 'need at least 35 candles';
    $('pred-note').textContent = 'Not enough candles to build the model. Crop the chart tighter or load more history.';
    $('features').innerHTML = '<p class="empty">No model yet.</p>';
    return;
  }

  const isUp = p.side === 'up';
  const sideProb = isUp ? p.probUp : p.probDown;

  const sideEl = $('pred-side');
  sideEl.className = 'pred-side ' + (isUp ? 'up' : 'down');
  sideEl.textContent = isUp ? 'UP ▲' : 'DOWN ▼';

  $('pred-prob').innerHTML = `${(sideProb * 100).toFixed(1)}<small>% ${isUp ? 'P(up)' : 'P(down)'}</small>`;
  $('pred-sub').textContent =
    `P(up) ${(p.probUp * 100).toFixed(1)}% · P(down) ${(p.probDown * 100).toFixed(1)}% · ${p.strength}`;

  // confidence: |p-0.5|*100 display the edge in probability points
  const edgePts = Math.abs(p.probUp - 0.5) * 100;
  $('edge-conf').style.width = `${clamp((edgePts / 22) * 100, 2, 100)}%`;
  $('edge-conf').style.background = isUp
    ? 'linear-gradient(90deg, #ffb85c, #2ee6a8)'
    : 'linear-gradient(90deg, #ffb85c, #ff5d6c)';
  $('edge-conf-text').textContent = `edge +${edgePts.toFixed(1)} pts`;

  $('pred-note').textContent = p.note;
  $('edge-model').textContent = p.model === 'logistic'
    ? `logistic · ${p.trainSamples} bars`
    : `rules · ${p.trainSamples} bars`;

  const cur = getSymbol(E.symbol).currency || '';
  const d = getSymbol(E.symbol).digits;
  const meta = [
    ['Model', p.model === 'logistic' ? 'Logistic' : 'Rule blend'],
    ['OOS hit', p.oosHit === null ? 'n/a' : `${(p.oosHit * 100).toFixed(1)}%`],
    ['Holdout', p.oosSamples ? `${p.oosSamples} bars` : '—'],
    ['ATR(14)', `${p.expectedRangePct.toFixed(2)}%`],
    ['Last close', E.mode === 'live' ? `${cur}${p.entry.toFixed(d)}` : 'chart units'],
    ['Signal', new Date(p.lastTime).toISOString().slice(11, 16) + 'Z']
  ];
  $('pred-meta').innerHTML = meta.map(
    ([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`
  ).join('');

  const chips = [];
  if (p.desk) {
    chips.push(`<span class="chip ${p.desk.bias === 'Bullish' ? 'up' : p.desk.bias === 'Bearish' ? 'down' : 'warn'}">Desk ${p.desk.bias}</span>`);
    chips.push(`<span class="chip">${p.desk.regime.trend}</span>`);
    chips.push(`<span class="chip ${p.desk.regime.vol === 'Expanding' ? 'warn' : ''}">Vol ${p.desk.regime.vol}</span>`);
    chips.push(`<span class="chip">${p.desk.regime.session}</span>`);
  }
  if (E.mode !== 'live') chips.push('<span class="chip warn">captured chart</span>');
  $('edge-chips').innerHTML = chips.join('');

  // feature contributions
  const maxAbs = Math.max(...p.features.map((f) => Math.abs(f.contribution)), 1e-6);
  $('features').innerHTML = p.features.map((f) => {
    const w = (Math.abs(f.contribution) / maxAbs) * 50;
    const left = f.contribution >= 0 ? 50 : 50 - w;
    const col = f.contribution >= 0 ? 'var(--up)' : 'var(--down)';
    const val = Math.abs(f.value) > 100 ? f.value.toFixed(0) : f.value.toFixed(2);
    return `<div class="feat">
      <div class="feat-top"><span>${f.label} <small style="color:var(--muted-2)">${val}</small></span><b style="color:${col}">${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(2)}</b></div>
      <div class="feat-bar"><i style="left:${left}%;width:${Math.max(w, 1)}%;background:${col};opacity:.8"></i></div>
    </div>`;
  }).join('');

  renderEV();
  renderSession();
}

function renderEV() {
  const p = E.pred;
  if (!p) { $('edge-ev').innerHTML = '—'; return; }
  const isUp = p.side === 'up';
  const sideProb = isUp ? p.probUp : p.probDown;
  const ev = binaryExpectancy(sideProb, E.payout, E.stake);
  const pos = ev.ev >= 0;

  $('edge-ev').innerHTML = [
    `Call: <b>${isUp ? 'HIGHER' : 'LOWER'}</b> · stake <b>${fmt(E.stake, 0)}</b> · payout <b>${E.payout}%</b>`,
    `Win <b>${fmt(ev.win, 2)}</b> · loss <b>${fmt(ev.loss, 2)}</b>`,
    `Breakeven hit rate <b>${(ev.breakeven * 100).toFixed(1)}%</b> vs model <b>${(sideProb * 100).toFixed(1)}%</b>`,
    `Expected value <b class="${pos ? 'pos' : 'neg'}">${ev.ev >= 0 ? '+' : ''}${fmt(ev.ev, 2)}</b> (${ev.evPct >= 0 ? '+' : ''}${fmt(ev.evPct, 1)}% per trade)`,
    pos
      ? `Edge over breakeven: <b class="pos">+${ev.edgePct.toFixed(1)} pts</b>`
      : `<span class="warn">Negative edge (−${Math.abs(ev.edgePct).toFixed(1)} pts) — mathematically this is a losing bet.</span>`
  ].join('<br/>');
}

function renderSession() {
  const s = E.session;
  const decided = s.wins + s.losses;
  const rate = decided ? (s.wins / decided) * 100 : null;

  const lines = [
    `Logged calls <b>${s.calls}</b> · settled <b>${decided}</b>`,
    `Wins <b>${s.wins}</b> · losses <b>${s.losses}</b>`,
    `Hit rate <b>${rate === null ? '—' : rate.toFixed(1) + '%'}</b>`,
    `Current streak <b>${s.streak === 0 ? '—' : (s.streak > 0 ? s.streak + 'W' : Math.abs(s.streak) + 'L')}</b> · best <b>${s.best}W</b>`
  ];
  if (E.pending) {
    const left = Math.max(0, E.pending.barTime + 60_000 - Date.now());
    lines.push(
      `<span class="warn">Open call: ${E.pending.side.toUpperCase()} @ ${E.pending.prob ? (E.pending.prob * 100).toFixed(1) + '%' : '—'} — settles in ${Math.ceil(left / 1000)}s</span>`
    );
  }
  $('session-stats').innerHTML = lines.join('<br/>');
}

function renderCountdown() {
  if (!E.live) {
    $('cd-value').textContent = '--';
    $('cd-fill').style.width = '0%';
    return;
  }
  const now = Date.now();
  const msLeft = 60_000 - (now % 60_000);
  const secs = Math.ceil(msLeft / 1000);
  $('cd-value').textContent = `0:${String(secs).padStart(2, '0')}`;
  $('cd-fill').style.width = `${(1 - msLeft / 60_000) * 100}%`;

  if (E.pending) renderSession();
}

/* ------------------------------------------------------------------ */
/* session bookkeeping                                                 */
/* ------------------------------------------------------------------ */

function logCall() {
  if (!E.pred || !E.forming) {
    toast('No prediction available to log yet.');
    return;
  }
  if (E.pending) {
    toast('A call is already open — wait for it to settle.');
    return;
  }
  E.pending = {
    barTime: E.forming.t,
    entry: E.closed[E.closed.length - 1].c,
    side: E.pred.side,
    prob: E.pred.side === 'up' ? E.pred.probUp : E.pred.probDown,
    at: Date.now()
  };
  E.session.calls++;
  renderSession();
  toast(`Call logged: ${E.pred.side.toUpperCase()} — settles at the next candle close.`);
}

function settle(outcome) {
  const win = outcome === E.pending.side;
  if (win) {
    E.session.wins++;
    E.session.streak = E.session.streak >= 0 ? E.session.streak + 1 : 1;
    E.session.best = Math.max(E.session.best, E.session.streak);
  } else {
    E.session.losses++;
    E.session.streak = E.session.streak <= 0 ? E.session.streak - 1 : -1;
  }
  toast(win ? '✓ Call won.' : '✕ Call lost.');
  E.pending = null;
  renderSession();
}

/* ------------------------------------------------------------------ */
/* chart image: share, upload, crop, read                              */
/* ------------------------------------------------------------------ */

function bindCrop() {
  const cv = $('cap-canvas');
  const point = (e) => {
    const r = cv.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * cv.width,
      y: ((e.clientY - r.top) / r.height) * cv.height
    };
  };

  cv.addEventListener('pointerdown', (e) => {
    if (!E.cap.src) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = point(e);
    E.cap.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!E.cap.drag) return;
    const p = point(e);
    E.cap.drag.x1 = p.x;
    E.cap.drag.y1 = p.y;
    drawCapture();
  });
  cv.addEventListener('pointerup', (e) => {
    if (!E.cap.drag) return;
    const d = E.cap.drag;
    E.cap.drag = null;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w > 30 && h > 30) {
      E.cap.crop = { x, y, w, h };
      saveCrop(E.cap.crop, E.cap.dims);
      E.cap.autoAnalyze = true;
    }
    analyzeCapture();
  });
  cv.addEventListener('pointercancel', () => { E.cap.drag = null; drawCapture(); });
}

async function shareTab() {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getDisplayMedia !== 'function') {
    toast('This browser has no tab-capture API. On mobile: screenshot the chart, then tap Upload.');
    return;
  }
  try {
    const stream = await md.getDisplayMedia({ video: { frameRate: 3 }, audio: false, preferCurrentTab: true });
    E.cap.stream = stream;
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 450));
    E.cap.video = video;
    grabFrame();
    $('auto-row').hidden = false;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      E.cap.stream = null;
      E.cap.video = null;
      stopAutoCapture();
      $('auto-row').hidden = true;
      $('auto-capture').checked = false;
    });
    toast('Tab captured. Drag once to crop the candles — after that it re-reads by itself.');
  } catch (err) {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    toast(
      err?.name === 'NotAllowedError'
        ? 'Capture cancelled.'
        : `Tab capture failed (${err?.name || 'error'}).${mobile ? ' Mobile browsers do not allow it — use Upload with a screenshot.' : ''}`
    );
  }
}

function grabFrame(keepCrop = false) {
  const v = E.cap.video;
  if (!v || !v.videoWidth) return;
  const maxW = 1400;
  const scale = Math.min(1, maxW / v.videoWidth);
  const w = Math.round(v.videoWidth * scale);
  const h = Math.round(v.videoHeight * scale);
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  off.getContext('2d').drawImage(v, 0, 0, w, h);
  setCaptureSource(off, keepCrop);
}

/* ----------------------- continuous capture ------------------------- */

function startAutoCapture() {
  stopAutoCapture();
  if (!E.cap.stream) {
    $('auto-capture').checked = false;
    toast('Share a browser tab first — auto-capture needs a live stream.');
    return;
  }
  if (!loadSavedCrop(1, 1) && E.cap.crop && E.cap.crop.w >= (E.cap.dims?.w || 1) * 0.98) {
    toast('Crop the candle area once — then auto-capture will keep re-reading it.');
  }
  E.cap.autoId = setInterval(() => grabFrame(true), 6000);
  $('auto-row').classList.add('on');
  toast('Auto-capture on: the chart is re-read every 6 seconds.');
}

function stopAutoCapture() {
  if (E.cap.autoId) { clearInterval(E.cap.autoId); E.cap.autoId = null; }
  $('auto-row').classList.remove('on');
}

function saveCrop(crop, dims) {
  if (!dims || !crop) return;
  try {
    window.localStorage.setItem('qp1m.crop', JSON.stringify({
      x: crop.x / dims.w, y: crop.y / dims.h,
      w: crop.w / dims.w, h: crop.h / dims.h
    }));
  } catch { /* private mode */ }
}

function loadSavedCrop(w, h) {
  try {
    const raw = window.localStorage.getItem('qp1m.crop');
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (![j.x, j.y, j.w, j.h].every(Number.isFinite)) return null;
    return { x: j.x * w, y: j.y * h, w: j.w * w, h: j.h * h };
  } catch {
    return null;
  }
}

function clearSavedCrop() {
  try { window.localStorage.removeItem('qp1m.crop'); } catch { /* ignore */ }
  if (E.cap.dims) E.cap.crop = { x: 0, y: 0, w: E.cap.dims.w, h: E.cap.dims.h };
  if (E.cap.src) analyzeCapture();
  toast('Saved crop cleared — drag on the image to pick the candle area again.');
}

function onImagePicked(e) {
  const file = e.target.files?.[0];
  if (file) loadImageFile(file);
  e.target.value = '';
}

/** Accepts a File or Blob from upload, camera, clipboard or the share sheet. */
function loadImageFile(blob) {
  if (!blob || !String(blob.type || '').startsWith('image/')) {
    toast('That file is not an image.');
    return;
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const maxW = 1400;
    const scale = Math.min(1, maxW / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    off.getContext('2d').drawImage(img, 0, 0, w, h);
    setCaptureSource(off);
    URL.revokeObjectURL(url);
    activateEdgeTab();
    toast('Chart loaded — drag on the image to crop, then hit Analyse.');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('That image could not be decoded.');
  };
  img.src = url;
}

function onPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile?.();
      if (file) {
        e.preventDefault();
        loadImageFile(file);
        activateEdgeTab();
        toast('Image pasted from the clipboard.');
        return;
      }
    }
  }
}

function activateEdgeTab() {
  const btn = document.querySelector('.tab[data-tab="edge"]');
  if (btn && !btn.classList.contains('active')) btn.click();
}

async function promptInstall() {
  if (!E.installPrompt) {
    toast('Use your browser menu → “Add to Home screen” (or Share → Add to Home Screen on iOS).');
    return;
  }
  E.installPrompt.prompt();
  try { await E.installPrompt.userChoice; } catch { /* dismissed */ }
  E.installPrompt = null;
  $('install-app').hidden = true;
}

/**
 * Reads the screenshot the Android share sheet handed to the service worker.
 * Mobile browsers cannot capture a tab, so this is the phone-native path.
 */
async function intakeShared() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('shared')) return;
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('qp1m-share');
    const res = await cache.match('/__shared-chart');
    if (!res) {
      toast('No shared image found — use Upload instead.');
      return;
    }
    const blob = await res.blob();
    await cache.delete('/__shared-chart');
    loadImageFile(blob);
    activateEdgeTab();
    toast('Screenshot received from the share sheet.');
  } catch {
    toast('Could not read the shared image.');
  }
}

function setCaptureSource(off, keepCrop = false) {
  const prev = E.cap.crop;
  const prevDims = E.cap.dims;
  const sx = prevDims ? off.width / prevDims.w : 1;
  const sy = prevDims ? off.height / prevDims.h : 1;

  const crop = keepCrop && prev && prevDims
    ? { x: prev.x * sx, y: prev.y * sy, w: prev.w * sx, h: prev.h * sy }
    : loadSavedCrop(off.width, off.height);

  E.cap.src = off;
  E.cap.dims = { w: off.width, h: off.height };
  E.cap.crop = crop || { x: 0, y: 0, w: off.width, h: off.height };
  E.cap.marks = [];

  const cv = $('cap-canvas');
  cv.width = off.width;
  cv.height = off.height;
  cv.classList.add('on');
  $('cap-empty').style.display = 'none';
  analyzeCapture();

  // Known crop → predict straight away. This is what removes the
  // "crop + click Analyse" step from every later share.
  if (crop && E.cap.autoAnalyze && E.cap.result && E.cap.result.candles.length >= 8) {
    useCapturedChart({ silent: true });
    $('cap-status').textContent = 'auto';
  }
}

function analyzeCapture() {
  if (!E.cap.src) return;
  const res = analyzeCanvas(E.cap.src, { crop: E.cap.crop, sensitivity: E.cap.sens });
  E.cap.result = res;
  E.cap.marks = res.marks || [];
  drawCapture();

  const m = res.meta;
  $('cap-meta').textContent = m.detected
    ? `${m.detected} candles · pitch ${m.pitch}px · ${m.bullish} bullish · ${m.method}${m.detected < 40 ? ' · short window, rule blend only' : ''}`
    : (m.reason || 'nothing detected');
  $('cap-status').textContent = m.detected ? 'detected' : 'failed';
  $('cap-analyze').disabled = res.candles.length < 8;
}

function drawCapture() {
  const cv = $('cap-canvas');
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  if (E.cap.src) g.drawImage(E.cap.src, 0, 0);

  // dim outside the crop
  const c = E.cap.crop;
  if (c && (c.x > 0 || c.y > 0 || c.w < cv.width || c.h < cv.height)) {
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, 0, cv.width, c.y);
    g.fillRect(0, c.y + c.h, cv.width, cv.height - c.y - c.h);
    g.fillRect(0, c.y, c.x, c.h);
    g.fillRect(c.x + c.w, c.y, cv.width - c.x - c.w, c.h);
    g.strokeStyle = 'rgba(46,230,168,0.8)';
    g.setLineDash([4, 4]);
    g.strokeRect(c.x, c.y, c.w, c.h);
    g.setLineDash([]);
  }

  // detected candles
  g.lineWidth = 1;
  for (const m of E.cap.marks) {
    g.strokeStyle = m.dir === 1 ? 'rgba(46,230,168,0.85)' : 'rgba(255,93,108,0.85)';
    g.strokeRect(m.x0 + 0.5, m.highY + 0.5, Math.max(1, m.x1 - m.x0), Math.max(1, m.lowY - m.highY));
  }

  // live drag rectangle
  if (E.cap.drag) {
    const d = E.cap.drag;
    g.strokeStyle = '#4fb3ff';
    g.lineWidth = 1.5;
    g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }
}

function useCapturedChart(opts = {}) {
  const silent = Boolean(opts && opts.silent === true);
  const res = E.cap.result;
  if (!res || res.candles.length < 8) {
    toast('No candles detected. Crop tighter on the candle area and raise sensitivity.');
    return;
  }
  stopTimers();
  E.live = false;
  E.mode = 'capture';
  E.forming = null;
  E.candles = res.candles;
  E.closed = res.candles;
  E.lastClosedT = null;
  E.ctx = buildContext(res.candles);
  E.pred = predictNextCandle(res.candles, E.ctx);
  setSource('CAPTURED', 'warn');
  $('cd-value').textContent = '--';
  $('cd-fill').style.width = '0%';
  renderPrediction();
  renderSession();
  if (!silent) {
    revealPrediction();
    toast(`${res.meta.detected} candles read from the image.`);
  }
}

function applyManual() {
  try {
    const candles = parseManualCandles($('manual-ta').value);
    stopTimers();
    E.live = false;
    E.mode = 'paste';
    E.forming = null;
    E.candles = candles;
    E.closed = candles;
    E.lastClosedT = null;
    E.ctx = buildContext(candles);
    E.pred = predictNextCandle(candles, E.ctx);
    setSource('PASTED', 'warn');
    $('cd-value').textContent = '--';
    renderPrediction();
    revealPrediction();
    toast(`${candles.length} candles pasted.`);
  } catch (err) {
    toast(err.message);
  }
}

function revealPrediction() {
  if (window.innerWidth > 760) return;
  const card = document.querySelector('#tab-edge .pred-card');
  if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
}

/* ------------------------------------------------------------------ */
/* native bridge (Android wrapper / any host app)                      */
/* ------------------------------------------------------------------ */

function onNativeFrame(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const off = document.createElement('canvas');
    off.width = img.width;
    off.height = img.height;
    off.getContext('2d').drawImage(img, 0, 0);
    setCaptureSource(off, true);
    if (E.cap.autoAnalyze) useCapturedChart({ silent: true });
    activateEdgeTab();
  };
  img.onerror = () => console.warn('QP.onFrame: could not decode frame');
  img.src = dataUrl;
}

window.QP = {
  version: '1.0',
  onFrame: onNativeFrame,
  analyze: () => useCapturedChart({ silent: true }),
  setSymbol: (sym) => {
    if (!SYMBOLS.some((s) => s.id === sym)) return false;
    E.symbol = sym;
    $('edge-symbol').value = sym;
    startLive();
    return true;
  },
  startAuto: () => startAutoCapture(),
  stopAuto: () => stopAutoCapture()
};

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('qp-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qp-toast';
    el.className = 'qp-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

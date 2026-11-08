/**
 * Quetex Pro 1M — canvas charting
 * Candles + overlays + volume + oscillator sub-pane + trade markers,
 * with crosshair, zoom and pan. No external charting dependency.
 */

const COL = {
  bg: '#080c12',
  grid: 'rgba(255,255,255,0.05)',
  axis: '#6b7c8f',
  text: '#c7d3df',
  up: '#2ee6a8',
  down: '#ff5d6c',
  ema20: '#4fb3ff',
  ema50: '#ffb85c',
  ema200: '#b98cff',
  bb: 'rgba(79,179,255,0.35)',
  vwap: '#e6edf3',
  st: '#2ee6a8',
  crosshair: 'rgba(230,237,243,0.35)'
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

function sizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(320, rect.width || canvas.clientWidth || 640);
  const h = Math.max(200, rect.height || canvas.clientHeight || 320);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

export class PriceChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.data = { candles: [], overlays: {}, trades: [], digits: 2, timeframe: '15m', symbol: '' };
    this.view = { count: 200, offset: 0 };
    this.hover = null;
    this.drag = null;
    this.layout = null;

    this._onMove = this._onMove.bind(this);
    this._onLeave = this._onLeave.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onWheel = this._onWheel.bind(this);

    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);
    canvas.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('dblclick', () => { this.view = { count: Math.min(200, this.data.candles.length), offset: 0 }; this.draw(); });

    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }

  setData(data) {
    const prevLen = this.data.candles.length;
    this.data = { ...this.data, ...data };
    const n = this.data.candles.length;
    if (!prevLen || n !== prevLen) {
      this.view = { count: Math.min(200, n), offset: 0 };
    }
    this.view.count = clamp(this.view.count, 20, Math.max(20, n));
    this.view.offset = clamp(this.view.offset, 0, Math.max(0, n - this.view.count));
    this.draw();
  }

  /* ------------------------------- events ------------------------------ */

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onMove(e) {
    const { x, y } = this._local(e);
    if (this.drag && this.layout) {
      const dx = x - this.drag.x;
      const bars = Math.round(dx / Math.max(1, this.layout.barW));
      this.view.offset = clamp(this.drag.offset + bars, 0, Math.max(0, this.data.candles.length - this.view.count));
    }
    this.hover = { x, y };
    this.draw();
  }

  _onLeave() { this.hover = null; this.draw(); }
  _onDown(e) { this.drag = { x: this._local(e).x, offset: this.view.offset }; }
  _onUp() { this.drag = null; }

  _onWheel(e) {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    const factor = dir > 0 ? 1.15 : 1 / 1.15;
    const n = this.data.candles.length;
    const next = clamp(Math.round(this.view.count * factor), 25, n);
    const end = n - this.view.offset;
    this.view.count = next;
    this.view.offset = clamp(n - end, 0, Math.max(0, n - next));
    this.draw();
  }

  /* ------------------------------- render ------------------------------ */

  draw() {
    const g = this.g;
    const { w: W, h: H } = sizeCanvas(this.canvas, g);
    this.w = W;
    this.h = H;
    g.clearRect(0, 0, W, H);
    g.fillStyle = COL.bg;
    g.fillRect(0, 0, W, H);

    const candles = this.data.candles;
    if (!candles.length) {
      g.fillStyle = COL.axis;
      g.font = FONT;
      g.fillText('Loading market data…', 20, 30);
      return;
    }

    const padL = 10, padR = 74, padT = 12, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    if (plotW < 50 || plotH < 80) return;

    const priceH = Math.max(90, plotH * 0.62);
    const volH = Math.max(28, plotH * 0.14);
    const gap = 8;
    const subH = Math.max(40, plotH - priceH - volH - gap * 2);
    const priceTop = padT;
    const volTop = priceTop + priceH + gap;
    const subTop = volTop + volH + gap;

    const n = candles.length;
    const count = clamp(this.view.count, 10, n);
    const end = clamp(n - this.view.offset, count, n);
    const start = end - count;
    const vis = candles.slice(start, end);
    const barW = plotW / count;
    this.layout = { start, end, barW, padL, plotW, priceTop, priceH, subTop, subH, volTop, volH };

    /* ---- price scale ---- */
    const ov = this.data.overlays || {};
    const ctxData = this.data.ctx;
    let lo = Infinity, hi = -Infinity;
    for (const c of vis) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    const consider = (arr) => {
      if (!arr) return;
      for (let i = start; i < end; i++) {
        const v = arr[i];
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    };
    if (ctxData) {
      if (ov.ema20) consider(ctxData.ema20);
      if (ov.ema50) consider(ctxData.ema50);
      if (ov.ema200) consider(ctxData.ema200);
      if (ov.bb) { consider(ctxData.bb.upper); consider(ctxData.bb.lower); }
      if (ov.vwap) consider(ctxData.vwap);
      if (ov.st) consider(ctxData.st.line);
    }
    const pad = (hi - lo) * 0.08 || hi * 0.002;
    lo -= pad; hi += pad;
    const yP = (v) => priceTop + priceH - ((v - lo) / (hi - lo)) * priceH;
    const xFor = (idx) => padL + (idx - start + 0.5) * barW;

    /* ---- grid + price axis ---- */
    g.font = FONT;
    g.textBaseline = 'middle';
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const v = lo + ((hi - lo) * t) / ticks;
      const y = yP(v);
      g.strokeStyle = COL.grid;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
      g.fillStyle = COL.axis;
      g.textAlign = 'left';
      g.fillText(this._fmt(v), padL + plotW + 8, y);
    }

    /* ---- bollinger fill ---- */
    if (ctxData && ov.bb) {
      g.beginPath();
      let started = false;
      for (let i = start; i < end; i++) {
        const v = ctxData.bb.upper[i];
        if (!Number.isFinite(v)) continue;
        const x = xFor(i);
        if (!started) { g.moveTo(x, yP(v)); started = true; } else g.lineTo(x, yP(v));
      }
      for (let i = end - 1; i >= start; i--) {
        const v = ctxData.bb.lower[i];
        if (!Number.isFinite(v)) continue;
        g.lineTo(xFor(i), yP(v));
      }
      if (started) {
        g.closePath();
        g.fillStyle = 'rgba(79,179,255,0.06)';
        g.fill();
      }
    }

    /* ---- candles + volume ---- */
    const volMax = Math.max(...vis.map((c) => c.v), 1);
    for (let i = start; i < end; i++) {
      const c = candles[i];
      const x = xFor(i);
      const up = c.c >= c.o;
      const col = up ? COL.up : COL.down;
      const bw = Math.max(1, barW * 0.64);

      g.strokeStyle = col;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, yP(c.h));
      g.lineTo(x, yP(c.l));
      g.stroke();

      const yO = yP(c.o), yC = yP(c.c);
      const top = Math.min(yO, yC);
      const hgt = Math.max(1, Math.abs(yC - yO));
      g.fillStyle = col;
      g.fillRect(x - bw / 2, top, bw, hgt);

      // volume
      const vh = (c.v / volMax) * (volH - 4);
      g.fillStyle = up ? 'rgba(46,230,168,0.35)' : 'rgba(255,93,108,0.35)';
      g.fillRect(x - bw / 2, volTop + volH - vh, bw, vh);
    }

    /* ---- overlays ---- */
    const line = (arr, color, width = 1.4, dash = []) => {
      if (!arr) return;
      g.save();
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      let started = false;
      for (let i = start; i < end; i++) {
        const v = arr[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = xFor(i), y = yP(v);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
      g.restore();
    };

    if (ctxData) {
      if (ov.ema200) line(ctxData.ema200, COL.ema200, 1.4);
      if (ov.ema50) line(ctxData.ema50, COL.ema50, 1.4);
      if (ov.ema20) line(ctxData.ema20, COL.ema20, 1.4);
      if (ov.vwap) line(ctxData.vwap, COL.vwap, 1.1, [4, 4]);
      if (ov.st) line(ctxData.st.line, COL.st, 1.2, [2, 3]);
    }

    /* ---- divider lines ---- */
    g.strokeStyle = COL.grid;
    g.beginPath();
    g.moveTo(padL, volTop - gap / 2); g.lineTo(padL + plotW, volTop - gap / 2);
    g.moveTo(padL, subTop - gap / 2); g.lineTo(padL + plotW, subTop - gap / 2);
    g.stroke();

    /* ---- last price tag ---- */
    const last = candles[n - 1];
    if (last.c >= lo && last.c <= hi) {
      const y = yP(last.c);
      const up = last.c >= candles[n - 2]?.c;
      g.strokeStyle = up ? COL.up : COL.down;
      g.setLineDash([3, 4]);
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = up ? COL.up : COL.down;
      roundRect(g, padL + plotW + 2, y - 9, padR - 6, 18, 3);
      g.fill();
      g.fillStyle = '#04120c';
      g.textAlign = 'left';
      g.fillText(this._fmt(last.c), padL + plotW + 8, y);
    }

    /* ---- sub pane ---- */
    this._drawSub(g, { start, end, xFor, subTop, subH, padL, plotW });

    /* ---- time axis ---- */
    const steps = Math.max(2, Math.min(7, Math.floor(plotW / 110)));
    g.fillStyle = COL.axis;
    g.textAlign = 'center';
    for (let s = 0; s <= steps; s++) {
      const idx = start + Math.round(((count - 1) * s) / steps);
      const c = candles[Math.min(idx, n - 1)];
      if (!c) continue;
      g.fillText(this._fmtTime(c.t), xFor(Math.min(idx, end - 1)), H - 8);
    }

    /* ---- trade markers ---- */
    const trades = this.data.trades || [];
    for (const t of trades) {
      if (t.entryIdx >= start && t.entryIdx < end) {
        this._marker(g, xFor(t.entryIdx), yP(t.entry), t.side === 'long', true);
      }
      if (t.exitIdx >= start && t.exitIdx < end) {
        this._marker(g, xFor(t.exitIdx), yP(t.exit), t.side === 'long', false);
      }
    }

    /* ---- legend ---- */
    this._legend(g, padL, padT + 10, { start, end });

    /* ---- crosshair ---- */
    if (this.hover && this.hover.x > padL && this.hover.x < padL + plotW) {
      this._crosshair(g, { start, end, xFor, yP, lo, hi, padL, plotW, W, H, padR, priceTop, priceH, volTop, volH, subTop, subH });
    }
  }

  _marker(g, x, y, isLong, entry) {
    g.save();
    g.fillStyle = isLong ? COL.up : COL.down;
    g.globalAlpha = entry ? 0.95 : 0.55;
    if (entry) {
      g.beginPath();
      g.moveTo(x, y + (isLong ? -2 : 2));
      g.lineTo(x - 5, y + (isLong ? -11 : 11));
      g.lineTo(x + 5, y + (isLong ? -11 : 11));
      g.closePath();
      g.fill();
    } else {
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  _drawSub(g, { start, end, xFor, subTop, subH, padL, plotW }) {
    const ctxData = this.data.ctx;
    if (!ctxData) return;
    const sub = this.data.sub || 'rsi';

    g.strokeStyle = COL.grid;
    g.strokeRect(padL, subTop, plotW, subH);

    if (sub === 'macd') {
      const h = ctxData.macd.hist;
      let m = 0;
      for (let i = start; i < end; i++) m = Math.max(m, Math.abs(h[i] || 0));
      if (!m) m = 1;
      const mid = subTop + subH / 2;
      const y = (v) => mid - (v / m) * (subH / 2 - 4);
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.beginPath(); g.moveTo(padL, mid); g.lineTo(padL + plotW, mid); g.stroke();
      for (let i = start; i < end; i++) {
        const v = h[i];
        if (!Number.isFinite(v)) continue;
        g.fillStyle = v >= 0 ? 'rgba(46,230,168,0.5)' : 'rgba(255,93,108,0.5)';
        const x = xFor(i);
        const y0 = y(0), y1 = y(v);
        g.fillRect(x - Math.max(1, this.layout.barW * 0.3), Math.min(y0, y1), Math.max(1, this.layout.barW * 0.6), Math.abs(y1 - y0) || 1);
      }
      const plot = (arr, color) => {
        g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath();
        let st = false;
        for (let i = start; i < end; i++) {
          const v = arr[i];
          if (!Number.isFinite(v)) { st = false; continue; }
          const X = xFor(i), Y = y(v);
          if (!st) { g.moveTo(X, Y); st = true; } else g.lineTo(X, Y);
        }
        g.stroke();
      };
      plot(ctxData.macd.line, '#4fb3ff');
      plot(ctxData.macd.signal, '#ffb85c');
      g.fillStyle = COL.axis; g.textAlign = 'left';
      g.fillText('MACD 12·26·9', padL + 6, subTop + 11);
    } else {
      const R = ctxData.rsi;
      const y = (v) => subTop + subH - (v / 100) * subH;
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.setLineDash([2, 4]);
      for (const lvl of [30, 50, 70]) {
        g.beginPath(); g.moveTo(padL, y(lvl)); g.lineTo(padL + plotW, y(lvl)); g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = 'rgba(79,179,255,0.05)';
      g.fillRect(padL, y(70), plotW, y(30) - y(70));
      g.strokeStyle = COL.ema20;
      g.lineWidth = 1.4;
      g.beginPath();
      let st = false;
      for (let i = start; i < end; i++) {
        const v = R[i];
        if (!Number.isFinite(v)) { st = false; continue; }
        const X = xFor(i), Y = y(v);
        if (!st) { g.moveTo(X, Y); st = true; } else g.lineTo(X, Y);
      }
      g.stroke();
      g.fillStyle = COL.axis;
      g.textAlign = 'left';
      g.fillText('RSI 14', padL + 6, subTop + 11);
      g.textAlign = 'right';
      g.fillText('70', padL + plotW - 4, y(70));
      g.fillText('30', padL + plotW - 4, y(30));
    }
  }

  _legend(g, x, y, { start, end }) {
    const ctxData = this.data.ctx;
    const ov = this.data.overlays || {};
    const items = [];
    if (ctxData) {
      const i = Math.min(end - 1, this.data.candles.length - 1);
      if (ov.ema20) items.push([COL.ema20, `EMA20 ${this._fmt(ctxData.ema20[i])}`]);
      if (ov.ema50) items.push([COL.ema50, `EMA50 ${this._fmt(ctxData.ema50[i])}`]);
      if (ov.ema200 && Number.isFinite(ctxData.ema200[i])) items.push([COL.ema200, `EMA200 ${this._fmt(ctxData.ema200[i])}`]);
      if (ov.vwap) items.push([COL.vwap, `VWAP ${this._fmt(ctxData.vwap[i])}`]);
      if (ov.bb) items.push([COL.ema20, `BB(20,2) ${this._fmt(ctxData.bb.upper[i])} / ${this._fmt(ctxData.bb.lower[i])}`]);
      if (ov.st) items.push([COL.st, `Supertrend ${ctxData.st.dir[i] === 1 ? 'bull' : 'bear'}`]);
    }
    g.font = FONT;
    g.textAlign = 'left';
    let cx = x;
    const cy = y;
    for (const [color, label] of items) {
      const wLabel = g.measureText(label).width;
      if (cx + wLabel + 22 > this.w - 80) break;
      g.fillStyle = color;
      g.fillRect(cx, cy - 4, 8, 2);
      g.fillStyle = COL.text;
      g.fillText(label, cx + 12, cy);
      cx += wLabel + 26;
    }
  }

  _crosshair(g, { start, end, xFor, yP, lo, hi, padL, plotW, W, H, padR, priceTop, priceH }) {
    const idx = clamp(Math.floor((this.hover.x - padL) / this.layout.barW) + start, start, end - 1);
    const c = this.data.candles[idx];
    if (!c) return;
    const x = xFor(idx);
    const y = clamp(this.hover.y, priceTop, priceTop + priceH);

    g.save();
    g.strokeStyle = COL.crosshair;
    g.setLineDash([3, 4]);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, priceTop); g.lineTo(x, priceTop + priceH + this.layout.volH + this.layout.subH + 16); g.stroke();
    g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
    g.setLineDash([]);

    // y label
    const price = lo + ((priceTop + priceH - y) / priceH) * (hi - lo);
    g.fillStyle = '#1b2733';
    roundRect(g, padL + plotW + 2, y - 9, padR - 6, 18, 3);
    g.fill();
    g.fillStyle = COL.text;
    g.textAlign = 'left';
    g.fillText(this._fmt(price), padL + plotW + 8, y);

    // x label
    const label = this._fmtTime(c.t);
    g.font = FONT;
    const tw = g.measureText(label).width + 14;
    g.fillStyle = '#1b2733';
    roundRect(g, x - tw / 2, H - 22, tw, 17, 3);
    g.fill();
    g.fillStyle = COL.text;
    g.textAlign = 'center';
    g.fillText(label, x, H - 13.5);

    // tooltip
    const chg = ((c.c - c.o) / c.o) * 100;
    const lines = [
      ['O', this._fmt(c.o)], ['H', this._fmt(c.h)], ['L', this._fmt(c.l)], ['C', this._fmt(c.c)],
      ['Vol', c.v >= 1e6 ? `${(c.v / 1e6).toFixed(2)}M` : c.v >= 1e3 ? `${(c.v / 1e3).toFixed(1)}K` : c.v.toFixed(1)]
    ];
    const bw = 138, bh = 18 + lines.length * 15 + 6;
    let bx = x + 14;
    if (bx + bw > padL + plotW) bx = x - bw - 14;
    const by = Math.max(priceTop + 4, Math.min(y + 12, priceTop + priceH - bh - 4));
    g.fillStyle = 'rgba(13,19,25,0.96)';
    g.strokeStyle = '#1c2733';
    roundRect(g, bx, by, bw, bh, 4);
    g.fill(); g.stroke();
    g.fillStyle = chg >= 0 ? COL.up : COL.down;
    g.textAlign = 'left';
    g.font = 'bold 11px ui-monospace, monospace';
    g.fillText(`${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, bx + 8, by + 12);
    g.font = FONT;
    g.fillStyle = COL.text;
    lines.forEach(([k, v], i) => {
      g.fillStyle = COL.axis;
      g.fillText(k, bx + 8, by + 28 + i * 15);
      g.fillStyle = COL.text;
      g.textAlign = 'right';
      g.fillText(v, bx + bw - 8, by + 28 + i * 15);
      g.textAlign = 'left';
    });
    g.restore();
  }

  _fmt(v) {
    const d = this.data.digits ?? 2;
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  _fmtTime(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    const tf = this.data.timeframe || '15m';
    if (tf === '1d') return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    if (tf === '4h') return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}h`;
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
}

/* ------------------------------------------------------------------ */
/* Small line chart (equity, drawdown)                                 */
/* ------------------------------------------------------------------ */

export class LineChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.opts = { color: '#2ee6a8', baseline: null, fill: true, currency: '$', ...opts };
    this.series = [];
    this.labels = [];
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }

  setData({ series, labels = [], baseline = null, color = null }) {
    this.series = series || [];
    this.labels = labels;
    this.opts.baseline = baseline;
    if (color) this.opts.color = color;
    this.draw();
  }

  draw() {
    const g = this.g;
    const { w: W, h: H } = sizeCanvas(this.canvas, g);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'transparent';
    g.fillRect(0, 0, W, H);

    const s = this.series;
    if (!s.length) {
      g.fillStyle = '#6b7c8f';
      g.font = FONT;
      g.fillText('Run a backtest to plot the curve', 16, 24);
      return;
    }

    const padL = 8, padR = 66, padT = 10, padB = 18;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    let lo = Math.min(...s), hi = Math.max(...s);
    if (this.opts.baseline !== null) { lo = Math.min(lo, this.opts.baseline); hi = Math.max(hi, this.opts.baseline); }
    if (hi === lo) { hi += 1; lo -= 1; }
    const padv = (hi - lo) * 0.08;
    lo -= padv; hi += padv;

    const x = (i) => padL + (i / Math.max(1, s.length - 1)) * plotW;
    const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

    // grid
    g.font = FONT;
    g.textBaseline = 'middle';
    for (let t = 0; t <= 4; t++) {
      const v = lo + ((hi - lo) * t) / 4;
      const Y = y(v);
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      g.beginPath(); g.moveTo(padL, Y); g.lineTo(padL + plotW, Y); g.stroke();
      g.fillStyle = '#6b7c8f';
      g.textAlign = 'left';
      g.fillText(shortNum(v, this.opts.currency), padL + plotW + 8, Y);
    }

    // baseline
    if (this.opts.baseline !== null) {
      g.strokeStyle = 'rgba(255,255,255,0.22)';
      g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(padL, y(this.opts.baseline)); g.lineTo(padL + plotW, y(this.opts.baseline)); g.stroke();
      g.setLineDash([]);
    }

    // area
    if (this.opts.fill) {
      const grad = g.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, hexA(this.opts.color, 0.28));
      grad.addColorStop(1, hexA(this.opts.color, 0.01));
      g.beginPath();
      g.moveTo(x(0), y(s[0]));
      for (let i = 1; i < s.length; i++) g.lineTo(x(i), y(s[i]));
      g.lineTo(x(s.length - 1), padT + plotH);
      g.lineTo(x(0), padT + plotH);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
    }

    // line
    g.beginPath();
    g.moveTo(x(0), y(s[0]));
    for (let i = 1; i < s.length; i++) g.lineTo(x(i), y(s[i]));
    g.strokeStyle = this.opts.color;
    g.lineWidth = 1.6;
    g.lineJoin = 'round';
    g.stroke();

    // end dot
    g.fillStyle = this.opts.color;
    g.beginPath();
    g.arc(x(s.length - 1), y(s[s.length - 1]), 3, 0, Math.PI * 2);
    g.fill();
  }
}

/* ------------------------------------------------------------------ */
/* Histogram (Monte Carlo)                                             */
/* ------------------------------------------------------------------ */

export class HistogramChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.data = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }

  setData(data) { this.data = data; this.draw(); }

  draw() {
    const g = this.g;
    const { w: W, h: H } = sizeCanvas(this.canvas, g);
    g.clearRect(0, 0, W, H);
    if (!this.data) {
      g.fillStyle = '#6b7c8f';
      g.font = FONT;
      g.fillText('Monte Carlo distribution', 12, 20);
      return;
    }
    const { buckets, lo, hi } = this.data;
    const padL = 8, padR = 60, padT = 12, padB = 20;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxB = Math.max(...buckets, 1);
    const bw = plotW / buckets.length;

    g.font = FONT;
    g.textBaseline = 'middle';

    // initial capital marker
    const initial = this.data.initial;
    if (Number.isFinite(initial) && initial > lo && initial < hi) {
      const px = padL + ((initial - lo) / (hi - lo)) * plotW;
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(px, padT); g.lineTo(px, padT + plotH); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#6b7c8f';
      g.textAlign = 'center';
      g.fillText('start', px, padT + plotH + 10);
    }

    buckets.forEach((b, i) => {
      const h = (b / maxB) * plotH;
      const x = padL + i * bw;
      const mid = lo + ((i + 0.5) / buckets.length) * (hi - lo);
      const grad = g.createLinearGradient(0, padT + plotH - h, 0, padT + plotH);
      grad.addColorStop(0, mid >= initial ? 'rgba(46,230,168,0.85)' : 'rgba(255,93,108,0.8)');
      grad.addColorStop(1, mid >= initial ? 'rgba(46,230,168,0.25)' : 'rgba(255,93,108,0.2)');
      g.fillStyle = grad;
      g.fillRect(x + 1, padT + plotH - h, Math.max(1, bw - 2), h);
    });

    g.fillStyle = '#6b7c8f';
    g.textAlign = 'left';
    g.fillText(shortNum(lo, '$'), padL, padT + plotH + 10);
    g.textAlign = 'right';
    g.fillText(shortNum(hi, '$'), padL + plotW, padT + plotH + 10);
  }
}

function shortNum(v, cur = '$') {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${cur}${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${cur}${(v / 1e3).toFixed(0)}k`;
  if (abs >= 1e3) return `${cur}${(v / 1e3).toFixed(1)}k`;
  return `${cur}${v.toFixed(0)}`;
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

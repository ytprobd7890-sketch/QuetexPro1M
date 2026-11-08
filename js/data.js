/**
 * Quetex Pro 1M — market data layer
 * Three sources, one shape: { t, o, h, l, c, v } chronological candles.
 *   1. live    — Binance public REST (browser-side, CORS enabled)
 *   2. simulated — deterministic regime/volatility-clustered synthetic tape
 *   3. csv     — user import
 */

export const TIMEFRAMES = {
  '1m': { ms: 60_000, label: '1 min', perYear: 525_600, intraday: true },
  '5m': { ms: 300_000, label: '5 min', perYear: 105_120, intraday: true },
  '15m': { ms: 900_000, label: '15 min', perYear: 35_040, intraday: true },
  '1h': { ms: 3_600_000, label: '1 hour', perYear: 8_760, intraday: true },
  '4h': { ms: 14_400_000, label: '4 hour', perYear: 2_190, intraday: true },
  '1d': { ms: 86_400_000, label: '1 day', perYear: 365, intraday: false }
};

export const SYMBOLS = [
  { id: 'BTCUSDT', label: 'BTC / USDT', binance: 'BTCUSDT', kind: 'crypto', price: 68_400, vol1m: 0.00085, digits: 2, currency: '$', volBase: 95 },
  { id: 'ETHUSDT', label: 'ETH / USDT', binance: 'ETHUSDT', kind: 'crypto', price: 3_520, vol1m: 0.00110, digits: 2, currency: '$', volBase: 1_450 },
  { id: 'SOLUSDT', label: 'SOL / USDT', binance: 'SOLUSDT', kind: 'crypto', price: 172, vol1m: 0.00160, digits: 3, currency: '$', volBase: 12_000 },
  { id: 'BNBUSDT', label: 'BNB / USDT', binance: 'BNBUSDT', kind: 'crypto', price: 612, vol1m: 0.00105, digits: 2, currency: '$', volBase: 5_800 },
  { id: 'XAUUSD', label: 'XAU / USD — Gold', binance: null, kind: 'metal', price: 2_668, vol1m: 0.00034, digits: 2, currency: '$', volBase: 320 },
  { id: 'EURUSD', label: 'EUR / USD', binance: null, kind: 'fx', price: 1.0845, vol1m: 0.00015, digits: 5, currency: '', volBase: 900 },
  { id: 'NIFTY50', label: 'NIFTY 50', binance: null, kind: 'index', price: 24_520, vol1m: 0.00030, digits: 1, currency: '', volBase: 2_400 },
  { id: 'RELIANCE', label: 'RELIANCE (NSE)', binance: null, kind: 'equity', price: 2_940, vol1m: 0.00055, digits: 2, currency: '', volBase: 4_100 }
];

export const getSymbol = (id) => SYMBOLS.find((s) => s.id === id) || SYMBOLS[0];

/* ------------------------------------------------------------------ */
/* Deterministic synthetic tape                                          */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeGauss(rand) {
  let spare = null;
  return function gauss() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
}

const sessionCurve = (hour) =>
  0.62 +
  0.50 * Math.exp(-(((hour - 14) / 4.2) ** 2)) + // London / New York overlap
  0.16 * Math.exp(-(((hour - 2) / 3.0) ** 2));   // Tokyo

/**
 * Build a realistic synthetic series: regime-switching drift,
 * volatility clustering, session seasonality and fat-tailed wicks.
 */
export function generateSeries({ symbolId = 'BTCUSDT', timeframe = '15m', bars = 600, seed = 42 } = {}) {
  const sym = getSymbol(symbolId);
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES['15m'];
  const rand = mulberry32((hashString(symbolId + timeframe) ^ (seed * 2654435761)) >>> 0);
  const gauss = makeGauss(rand);

  const volScale = Math.sqrt(tf.ms / 60_000);
  // Intraday mean reversion: shorter bars trend less per bar relative to noise.
  const driftFactor = tf.ms <= 60_000 ? 0.06 : tf.ms <= 900_000 ? 0.10 : 0.14;
  const sigma = sym.vol1m * volScale;
  const endT = Math.floor(Date.now() / tf.ms) * tf.ms;

  let price = sym.price * (0.88 + rand() * 0.24);
  let volMult = 1;
  let regimeLeft = 0;
  let drift = 0;

  const candles = [];
  for (let i = 0; i < bars; i++) {
    const t = endT - (bars - 1 - i) * tf.ms;
    const hour = new Date(t).getUTCHours();
    const day = new Date(t).getUTCDay();

    // --- regime switching (trend / chop) ---------------------------------
    if (regimeLeft <= 0) {
      regimeLeft = 40 + Math.floor(rand() * 240);
      const roll = rand();
      drift = (roll - 0.5) * 1.9;
      if (Math.abs(drift) < 0.35) drift *= 0.25; // more chop than trend
    }
    regimeLeft--;

    // --- volatility clustering (GARCH-flavoured) -------------------------
    volMult = Math.max(0.45, Math.min(3.4, volMult * 0.982 + 0.018 * (0.85 + rand() * 1.35)));
    if (rand() < 0.008) volMult *= 1.7; // shock bar

    let sess = tf.intraday ? sessionCurve(hour) : 1;
    if (sym.kind !== 'crypto' && (day === 0 || day === 6)) sess *= 0.22; // weekend liquidity

    const sigmaBar = Math.max(sigma * volMult * sess, sigma * 0.25);
    const z = gauss();
    const ret = drift * sigma * driftFactor + sigmaBar * z;

    const o = price;
    const c = Math.max(o * Math.exp(ret), sym.price * 0.02);
    const wick = sigmaBar * 0.62;
    const h = Math.max(o, c) * (1 + Math.abs(gauss()) * wick);
    const l = Math.min(o, c) * (1 - Math.abs(gauss()) * wick);

    const v = Math.max(
      1,
      sym.volBase * (0.35 + rand() * 1.25) * sess * (1 + 1.8 * Math.abs(z))
    );

    candles.push({
      t,
      o: round(o, sym.digits),
      h: round(h, sym.digits),
      l: round(Math.max(l, 0.00001), sym.digits),
      c: round(c, sym.digits),
      v: Math.round(v * 100) / 100
    });
    price = c;
  }

  return {
    candles,
    meta: {
      source: 'simulated',
      symbol: sym.id,
      label: sym.label,
      timeframe,
      digits: sym.digits,
      currency: sym.currency,
      seed,
      note: `Synthetic ${tf.label} tape · seed ${seed}`
    }
  };
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/* ------------------------------------------------------------------ */
/* Live data (Binance public market-data API)                          */
/* ------------------------------------------------------------------ */

const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com'
];

/** Merge overlapping kline arrays (used by the poller). */
export function mergeCandles(base, incoming, keep = 520) {
  const byTime = new Map();
  for (const c of base) byTime.set(c.t, c);
  for (const c of incoming) byTime.set(c.t, c);
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-keep);
}

/**
 * 1-minute klines from Binance.
 *
 * Engine rules that matter for a phone on a blocked/slow network:
 *   - every host is raced in parallel, so the worst case is ONE timeout (4 s),
 *     not hosts × timeout;
 *   - `minRows` defaults to 1 — the 3-row poll used to be rejected by a
 *     ">= 50 rows" check, which silently froze the live feed;
 *   - the caller always gets a rejection it can fall back from, never a hang.
 */
export async function fetchBinanceKlines(symbolId, timeframe, limit = 600, opts = {}) {
  const sym = getSymbol(symbolId);
  if (!sym.binance) throw new Error('No live feed for this symbol');

  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 4500;
  const minRows = Number(opts.minRows) > 0 ? Number(opts.minRows) : 1;
  const rows = Math.max(1, Math.min(Number(limit) || 600, 1000));

  const fromHost = async (host) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const url = `${host}/api/v3/klines?symbol=${sym.binance}&interval=${timeframe}&limit=${rows}`;
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length < minRows) throw new Error('Empty response');

      const candles = raw.map((k) => ({
        t: Number(k[0]),
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5])
      })).filter((c) => [c.t, c.o, c.h, c.l, c.c].every((n) => Number.isFinite(n) && n > 0));

      if (!candles.length) throw new Error('No usable rows');

      return {
        candles,
        meta: {
          source: 'live',
          symbol: sym.id,
          label: sym.label,
          timeframe,
          digits: sym.digits,
          currency: sym.currency,
          note: `Binance spot · ${timeframe} · ${candles.length} bars`
        }
      };
    } finally {
      clearTimeout(timer);
    }
  };

  if (typeof Promise.any === 'function') {
    try {
      return await Promise.any(BINANCE_HOSTS.map(fromHost));
    } catch {
      throw new Error(`live feed unreachable after ${timeout} ms`);
    }
  }

  // Older WebViews: sequential, still bounded by the same timeout each.
  let lastErr = null;
  for (const host of BINANCE_HOSTS) {
    try { return await fromHost(host); } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('live feed unreachable');
}

/* ------------------------------------------------------------------ */
/* CSV import                                                          */
/* ------------------------------------------------------------------ */

/**
 * Accepts headers like time/date/timestamp, open/o, high/h, low/l, close/c, volume/v
 * (case-insensitive), with either epoch ms/s or ISO-ish dates.
 */
export function parseCsv(text, { symbolId = 'CUSTOM', timeframe = '15m' } = {}) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 3) throw new Error('CSV needs a header and at least 2 rows');

  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const headers = lines[0].split(delim).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));

  const idx = (names) => headers.findIndex((h) => names.includes(h));
  const iT = idx(['time', 'date', 'datetime', 'timestamp', 'open time']);
  const iO = idx(['open', 'o']);
  const iH = idx(['high', 'h']);
  const iL = idx(['low', 'l']);
  const iC = idx(['close', 'c', 'price']);
  const iV = idx(['volume', 'v', 'vol']);
  if (iT < 0 || iO < 0 || iH < 0 || iL < 0 || iC < 0) {
    throw new Error('CSV must include time, open, high, low, close columns');
  }

  const candles = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
    const num = (i) => (i >= 0 ? Number(cells[i]) : 0);

    const o = num(iO), h = num(iH), l = num(iL), c = num(iC);
    // Blank cells become 0 — a zero or negative price would poison every
    // indicator downstream, so drop the row instead of "fixing" it.
    if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0)) continue;

    let t = cells[iT];
    const asNum = Number(t);
    if (Number.isFinite(asNum) && asNum > 0) t = asNum > 1e11 ? asNum : asNum * 1000;
    else t = Date.parse(t);

    if (!Number.isFinite(t) || t <= 0) continue;

    const volume = iV >= 0 ? num(iV) : 0;
    candles.push({
      t,
      o,
      h: Math.max(o, h, l, c),
      l: Math.min(o, h, l, c),
      c,
      v: Number.isFinite(volume) && volume > 0 ? volume : 0
    });
  }
  candles.sort((a, b) => a.t - b.t);
  if (candles.length < 50) throw new Error('CSV produced fewer than 50 valid candles');

  const sym = getSymbol(symbolId);
  return {
    candles,
    meta: {
      source: 'csv',
      symbol: symbolId,
      label: sym.label || symbolId,
      timeframe,
      digits: sym.digits ?? 2,
      currency: sym.currency ?? '',
      note: `Imported CSV · ${candles.length} bars`
    }
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmt(v, d = 2) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPrice(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(v, d = 2) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${fmt(v, d)}%`;
}

export function fmtMoney(v, currency = '$', d = 2) {
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const body = abs >= 1_000_000
    ? `${(abs / 1_000_000).toFixed(2)}M`
    : abs >= 10_000
      ? `${(abs / 1000).toFixed(1)}k`
      : fmt(abs, d);
  return `${sign}${currency}${body}`;
}

export function fmtCompact(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  if (abs > 0 && abs < 1) return v.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
  return fmt(v, 2);
}

export function fmtTime(t, timeframe = '15m') {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  const intraday = timeframe !== '1d' && timeframe !== '4h';
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return intraday ? `${date} ${time}Z` : date;
}

export function fmtDate(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const utcHour = (t) => new Date(t).getUTCHours();

export function sessionName(t) {
  const h = utcHour(t);
  if (h >= 0 && h < 6) return { name: 'Asia / Tokyo', quality: 'Moderate', note: 'Thinner book, wider spreads — reduce size on 1m triggers.' };
  if (h >= 6 && h < 11) return { name: 'London', quality: 'High', note: 'Strong directional flow after the 07:00Z open.' };
  if (h >= 11 && h < 16) return { name: 'London / New York overlap', quality: 'Highest', note: 'Peak liquidity and follow-through — best window for breakout entries.' };
  if (h >= 16 && h < 21) return { name: 'New York', quality: 'High', note: 'Trend continuation into the US close; watch for 19:00Z reversals.' };
  return { name: 'Late New York / Sydney', quality: 'Low', note: 'Choppy, mean-reverting tape — avoid fresh breakout risk.' };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

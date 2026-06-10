// Pure formatting + small helpers (ported verbatim from the original tool).

export const LANG_NAMES = { hi: 'Hindi', te: 'Telugu', ta: 'Tamil', ml: 'Malayalam', kn: 'Kannada' };

export const esc = (s) =>
  (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

export function fmtNum(n) {
  if (n == null || n === '') return '—';
  n = +n;
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-IN');
}

export function fmtPct(n, d = 2) {
  if (n == null || n === '' || isNaN(+n)) return '—';
  return (+n).toFixed(d) + '%';
}

export function fmtHours(s) {
  if (s == null || isNaN(+s)) return '—';
  const h = +s / 3600;
  return h >= 100 ? Math.round(h).toLocaleString('en-IN') + 'h' : h.toFixed(1) + 'h';
}

export function fmtDate(d) {
  if (!d) return '—';
  const t = new Date(d);
  return isNaN(t) ? String(d) : t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function num(v) {
  return v == null || v === '' || isNaN(+v) ? null : +v;
}

// return first present value among candidate column names (handles _10eps / legacy _8eps)
export function pickv(o, ...keys) {
  for (const k of keys) {
    const v = o && o[k];
    if (v != null && v !== '') return v;
  }
  return null;
}

export function weeksAgo(d) {
  if (!d) return '';
  const t = new Date(d);
  if (isNaN(t)) return '';
  const w = Math.floor((Date.now() - t) / 6048e5);
  return w <= 0 ? 'this week' : `${w} week${w > 1 ? 's' : ''} ago`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// Date helpers as YYYY-MM-DD strings (TZ-safe: avoids local-vs-UTC drift).
export function dStr(date) {
  return date.toISOString().slice(0, 10);
}
export function addDays(yyyy_mm_dd, n) {
  const d = new Date(yyyy_mm_dd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return dStr(d);
}

// transient bottom-right toast (client only)
export function toast(msg) {
  if (typeof document === 'undefined') return;
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText =
    'position:fixed;bottom:20px;right:20px;background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;z-index:60;box-shadow:0 8px 24px rgba(0,0,0,.2)';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

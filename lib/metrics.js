// Client-side metric computations — ported verbatim, with rows threaded in.
import { num, pickv } from './format';

// episode date — prefer approved_dt, fall back to the CMS snapshot's publish_date.
const epDate = (e) => pickv(e, 'approved_dt', 'publish_date');

// Reference "today" for the H123-maturity window (anchored to data: max date + 1).
export function fatRefToday(fatRows) {
  let max = null;
  (fatRows || []).forEach((r) => {
    const d = new Date(epDate(r));
    if (!isNaN(d) && (max === null || d > max)) max = d;
  });
  const t = max !== null ? new Date(max) : new Date();
  t.setDate(t.getDate() + 1);
  return t;
}

// Success rate from episode rows: settled-H123 window (today-10..today-4), most-recent 7.
// Canonical definition (matches the Daily RCA and the content_performance SR query):
// SR = status=1 / (status=1 + status=0). A video counts ONLY when it has a settled
// success flag (video_status 1 or 0); status NULL = not yet evaluated and is excluded
// entirely — no CMS-verdict override and no completion-rate fallback.
export function successRate(eps, fatRows) {
  const ref = fatRefToday(fatRows);
  const upper = new Date(ref);
  upper.setDate(upper.getDate() - 4);
  const lower = new Date(ref);
  lower.setDate(lower.getDate() - 10);
  const elig = (eps || [])
    .filter((e) => {
      const st = num(e.video_status);
      if (st !== 0 && st !== 1) return false; // exclude NULL/unevaluated
      const d = new Date(epDate(e));
      return !isNaN(d) && d >= lower && d <= upper;
    })
    .sort((a, b) => new Date(epDate(b)) - new Date(epDate(a)))
    .slice(0, 7);
  if (!elig.length) return { pct: null, pass: 0, n: 0 };
  const pass = elig.filter((e) => num(e.video_status) === 1).length;
  return { pct: Math.round((pass / elig.length) * 100), pass, n: elig.length };
}

// Windowed success rate — SR over videos APPROVED within [fromDate, toDate]
// (inclusive, YYYY-MM-DD). Same status-only definition as successRate (status=1 ÷
// status=1+status=0; NULL excluded) but scoped to a date range and with NO last-7
// cap — it's the full cohort posted in the experiment window. Used to judge
// success-rate experiments from the action date to the review date.
export function windowedSuccessRate(eps, fromDate, toDate) {
  if (!eps || !fromDate || !toDate) return { pct: null, pass: 0, n: 0 };
  const elig = eps.filter((e) => {
    const st = num(e.video_status);
    if (st !== 0 && st !== 1) return false; // exclude NULL/unevaluated
    const d = String(epDate(e) || '').slice(0, 10);
    return d && d >= fromDate && d <= toDate;
  });
  if (!elig.length) return { pct: null, pass: 0, n: 0 };
  const pass = elig.filter((e) => num(e.video_status) === 1).length;
  return { pct: Math.round((pass / elig.length) * 100), pass, n: elig.length };
}

// series_id -> H123 views, from the CMS snapshot CSV (latest `starts`/`views` per series).
export function buildSnapIndex(snapRows) {
  const m = new Map();
  (snapRows || []).forEach((r) => {
    const k = String(r.series_id);
    const v = num(r.views) ?? num(r.starts);
    if (v != null) m.set(k, v);
  });
  return m;
}

// Language average of a show-level fatigue field, over distinct shows.
export function langAvgFat(language, field, fatRows) {
  const seen = new Map();
  (fatRows || []).forEach((r) => {
    if (r.language !== language) return;
    const k = String(r.show_id);
    if (seen.has(k)) return;
    const v = num(r[field]);
    if (v != null) seen.set(k, v);
  });
  const vals = [...seen.values()];
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// GLOBAL (language-level) percentile threshold bars, computed from current-week NSE rows.
export function globalBars(language, evalRows) {
  const rows = (evalRows || []).filter(
    (r) =>
      r.language === language &&
      r.period_type === 'LAST_3_CALENDAR_WEEK' &&
      r.period_name === 'CURRENT_WEEK' &&
      String(r.show_type || '').toLowerCase() !== 'experimental'
  );
  const vals = rows
    .map((r) => num(r.show_users_contrib_pct_of_language) ?? num(r.l3w_current_contrib_pct))
    .filter((v) => v != null)
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  const q = (p) => {
    const i = (vals.length - 1) * p,
      lo = Math.floor(i),
      hi = Math.ceil(i);
    return vals[lo] + (vals[hi] - vals[lo]) * (i - lo);
  };
  return { stop: q(0.25), weak: q(0.4), retain: q(0.6), strong: q(0.75), n: vals.length };
}

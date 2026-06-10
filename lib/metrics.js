// Client-side metric computations — ported verbatim, with rows threaded in.
import { num } from './format';

// Reference "today" for the H123-maturity window (anchored to data: max approved_dt + 1).
export function fatRefToday(fatRows) {
  let max = null;
  (fatRows || []).forEach((r) => {
    const d = new Date(r.approved_dt);
    if (!isNaN(d) && (max === null || d > max)) max = d;
  });
  const t = max !== null ? new Date(max) : new Date();
  t.setDate(t.getDate() + 1);
  return t;
}

// Success rate from episode rows: settled-H123 window (today-10..today-4), most-recent 7.
export function successRate(eps, fatRows) {
  const ref = fatRefToday(fatRows);
  const upper = new Date(ref);
  upper.setDate(upper.getDate() - 4);
  const lower = new Date(ref);
  lower.setDate(lower.getDate() - 10);
  let elig = (eps || [])
    .filter((e) => {
      const h = num(e.h123_completion_rate_pct);
      if (h == null) return false;
      const d = new Date(e.approved_dt);
      return !isNaN(d) && d >= lower && d <= upper;
    })
    .sort((a, b) => new Date(b.approved_dt) - new Date(a.approved_dt))
    .slice(0, 7);
  if (!elig.length) return { pct: null, pass: 0, n: 0 };
  const pass = elig.filter((e) => {
    const st = num(e.video_status);
    if (st === 1) return true;
    if (st === 0) return false;
    const h = num(e.h123_completion_rate_pct),
      t = num(e.targ_comp);
    return t != null && h != null && h >= t;
  }).length;
  return { pct: Math.round((pass / elig.length) * 100), pass, n: elig.length };
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

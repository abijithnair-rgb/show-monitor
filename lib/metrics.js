// Client-side metric computations — ported verbatim, with rows threaded in.
import { num, pickv } from './format';
import { retentionGuardrail } from './constants';

// episode date — prefer approved_dt, fall back to the CMS snapshot's publish_date.
const epDate = (e) => pickv(e, 'approved_dt', 'publish_date');

// Per-episode failure mode from cumulative retention vs the data-backed duration
// floors (the "min %" shown in the Last-10 table). A checkpoint fails when its
// cumulative retention is below its floor; the biggest shortfall wins. All at/
// above floor → OK. null if floors / all retention values are unavailable.
export function failureFromGuardrail(hook, mid, end, g) {
  if (!g) return null;
  const checks = [['HOOK_FAIL', hook, g.hook], ['PACE_FAIL', mid, g.mid], ['ENDING_FAIL', end, g.end]];
  let judged = false, worst = null;
  for (const [mode, v, floor] of checks) {
    if (v == null || floor == null) continue;
    judged = true;
    if (v < floor) {
      const gap = floor - v;
      if (worst == null || gap > worst.gap) worst = { mode, gap };
    }
  }
  if (!judged) return null;
  return worst ? worst.mode : 'OK';
}

// Cumulative retention for an episode (raw columns are step-wise relative; the
// floors are cumulative, so multiply through) — mirrors last10Table.
function epRetention(e) {
  const hookR = num(e.hook_retention_pct) ?? num(e.hook_retention_h123_pct);
  const midR = num(e.mid_retention_pct) ?? num(e.mid_retention_h123_pct);
  const endR = num(e.end_retention_pct) ?? num(e.end_retention_h123_pct);
  const hook = hookR;
  const mid = hookR != null && midR != null ? (hookR * midR) / 100 : midR;
  const end = hookR != null && midR != null && endR != null ? (hookR * midR * endR) / 10000 : endR;
  return { hook, mid, end };
}

// Show-level dominant failure mode, computed from the SAME per-episode guardrail
// the Last-10 table shows (so the fatigue lens always matches the table). Counts
// the failing checkpoints over the last 10 episodes; returns the most-common
// failure ('HOOK'|'PACE'|'ENDING'), 'OK' when nothing fails, or
// 'INSUFFICIENT_DATA' when no episode is judgeable.
// Majority rule: the show is only judged as having a failure mode when MORE THAN
// HALF the evaluable episodes fail. A 50/50 split (or OK-majority) is healthy —
// e.g. 5 OK of 10 → OK; 6 failing of 10 → the most-common of those failures.
// settledOnly=true → consider ONLY episodes whose H123 has settled and the
// outcome is available (video_status 0 or 1); NULL = not yet evaluated, excluded.
// Used for hook/pace/ending fix EXPERIMENTS so an in-flight (unsettled) episode
// can't decide the verdict. The Explorer lens / Last-10 table keep the default
// (all episodes) so they stay consistent with each other.
export function dominantFromEps(eps, { settledOnly = false } = {}) {
  let pool = eps || [];
  if (settledOnly) pool = pool.filter((e) => { const st = num(e.video_status); return st === 0 || st === 1; });
  if (!pool.length) return settledOnly && (eps || []).length ? 'INSUFFICIENT_DATA' : null;
  const sorted = [...pool].sort((a, b) => {
    const da = new Date(epDate(a)), db = new Date(epDate(b));
    if (db - da) return db - da;
    return (num(b.ep_num) || 0) - (num(a.ep_num) || 0);
  }).slice(0, 10);
  const counts = { HOOK: 0, PACE: 0, ENDING: 0 };
  let evaluable = 0;
  for (const e of sorted) {
    const { hook, mid, end } = epRetention(e);
    const g = retentionGuardrail(num(e.video_duration_sec) ?? num(e.duration_s));
    let fm = failureFromGuardrail(hook, mid, end, g);
    if (fm == null) fm = e.failure_mode; // fall back to the query value when unjudgeable
    if (fm == null) continue;
    const base = String(fm).toUpperCase().replace('_FAIL', '');
    if (base === 'HOOK' || base === 'PACE' || base === 'ENDING') { counts[base] += 1; evaluable += 1; }
    else if (base === 'OK') { evaluable += 1; }
    // INSUFFICIENT_VIEWS / SHORT_VIDEO / NO_VIEWERS → not evaluable, skip
  }
  if (!evaluable) return 'INSUFFICIENT_DATA';
  const failing = counts.HOOK + counts.PACE + counts.ENDING;
  // Healthy unless failures are a STRICT majority of evaluable episodes.
  if (failing * 2 <= evaluable) return 'OK';
  const top = ['HOOK', 'PACE', 'ENDING'].reduce((a, b) => (counts[b] > counts[a] ? b : a), 'HOOK');
  return top;
}

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

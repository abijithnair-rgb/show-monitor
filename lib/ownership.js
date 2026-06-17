// Shared logic for the action-ownership / experiment board. Used by the Action
// Queue, the reusable PickupPanel, and the Deep Dive summary. Pure functions.
//
// An "experiment" = a picked-up action with a chosen METRIC and a TARGET. The
// tool snapshots the show's metrics at pickup and auto-judges the experiment:
//   tracking → reached (target hit on/before review) → or failed (review passed,
//   unmet). The owner can override the verdict. Concluded experiments are
//   archived to per-show history.
import { num } from './format';
import { buildHdcIndex } from './hdc';
import { buildFatIndex } from './model';
import { successRate, windowedSuccessRate } from './metrics';

// ---- POC roster (who can be a pickup owner / assignee) ----
export const POCS = ['Aarthi', 'Abijith', 'Deepak', 'Dhananjay', 'Kartikey', 'Manasa', 'Nancy', 'Sasi', 'Surya'];

// ---- Metric catalog (the "which metric are you picking up" dropdown) ----
export const METRIC_OPTIONS = [
  { key: 'success_rate', label: 'Success rate' },
  { key: 'label', label: 'HDC / Label' },
  { key: 'hook_fix', label: 'Hook fix' },
  { key: 'pace_fix', label: 'Pace fix' },
  { key: 'ending_fix', label: 'Ending fix' },
  { key: 'stop', label: 'Stop' },
  { key: 'promote', label: 'Promote' },
];
export const metricLabel = (k) => (METRIC_OPTIONS.find((m) => m.key === k)?.label || k || '—');

// ---- Success-rate target presets (always ≥ 80%) ----
export const SR_TARGETS = [80, 85, 100];
export function srTargetOptions() {
  return SR_TARGETS.map((v) => ({ id: 'sr' + v, label: `Success rate ≥ ${v}%`, target: { kind: 'sr_gte', value: v } }));
}

// ---- Label target builder ----
// CUMULATIVE production over the experiment window: count the videos of `band`
// the show PUBLISHES between the action date and the review date, vs a goal `n`.
//   op 'gte' → "produce at least N {band} by the review date" (floor; good bands)
//   op 'lte' → "produce at most N {band} by the review date"  (ceiling; weak bands)
export const LABEL_BANDS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
export const LABEL_MAX = 7; // a show publishes at most ~7 videos (=labels) a week
export const EXPERIMENT_MAX_DAYS = 14; // review dates capped within the HDC data window
export const clampLabel = (n) => Math.max(0, Math.min(LABEL_MAX, Math.round(Number(n) || 0)));
// L0–L3 are good (aim to produce more → 'gte'); L4/L5 are weak (cap them → 'lte').
export function labelDefaultOp(band) {
  return band === 'L4' || band === 'L5' ? 'lte' : 'gte';
}
export function makeLabelTarget(band, op, n) {
  return { kind: 'label_produce', band, op: op === 'lte' ? 'lte' : 'gte', n: clampLabel(n) };
}

// pickup date (YYYY-MM-DD) from a claim's claimed_at ISO timestamp.
const pickupDate = (claim) => String(claim?.claimed_at || '').slice(0, 10);

// Count videos of `band` a show published in [fromDate, toDate] (inclusive),
// straight from the raw HDC rows (each row = one series with publish_date+Label).
export function cumulativeLabelCount(hdcRows, showId, band, fromDate, toDate) {
  if (!hdcRows || !fromDate || !toDate) return 0;
  const sid = String(showId);
  let c = 0;
  for (const r of hdcRows) {
    if (String(r.show_id) !== sid) continue;
    if (String(r.Label || '').toUpperCase() !== band) continue;
    const pd = String(r.publish_date || '').slice(0, 10);
    if (pd && pd >= fromDate && pd <= toDate) c += 1;
  }
  return c;
}

// The evaluation window for an experiment: from the "Actions to be taken by"
// date (giving the POC lead time to act) to the earlier of today / review date.
// Falls back to the pickup date when no action_date is set.
export function claimWindow(claim, today = todayStr()) {
  const from = claim?.action_date ? String(claim.action_date).slice(0, 10) : pickupDate(claim);
  const rv = claim?.review_date ? String(claim.review_date).slice(0, 10) : today;
  const to = rv < today ? rv : today;
  return { from, to };
}

// Cumulative produced count for a label_produce claim over its evaluation window.
export function producedForClaim(claim, hdcRows, today = todayStr()) {
  if (!claim || claim.target?.kind !== 'label_produce') return null;
  const { from, to } = claimWindow(claim, today);
  return cumulativeLabelCount(hdcRows, claim.show_id, claim.target.band, from, to);
}

// Success rate over a claim's evaluation window — videos approved between the
// action date and the review date for this show. eps = the show's episode rows.
export function srWindowForClaim(claim, eps, today = todayStr()) {
  if (!claim || claim.target?.kind !== 'sr_gte') return null;
  const { from, to } = claimWindow(claim, today);
  return windowedSuccessRate(eps, from, to);
}

// ---- Implied (single) target for the action-style metrics ----
export function impliedTarget(metric) {
  switch (metric) {
    case 'hook_fix': return { kind: 'fix', area: 'HOOK' };
    case 'pace_fix': return { kind: 'fix', area: 'PACE' };
    case 'ending_fix': return { kind: 'fix', area: 'ENDING' };
    case 'stop': return { kind: 'manual', action: 'close' };
    case 'promote': return { kind: 'manual', action: 'activate' };
    default: return null;
  }
}

// Whether a metric uses a chooser (SR dropdown / label 3-box) vs a fixed target.
export const metricHasChooser = (metric) => metric === 'success_rate' || metric === 'label';

// ---- Assignment: only these users may assign experiments to others ----
export const ASSIGNERS = ['deepak'];
export const canAssign = (name) => ASSIGNERS.includes(String(name || '').trim().toLowerCase());

// Map an Action Queue "reason" tag → the metric to pre-select when picking up.
// 'Insufficient data' has no natural lever (null → caller falls back).
export const reasonToMetric = {
  'Success rate': 'success_rate',
  'L5 reach': 'label',
  'Stop': 'stop',
  'Promote': 'promote',
  'Insufficient data': null,
};
// First reason tag (in priority order) that maps to a metric; else success_rate.
export function defaultMetricForReasons(tags) {
  for (const t of tags || []) {
    const m = reasonToMetric[t];
    if (m) return m;
  }
  return 'success_rate';
}

// Human text for any stored target (chips, summaries, history).
export function targetText(target) {
  if (!target) return '—';
  switch (target.kind) {
    case 'sr_gte': return `Success rate ≥ ${target.value}%`;
    case 'label_produce':
      return `Produce ${target.op === 'lte' ? '≤' : '≥'} ${target.n} ${target.band} by review`;
    case 'label_change': { // legacy history records only
      const verb = target.dir === 'dec' ? 'Decrease' : 'Increase';
      if (target.goal != null) return `${verb} ${target.band} by ${target.n} (${target.base ?? '?'}→${target.goal})`;
      if (target.n != null) return `${verb} ${target.band} by ${target.n}`;
      return `${verb} ${target.band} by ${target.pct}%`;
    }
    case 'fix': return `Fix ${String(target.area || '').toLowerCase()}`;
    case 'manual': return target.action === 'close' ? 'Close the show' : target.action === 'activate' ? 'Make active' : 'Manual action';
    // legacy kinds (older history records)
    case 'label_dec': return `Decrease ${target.band} by ${target.pct}%`;
    case 'label_inc': return `Increase ${target.band} by ${target.pct}%`;
    case 'label_add': return `+${target.n} ${target.band}`;
    default: return '—';
  }
}

// ---- Per-show metric snapshot (captured at pickup; recomputed for "current") ----
export function metricSnapshot(s, hdcIdx, fatIdx, fatRows) {
  const ev = s.eval?.cur || {};
  const hd = hdcIdx?.get(s.id);
  const fobj = fatIdx?.get(s.id);
  const eps = fobj?.eps;
  const sr = eps ? successRate(eps, fatRows) : null;
  const labels = {};
  for (let i = 0; i <= 6; i++) labels['L' + i] = hd?.labels ? (hd.labels['L' + i] || 0) : null;
  return {
    contrib: num(ev.l3w_current_contrib_pct),
    users: num(ev.show_users),
    hdcRate: hd && hd.supply ? hd.hdcRatePct : null,
    successRate: sr && sr.n ? sr.pct : null,
    labels,
    dominant: fobj?.show?.show_dominant_failure_mode || null,
    status: s.status || null,
  };
}

export function snapshotFromData(s, data) {
  const hdcIdx = data.hdcRows ? buildHdcIndex(data.hdcRows) : null;
  const fatIdx = data.fatRows ? buildFatIndex(data.fatRows) : null;
  return metricSnapshot(s, hdcIdx, fatIdx, data.fatRows);
}

// Current metric bag for a CLAIM — the live snapshot, adjusted to the claim's
// evaluation window: label_produce gets the cumulative produced count; sr_gte
// gets the success rate of videos posted between the action date and review date
// (overriding the rolling successRate). Use this wherever a claim's verdict /
// current value is evaluated.
export function currentFor(claim, s, data, hdcIdx, fatIdx) {
  const fIdx = fatIdx || (data.fatRows ? buildFatIndex(data.fatRows) : null);
  const cur = metricSnapshot(s, hdcIdx || (data.hdcRows ? buildHdcIndex(data.hdcRows) : null), fIdx, data.fatRows);
  if (claim?.target?.kind === 'label_produce') cur.produced = producedForClaim(claim, data.hdcRows);
  if (claim?.target?.kind === 'sr_gte') {
    const eps = fIdx?.get(s.id)?.eps;
    const w = srWindowForClaim(claim, eps);
    cur.successRate = w && w.n ? w.pct : null; // window SR drives the verdict
    cur.srWindow = w;
  }
  return cur;
}

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- Time-bucket keys (Show Manager tab: weekly / monthly grouping) ----
const pad2 = (n) => String(n).padStart(2, '0');
// Monday-of-week as YYYY-MM-DD (local), so a week buckets Mon–Sun.
export function weekKey(dateLike) {
  const d = new Date(dateLike);
  if (isNaN(d)) return '—';
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// Calendar month as YYYY-MM (local).
export function monthKey(dateLike) {
  const d = new Date(dateLike);
  if (isNaN(d)) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// Mon..Sun date range (YYYY-MM-DD) for a weekKey (= the Monday).
export function weekRange(key) {
  const start = new Date(key + 'T00:00:00');
  if (isNaN(start)) return { start: null, end: null };
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start: ymd(start), end: ymd(end) };
}
// First..last day (YYYY-MM-DD) for a monthKey (YYYY-MM).
export function monthRange(key) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return { start: null, end: null };
  return { start: `${y}-${pad2(m)}-01`, end: ymd(new Date(y, m, 0)) };
}

// ---- Target evaluation ----
// The concrete threshold for a target given the pickup snapshot (for display +
// the reached test). Returns { dir, value, unit, what } or null for manual.
export function targetThreshold(target, snap) {
  if (!target) return null;
  const L = snap?.labels || {};
  const base = (b) => num(L[b]) || 0;
  switch (target.kind) {
    case 'sr_gte': return { dir: '≥', value: target.value, unit: '%', what: 'Success rate' };
    case 'label_produce': return { dir: target.op === 'lte' ? '≤' : '≥', value: target.n, unit: '', what: `${target.band} produced` };
    case 'label_change': {
      // new targets store an absolute goal; fall back to legacy pct math.
      if (target.goal != null) {
        return { dir: target.dir === 'dec' ? '≤' : '≥', value: target.goal, unit: '', what: `${target.band} count` };
      }
      const b = base(target.band);
      if (target.dir === 'dec') return { dir: '≤', value: Math.floor(b * (1 - target.pct / 100)), unit: '', what: `${target.band} count` };
      return { dir: '≥', value: Math.max(b + 1, Math.ceil(b * (1 + target.pct / 100))), unit: '', what: `${target.band} count` };
    }
    case 'fix': return { dir: 'resolve', value: target.area, unit: '', what: 'dominant failure' };
    case 'manual': return { dir: '', value: target.action === 'close' ? 'inactive' : 'active', unit: '', what: 'show status' };
    // legacy
    case 'label_dec': return { dir: '≤', value: Math.floor(base(target.band) * (1 - target.pct / 100)), unit: '', what: `${target.band} count` };
    case 'label_inc': return { dir: '≥', value: Math.max(base(target.band) + 1, Math.ceil(base(target.band) * (1 + target.pct / 100))), unit: '', what: `${target.band} count` };
    case 'label_add': return { dir: '≥', value: base(target.band) + target.n, unit: '', what: `${target.band} count` };
    default: return null;
  }
}

// Current value of the metric the target tracks.
export function currentValue(target, cur) {
  if (!target || !cur) return null;
  switch (target.kind) {
    case 'sr_gte': return cur.successRate;
    case 'label_produce': return cur.produced ?? 0;
    case 'label_change':
    case 'label_dec':
    case 'label_inc':
    case 'label_add': return cur.labels ? num(cur.labels[target.band]) : null;
    case 'fix': return cur.dominant;
    case 'manual': return cur.status;
    default: return null;
  }
}

// Is the target reached given the pickup snapshot and current values?
export function targetReached(target, snap, cur) {
  if (!target) return false;
  const th = targetThreshold(target, snap);
  const v = currentValue(target, cur);
  switch (target.kind) {
    case 'sr_gte': return v != null && v >= target.value;
    case 'label_produce': return v != null && (target.op === 'lte' ? v <= target.n : v >= target.n);
    case 'label_change': return v != null && (target.dir === 'dec' ? v <= th.value : v >= th.value);
    case 'fix': return v != null && String(v).toUpperCase() !== target.area;
    case 'manual':
      return target.action === 'close' ? cur.status === 'inactive'
        : target.action === 'activate' ? cur.status === 'active' : false;
    // legacy
    case 'label_dec': return v != null && v <= th.value;
    case 'label_inc':
    case 'label_add': return v != null && v >= th.value;
    default: return false;
  }
}

// Auto verdict, honouring an owner override. Returns 'tracking'|'reached'|'failed'.
//
// Timing rule (the key thing): a target may only be declared "reached" EARLY if
// hitting it is irreversible — i.e. the tracked value can't move back against the
// target before the review date. Otherwise we must wait for the review date.
//  • "at least N" labels (label_produce gte) — cumulative count only rises, so a
//    hit sticks → report reached as soon as produced ≥ N.
//  • fix / stop / promote — a resolved failure mode or a status change is treated
//    as a sticky outcome → reached as soon as achieved.
//  • success rate (sr_gte) and "at most N" labels (label_produce lte) are NOT
//    monotonic for success: more videos can still drop the SR, and the cap can
//    still be breached. So they stay "tracking" until the review date, then
//    resolve. (An "at most N" cap that's ALREADY exceeded is an irreversible
//    failure, so that one we report immediately.)
export function evalVerdict(claim, cur, today = todayStr()) {
  if (!claim) return 'tracking';
  if (claim.verdict_override === 'reached' || claim.verdict_override === 'failed') return claim.verdict_override;
  const t = claim.target;
  const rd = claim.review_date ? String(claim.review_date).slice(0, 10) : null;
  const reviewReached = rd ? rd <= today : false; // on/after the review date

  // Review-gated: success rate — wait for the window to close on the review date.
  if (t && t.kind === 'sr_gte') {
    if (!reviewReached) return 'tracking';
    return targetReached(t, claim.snapshot, cur) ? 'reached' : 'failed';
  }
  // Review-gated: "at most N" cap — fail early if already breached, else wait.
  if (t && t.kind === 'label_produce' && t.op === 'lte') {
    const v = currentValue(t, cur);
    if (v != null && v > t.n) return 'failed'; // cap breached → irreversible fail
    if (!reviewReached) return 'tracking';
    return v != null && v <= t.n ? 'reached' : 'failed';
  }

  // Sticky / monotonic targets: reach as soon as achieved, else fail at review.
  if (targetReached(t, claim.snapshot, cur)) return 'reached';
  if (reviewReached) return 'failed';
  return 'tracking';
}

export const VERDICT_META = {
  tracking: { chip: 'chip-amber', label: 'Tracking' },
  reached: { chip: 'chip-green', label: 'Target reached' },
  failed: { chip: 'chip-red', label: 'Experiment failed' },
};

// Review date reached (on/before today).
export function reviewDue(claim, today = todayStr()) {
  if (!claim) return false;
  const r = claim.review_date;
  return !!r && String(r).slice(0, 10) <= today;
}

// Show should float to the top of the queue: experiment concluded (reached or
// failed) or its review date has arrived — i.e. the owner needs to act.
export function needsAttention(claim, cur, today = todayStr()) {
  if (!claim) return false;
  const v = evalVerdict(claim, cur, today);
  return v !== 'tracking' || reviewDue(claim, today);
}

// "Since pickup" metric deltas (snapshot vs current) as label lines.
export function sincePickupParts(snap, cur) {
  if (!snap) return [];
  const parts = [];
  const line = (label, was, now, unit, pp) => {
    if (was == null && now == null) return;
    const a = was == null ? '—' : was + unit;
    const b = now == null ? '—' : now + unit;
    if (was != null && now != null && was !== now) {
      const d = Math.round((now - was) * 10) / 10;
      parts.push(`${label} ${a}→${b} (${d >= 0 ? '+' : ''}${d}${pp ? 'pp' : unit})`);
    } else {
      parts.push(`${label} ${a}→${b}`);
    }
  };
  line('HDC', snap.hdcRate, cur.hdcRate, '%', true);
  line('Contrib', snap.contrib, cur.contrib, '%', true);
  line('SR', snap.successRate, cur.successRate, '%', true);
  if (snap.users != null || cur.users != null) parts.push(`Users ${snap.users ?? '—'}→${cur.users ?? '—'}`);
  return parts;
}

// Format the tracked metric's value for a given snapshot bag (pickup or current).
// e.g. success rate → "67%", label band → "4", fix → "HOOK", manual → "active".
export function trackedValueText(target, bag) {
  if (!target || !bag) return '—';
  const v = currentValue(target, bag);
  if (v == null || v === '') return '—';
  const th = targetThreshold(target, bag);
  return th && th.unit ? `${v}${th.unit}` : String(v);
}

// One-line progress against the target, e.g. "Success rate 67%→80% (target ≥85%)".
export function progressLine(claim, cur) {
  const t = claim?.target;
  if (!t) return null;
  if (t.kind === 'manual') {
    return `Show status ${claim.snapshot?.status || '—'}→${cur?.status || '—'} (target: ${targetText(t)})`;
  }
  if (t.kind === 'label_produce') {
    return `${t.band} produced so far: ${cur?.produced ?? 0} of ${t.op === 'lte' ? '≤' : '≥'} ${t.n} (from the action date to review)`;
  }
  if (t.kind === 'sr_gte') {
    const w = cur?.srWindow;
    const so = w && w.n ? `${w.pct}% (${w.pass}/${w.n})` : 'no settled videos yet';
    return `Success rate of videos posted action→review: ${so} (target ≥ ${t.value}%)`;
  }
  const th = targetThreshold(t, claim?.snapshot);
  if (!th) return null;
  const was = currentValue(t, claim.snapshot);
  const now = currentValue(t, cur);
  const fmt = (x) => (x == null ? '—' : x + th.unit);
  if (t.kind === 'fix') {
    return `Dominant failure ${was || '—'}→${now || '—'} (target: ${targetText(t)})`;
  }
  return `${th.what} ${fmt(was)}→${fmt(now)} (target: ${targetText(t)})`;
}

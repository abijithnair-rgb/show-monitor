// Shared logic for the action-ownership / experiment board. Used by the Action
// Queue, the reusable PickupPanel, and the Deep Dive summary. Pure functions.
//
// An "experiment" = a picked-up action with a chosen METRIC and a TARGET. The
// tool snapshots the show's metrics at pickup and auto-judges the experiment:
//   tracking → reached (target hit on/before review) → or failed (review passed,
//   unmet). The owner can override the verdict. Concluded experiments are
//   archived to per-show history.
import { num, addDays } from './format';
import { buildHdcIndex } from './hdc';
import { buildFatIndex } from './model';
import { successRate, windowedSuccessRate, dominantFromEps } from './metrics';

// ---- Rosters ----
// POCS = people who can OWN/be assigned an experiment (the pickup/assignee lists).
// MANAGERS = oversight role: they don't run experiments but can assign, update,
//   conclude or discard ANY experiment. ROSTER = everyone who can sign in (the
//   "You:" identity picker + the Show Manager tab roster).
export const POCS = ['Aarthi', 'Abijith', 'Dhananjay', 'Kartikey', 'Manasa', 'Nancy', 'Sasi', 'Surya'];
export const MANAGERS = ['Deepak'];
export const ROSTER = [...POCS, ...MANAGERS];

// ---- Metric catalog (the "which metric are you picking up" dropdown) ----
export const METRIC_OPTIONS = [
  { key: 'success_rate', label: 'Success rate' },
  { key: 'label', label: 'HDC / Label' },
  { key: 'frequency', label: 'Frequency' },
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

// ---- Frequency target builder ----
// Publishing cadence over the experiment window (count of videos the show
// PUBLISHES between the action date and the review date, any label):
//   op 'gte' → "up to N"   — raise cadence to at least N (reached when count ≥ N)
//   op 'lte' → "down to N" — cut cadence to at most N  (reached when count ≤ N)
export const FREQ_MIN = 1;
export const FREQ_MAX = 7;
// A frequency experiment also requires the show's success rate over the
// action→review window to be ≥ this %, on top of hitting the cadence number.
export const FREQ_SR_PASS = 75;
export const clampFreq = (n) => Math.max(FREQ_MIN, Math.min(FREQ_MAX, Math.round(Number(n) || FREQ_MIN)));
export function makeFrequencyTarget(op, n) {
  return { kind: 'frequency', op: op === 'lte' ? 'lte' : 'gte', n: clampFreq(n) };
}

// Count ALL videos a show published in [fromDate, toDate] (inclusive) — total
// cadence, irrespective of label.
export function cumulativeVideoCount(hdcRows, showId, fromDate, toDate) {
  if (!hdcRows || !fromDate || !toDate) return 0;
  const sid = String(showId);
  let c = 0;
  for (const r of hdcRows) {
    if (String(r.show_id) !== sid) continue;
    const pd = String(r.publish_date || '').slice(0, 10);
    if (pd && pd >= fromDate && pd <= toDate) c += 1;
  }
  return c;
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

// Frequency = videos approved in a 7-DAY interval (not the whole window). We
// measure the most-recent 7 days of the evaluation window — [max(from, to-6), to]
// — so "up to 7/wk" means 7 videos within a single week, even when the action→
// review window is longer than 7 days. When the window is ≤7 days it's the whole
// window.
export function frequencyForClaim(claim, hdcRows, today = todayStr()) {
  if (!claim || claim.target?.kind !== 'frequency') return null;
  const { from, to } = claimWindow(claim, today);
  const sevenAgo = addDays(to, -6);
  const winStart = from > sevenAgo ? from : sevenAgo;
  return cumulativeVideoCount(hdcRows, claim.show_id, winStart, to);
}

// Success rate over a frequency claim's full action→review window (the second
// condition: a frequency experiment also needs SR ≥ FREQ_SR_PASS).
export function frequencySrForClaim(claim, eps, today = todayStr()) {
  if (!claim || claim.target?.kind !== 'frequency') return null;
  const { from, to } = claimWindow(claim, today);
  return windowedSuccessRate(eps, from, to);
}

// Success rate that judges a success-rate experiment: the show's canonical
// trailing-7-day settled SR (videos published D-10..D-4) as of the review/data
// day — the SAME definition used everywhere else — NOT the action→review window.
// eps = the show's episode rows; fatRows pins the reference day.
export function srWindowForClaim(claim, eps, fatRows) {
  if (!claim || claim.target?.kind !== 'sr_gte') return null;
  return successRate(eps, fatRows);
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

// ---- Roles & permissions ----
// Managers have oversight over every experiment (assign / update / conclude /
// discard), regardless of who owns it.
export const isManager = (name) => MANAGERS.some((m) => m.toLowerCase() === String(name || '').trim().toLowerCase());
// Only managers may assign experiments to others.
export const canAssign = (name) => isManager(name);
// Who may edit a specific claim: its owner, or any manager.
export const canManageClaim = (claim, name) => {
  const n = String(name || '').trim();
  if (!claim || !n) return false;
  return claim.by === n || isManager(n);
};

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
    case 'frequency':
      return `${target.op === 'lte' ? 'Down to ≤' : 'Up to ≥'} ${target.n} videos/wk + SR ≥ ${FREQ_SR_PASS}% by review`;
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
    // dominant failure mode for hook/pace/ending fix experiments — counts ONLY
    // settled series (H123 settled, outcome available; video_status 0/1) so an
    // in-flight episode can't decide the verdict. (The Explorer lens / Last-10
    // table use the unfiltered dominant and stay consistent with each other.)
    dominant: eps ? dominantFromEps(eps, { settledOnly: true }) : null,
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
  if (claim?.target?.kind === 'frequency') {
    cur.frequency = frequencyForClaim(claim, data.hdcRows);
    cur.frequencySr = frequencySrForClaim(claim, fIdx?.get(s.id)?.eps);
  }
  if (claim?.target?.kind === 'sr_gte') {
    const eps = fIdx?.get(s.id)?.eps;
    const w = srWindowForClaim(claim, eps, data.fatRows);
    cur.successRate = w && w.n ? w.pct : null; // trailing-7d SR drives the verdict
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
// Tuesday-of-week as YYYY-MM-DD (local), so a week buckets Tue–Mon.
export function weekKey(dateLike) {
  const d = new Date(dateLike);
  if (isNaN(d)) return '—';
  const day = (d.getDay() - 2 + 7) % 7; // 0 = Tuesday
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
// Tue..Mon date range (YYYY-MM-DD) for a weekKey (= the Tuesday).
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
    case 'frequency': return { dir: target.op === 'lte' ? '≤' : '≥', value: target.n, unit: '', what: 'videos published' };
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
    case 'frequency': return cur.frequency ?? 0;
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
    case 'frequency': {
      // Frequency is reached only when BOTH the cadence number is met AND the
      // success rate over the window is ≥ FREQ_SR_PASS.
      if (v == null) return false;
      const okCadence = target.op === 'lte' ? v <= target.n : v >= target.n;
      const sr = cur.frequencySr;
      const okSr = !!(sr && sr.n && sr.pct >= FREQ_SR_PASS);
      return okCadence && okSr;
    }
    case 'label_change': return v != null && (target.dir === 'dec' ? v <= th.value : v >= th.value);
    // A hook/pace/ending fix is reached only when the drop-off is actually
    // resolved — the dominant failure mode is healthy (OK). It is NOT enough for
    // the dominant failure to merely differ from the target area (the show could
    // still be failing on another mode).
    case 'fix': return String(v || '').toUpperCase() === 'OK';
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
  // Review-gated: frequency — the 7-day cadence isn't monotonic and the SR
  // condition needs the full window, so always wait for the review date, then
  // succeed only if BOTH cadence and SR ≥ FREQ_SR_PASS hold (handled in targetReached).
  if (t && t.kind === 'frequency') {
    if (!reviewReached) return 'tracking';
    return targetReached(t, claim.snapshot, cur) ? 'reached' : 'failed';
  }
  // Review-gated: "at most N" cap (label "at most") — the count only rises, so
  // fail early if already breached, else wait for review.
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
  if (t.kind === 'frequency') {
    const w = cur?.frequencySr;
    const sr = w && w.n ? `${w.pct}% (${w.pass}/${w.n})` : 'no settled videos yet';
    return `Cadence (videos in a 7-day window): ${cur?.frequency ?? 0} of ${t.op === 'lte' ? '≤' : '≥'} ${t.n}/wk · SR action→review: ${sr} (need ≥ ${FREQ_SR_PASS}%)`;
  }
  if (t.kind === 'sr_gte') {
    const w = cur?.srWindow;
    const so = w && w.n ? `${w.pct}% (${w.pass}/${w.n})` : 'no settled videos yet';
    return `Success rate (trailing 7d, settled D-10→D-4): ${so} (target ≥ ${t.value}%)`;
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

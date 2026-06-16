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
import { successRate } from './metrics';

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

// ---- Label target builder (the 3-box picker: band · direction · count) ----
export const LABEL_BANDS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
export const LABEL_MAX = 7; // a show can publish at most ~7 videos (=labels) a week
export const clampLabel = (n) => Math.max(0, Math.min(LABEL_MAX, Math.round(Number(n) || 0)));
// L0–L3 are good bands (you want more → increase by default); L4/L5 are weak
// bands (you want fewer → decrease by default).
export function labelDefaultDir(band) {
  return band === 'L4' || band === 'L5' ? 'dec' : 'inc';
}
// Target is an absolute, CUMULATIVE count: from the current count at pickup
// (`base`), move by `n` (0–7) in `dir` → `goal` (clamped 0–7). e.g. L2 base 3,
// increase by 1 → goal 4; on the review date L2 must reach 4 (inc) / drop to 4 (dec).
export function makeLabelTarget(band, dir, n, base) {
  const b = clampLabel(base);
  const delta = clampLabel(n);
  const goal = dir === 'dec' ? Math.max(0, b - delta) : Math.min(LABEL_MAX, b + delta);
  return { kind: 'label_change', band, dir, n: delta, base: b, goal };
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

// Human text for any stored target (chips, summaries, history).
export function targetText(target) {
  if (!target) return '—';
  switch (target.kind) {
    case 'sr_gte': return `Success rate ≥ ${target.value}%`;
    case 'label_change': {
      const verb = target.dir === 'dec' ? 'Decrease' : 'Increase';
      // new (absolute/cumulative) targets carry base+goal; show "L2 3→4".
      if (target.goal != null) return `${verb} ${target.band} by ${target.n} (${target.base ?? '?'}→${target.goal})`;
      if (target.n != null) return `${verb} ${target.band} by ${target.n}`;
      return `${verb} ${target.band} by ${target.pct}%`; // legacy pct
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

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
export function evalVerdict(claim, cur, today = todayStr()) {
  if (!claim) return 'tracking';
  if (claim.verdict_override === 'reached' || claim.verdict_override === 'failed') return claim.verdict_override;
  if (targetReached(claim.target, claim.snapshot, cur)) return 'reached';
  if (claim.review_date && String(claim.review_date).slice(0, 10) < today) return 'failed';
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

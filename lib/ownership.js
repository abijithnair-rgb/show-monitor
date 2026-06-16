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

// ---- Target options per metric (the target dropdown) ----
// Each option: { id, label, target }. The `target` object is what gets stored
// and evaluated. Relative label targets read the pickup snapshot at eval time.
export function targetOptions(metric) {
  switch (metric) {
    case 'success_rate':
      return [70, 75, 80, 85, 90].map((v) => ({ id: 'sr' + v, label: `Success rate ≥ ${v}%`, target: { kind: 'sr_gte', value: v } }));
    case 'label':
      return [
        { id: 'l5d30', label: 'Decrease L5 by 30%', target: { kind: 'label_dec', band: 'L5', pct: 30 } },
        { id: 'l5d50', label: 'Decrease L5 by 50%', target: { kind: 'label_dec', band: 'L5', pct: 50 } },
        { id: 'l4d30', label: 'Decrease L4 by 30%', target: { kind: 'label_dec', band: 'L4', pct: 30 } },
        { id: 'l0a1', label: '+1 L0 (HDC) content', target: { kind: 'label_add', band: 'L0', n: 1 } },
        { id: 'l2a1', label: '+1 L2 content', target: { kind: 'label_add', band: 'L2', n: 1 } },
        { id: 'l3i20', label: 'Increase L3 by 20%', target: { kind: 'label_inc', band: 'L3', pct: 20 } },
      ];
    case 'hook_fix':
      return [{ id: 'hook', label: 'Resolve hook drop-off', target: { kind: 'fix', area: 'HOOK' } }];
    case 'pace_fix':
      return [{ id: 'pace', label: 'Resolve pace drop-off', target: { kind: 'fix', area: 'PACE' } }];
    case 'ending_fix':
      return [{ id: 'ending', label: 'Resolve ending drop-off', target: { kind: 'fix', area: 'ENDING' } }];
    case 'stop':
      return [{ id: 'stop', label: 'Stop the show', target: { kind: 'manual' } }];
    case 'promote':
      return [{ id: 'promote', label: 'Promote to production', target: { kind: 'manual' } }];
    default:
      return [];
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
    case 'label_dec': return { dir: '≤', value: Math.floor(base(target.band) * (1 - target.pct / 100)), unit: '', what: `${target.band} count` };
    case 'label_inc': return { dir: '≥', value: Math.max(base(target.band) + 1, Math.ceil(base(target.band) * (1 + target.pct / 100))), unit: '', what: `${target.band} count` };
    case 'label_add': return { dir: '≥', value: base(target.band) + target.n, unit: '', what: `${target.band} count` };
    case 'fix': return { dir: 'resolve', value: target.area, unit: '', what: 'dominant failure' };
    default: return null;
  }
}

// Current value of the metric the target tracks.
export function currentValue(target, cur) {
  if (!target || !cur) return null;
  switch (target.kind) {
    case 'sr_gte': return cur.successRate;
    case 'label_dec':
    case 'label_inc':
    case 'label_add': return cur.labels ? num(cur.labels[target.band]) : null;
    case 'fix': return cur.dominant;
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
    case 'label_dec': return v != null && v <= th.value;
    case 'label_inc':
    case 'label_add': return v != null && v >= th.value;
    case 'fix': return v != null && String(v).toUpperCase() !== target.area;
    default: return false; // manual — only via override
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

// One-line progress against the target, e.g. "Success rate 67%→80% (target ≥85%)".
export function progressLine(claim, cur) {
  const th = targetThreshold(claim?.target, claim?.snapshot);
  if (!th) return null;
  const was = currentValue(claim.target, claim.snapshot);
  const now = currentValue(claim.target, cur);
  const fmt = (x) => (x == null ? '—' : x + th.unit);
  if (claim.target.kind === 'fix') {
    return `Dominant failure ${was || '—'}→${now || '—'} (target: no longer ${th.value})`;
  }
  return `${th.what} ${fmt(was)}→${fmt(now)} (target ${th.dir} ${th.value}${th.unit})`;
}

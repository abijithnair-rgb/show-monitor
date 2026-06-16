// Shared logic for the action-ownership board (used by the Action Queue tab,
// the Deep Dive pickup card, and the reusable PickupPanel). Pure functions only.
import { num } from './format';
import { buildHdcIndex } from './hdc';
import { buildFatIndex } from './model';
import { successRate } from './metrics';

// Per-show live metric snapshot — captured at pickup so we can show the delta
// since. Same fields the AI snapshot uses.
export function metricSnapshot(s, hdcIdx, fatIdx, fatRows) {
  const ev = s.eval?.cur || {};
  const hd = hdcIdx?.get(s.id);
  const eps = fatIdx?.get(s.id)?.eps;
  const sr = eps ? successRate(eps, fatRows) : null;
  return {
    contrib: num(ev.l3w_current_contrib_pct),
    users: num(ev.show_users),
    hdcRate: hd && hd.supply ? hd.hdcRatePct : null,
    successRate: sr && sr.n ? sr.pct : null,
  };
}

// Convenience: build the snapshot straight from the raw `data` object (rebuilds
// the indices). Fine for one-off use in Deep Dive.
export function snapshotFromData(s, data) {
  const hdcIdx = data.hdcRows ? buildHdcIndex(data.hdcRows) : null;
  const fatIdx = data.fatRows ? buildFatIndex(data.fatRows) : null;
  return metricSnapshot(s, hdcIdx, fatIdx, data.fatRows);
}

// Today as YYYY-MM-DD (local).
export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A claim is "review due" when it has a review_date that has arrived (<= today)
// and the work isn't already done. These float to the top of the queue.
export function reviewDue(claim, today = todayStr()) {
  if (!claim || claim.status === 'done') return false;
  const r = claim.review_date;
  return !!r && String(r).slice(0, 10) <= today;
}

// Format the "since pickup" metric deltas (snapshot vs current) as label lines.
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

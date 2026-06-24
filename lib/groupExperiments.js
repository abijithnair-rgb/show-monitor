// Group-level experiments (scope = language / BU / POC) for the Experiments tab.
//
// A group experiment targets an AGGREGATE "movement metric" — L0..L5 label
// counts, success rate, or supply (videos posted) — across every show in a
// scope, instead of a single show. It mirrors the per-show ownership.js model
// (metric + target + snapshot + auto-judged verdict), but the "current" value is
// computed by POOLING the scope's shows. Examples the board supports:
//   • language: "Malayalam success rate ≥ 85%", "Malayalam L0 count → 0"
//   • bu:       "all Skill shows success rate ≥ 80%"
//   • poc:      "every show under a POC success rate ≥ 80%"
import { dStr, LANG_NAMES, num, pickv } from './format';
import { buildHdcIndex } from './hdc';
import { fatRefToday } from './metrics';
import {
  cumulativeLabelCount, cumulativeVideoCount, claimWindow, todayStr, reviewDue,
  CONSTRAINT_METRICS, makeConstraint, constraintMet, constraintLabel, cleanConstraints, LABEL_BANDS,
} from './ownership';

// Re-export the shared constraint helpers so the group UI imports from one place.
export { CONSTRAINT_METRICS, makeConstraint, constraintMet, constraintLabel, cleanConstraints };

// ---- Scopes ----
export const GROUP_SCOPES = [
  { key: 'language', label: 'Language' },
  { key: 'bu', label: 'Business unit' },
  { key: 'category', label: 'Category' },
  { key: 'poc', label: 'POC' },
];
export const scopeMetaLabel = (k) => GROUP_SCOPES.find((s) => s.key === k)?.label || k;

// The model field a scope groups on (single-field scopes only; `category` is a
// composite scope handled separately).
const scopeField = (s, scope) =>
  scope === 'language' ? s.language : scope === 'bu' ? s.bu : s.manager;

// ---- Category scope (optionally bifurcated by language) ----
// A category scope value is either the bare category ("Comedy" → that category
// across every language) or "<category>::<lang>" ("Comedy::hi" → Comedy shows in
// Hindi only). Every language carries the same category set, so a category
// experiment can be run pan-language or per-language.
const CAT_LANG_SEP = '::';
export function parseCategoryScopeValue(value) {
  const v = String(value || '');
  const i = v.indexOf(CAT_LANG_SEP);
  if (i === -1) return { category: v, lang: null };
  return { category: v.slice(0, i), lang: v.slice(i + CAT_LANG_SEP.length) || null };
}
export const makeCategoryScopeValue = (category, lang) =>
  lang ? `${category}${CAT_LANG_SEP}${lang}` : String(category || '');

// Distinct categories in the model, with a show count, sorted by label.
export function categoryValues(model) {
  const counts = new Map();
  (model || []).forEach((s) => {
    const c = s.category;
    if (c == null || c === '') return;
    counts.set(c, (counts.get(c) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([value, n]) => ({ value, n, label: value }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

// Languages present for a given category, with a show count, sorted by label.
export function categoryLanguageValues(model, category) {
  const counts = new Map();
  (model || []).forEach((s) => {
    if ((s.category || '') !== category) return;
    const lg = s.language || '';
    if (!lg) return;
    counts.set(lg, (counts.get(lg) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([value, n]) => ({ value, n, label: LANG_NAMES[value] || value }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

// Human label for a scope value (languages get their full name; category shows
// the language split when present).
export const scopeValueLabel = (scope, value) => {
  if (scope === 'category') {
    const { category, lang } = parseCategoryScopeValue(value);
    return lang ? `${category} · ${LANG_NAMES[lang] || lang}` : `${category} (all languages)`;
  }
  return scope === 'language' ? (LANG_NAMES[value] || value) : value;
};

// All shows in `model` that belong to a scope value.
export function scopeShows(model, scope, value) {
  if (!model || !value) return [];
  if (scope === 'category') {
    const { category, lang } = parseCategoryScopeValue(value);
    return model.filter((s) => (s.category || '') === category && (!lang || (s.language || '') === lang));
  }
  return model.filter((s) => (scopeField(s, scope) || '') === value);
}

// Distinct scope values present in the model, with a show count, sorted by label.
// For the category scope this is a flat list: each category's pan-language option
// followed by its per-language splits.
export function scopeOptions(model, scope) {
  if (scope === 'category') {
    const out = [];
    categoryValues(model).forEach((c) => {
      out.push({ value: c.value, n: c.n, label: scopeValueLabel('category', c.value) });
      categoryLanguageValues(model, c.value).forEach((lg) => {
        const v = makeCategoryScopeValue(c.value, lg.value);
        out.push({ value: v, n: lg.n, label: scopeValueLabel('category', v) });
      });
    });
    return out;
  }
  const counts = new Map();
  (model || []).forEach((s) => {
    const v = scopeField(s, scope);
    if (v == null || v === '') return;
    counts.set(v, (counts.get(v) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([value, n]) => ({ value, n, label: scopeValueLabel(scope, value) }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

// ---- Metric catalog (drives the metric boxes) ----
export const GROUP_LABEL_BANDS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
export const GROUP_METRICS = [
  ...GROUP_LABEL_BANDS.map((b) => ({ key: b, kind: 'label', band: b, label: `${b} count`, unit: '' })),
  { key: 'success_rate', kind: 'sr', label: 'Success rate', unit: '%' },
  { key: 'supply', kind: 'supply', label: 'Supply', unit: '' },
];
export const groupMetric = (k) => GROUP_METRICS.find((m) => m.key === k) || null;
export const groupMetricLabel = (k) => groupMetric(k)?.label || k;

// Canonical success rate for an arbitrary set of shows, summed from the per-show
// `langsr` dataset (sql/success_rate.sql / combined.sql) which matches the team's
// source-of-truth SR query EXACTLY (active+live shows, distinct settled series in
// the published window, status=1 ÷ status=1+status=0). Rolling it up by summing
// successful & failed across the scope's shows makes language / BU / POC all
// exact. Returns { pct, pass, n } or null when the dataset is absent / no match.
export function scopeSuccessRate(data, shows) {
  const rows = data?.langsrRows;
  if (!rows || !rows.length) return null;
  const ids = new Set((shows || []).map((s) => String(s.id)));
  const bySid = new Map(rows.map((r) => [String(r.show_id), r]));
  let pass = 0, fail = 0, matched = false;
  ids.forEach((id) => {
    const r = bySid.get(id);
    if (!r) return;
    matched = true;
    pass += num(r.successful) || 0;
    fail += num(r.failed) || 0;
  });
  if (!matched) return null;
  const n = pass + fail;
  return { pct: n ? Math.round((pass / n) * 100) : null, pass, n };
}

// Evaluate constraints on a GROUP claim, summed/aggregated across the scope's
// shows → [{ c, value, met, label }]. success_rate uses the canonical scope SR
// (trailing-7d); supply / L0..L5 sum over the claim's action→review window.
export function evalGroupConstraints(claim, shows, data, today = todayStr()) {
  const list = Array.isArray(claim?.constraints) ? claim.constraints : [];
  if (!list.length) return [];
  const ids = (shows || []).map((s) => String(s.id));
  const { from, to } = claimWindow(claim, today);
  return list.map((c) => {
    let value = null;
    if (c.metric === 'success_rate') {
      const sr = scopeSuccessRate(data, shows) || pooledCanonicalSR(shows, data?.fatRows, srTrailingWindow(data?.fatRows).from, srTrailingWindow(data?.fatRows).to);
      value = sr && sr.n ? sr.pct : null;
    } else if (c.metric === 'supply') {
      value = ids.reduce((acc, id) => acc + cumulativeVideoCount(data?.hdcRows, id, from, to), 0);
    } else if (LABEL_BANDS.includes(c.metric)) {
      value = ids.reduce((acc, id) => acc + cumulativeLabelCount(data?.hdcRows, id, c.metric, from, to), 0);
    }
    return { c, value, met: constraintMet(c, value), label: constraintLabel(c) };
  });
}

// Pooled canonical success rate, computed client-side from the fatigue rows so it
// works for ANY scope (language / BU / POC) without the precomputed SQL column.
// Mirrors the team's source-of-truth SR query: ACTIVE shows only, videos
// published in [fromStr, toStr], counted over DISTINCT series with a settled
// status (1/0; NULL excluded), then SR = series status=1 ÷ (status=1 + status=0).
// published_dt is the date basis (the SR query keys on publish_date), then
// approved_dt. Returns { pct, pass, n } — pct null when no settled series.
function pooledCanonicalSR(shows, fatRows, fromStr, toStr) {
  if (!shows || !fatRows || !fromStr || !toStr) return { pct: null, pass: 0, n: 0 };
  const idSet = new Set(
    shows.filter((s) => s.status === 'active').map((s) => String(s.id))
  );
  if (!idSet.size) return { pct: null, pass: 0, n: 0 };
  const bySeries = new Map(); // series_id -> settled status (1 wins over 0)
  for (const r of fatRows) {
    if (!idSet.has(String(r.show_id))) continue;
    const st = num(r.video_status);
    if (st !== 0 && st !== 1) continue; // NULL / unevaluated excluded
    const d = String(pickv(r, 'published_dt', 'publish_date', 'approved_dt') || '').slice(0, 10);
    if (!d || d < fromStr || d > toStr) continue;
    const key = String(r.series_id ?? r.show_id);
    bySeries.set(key, bySeries.get(key) === 1 ? 1 : st);
  }
  const vals = [...bySeries.values()];
  if (!vals.length) return { pct: null, pass: 0, n: 0 };
  const pass = vals.filter((v) => v === 1).length;
  return { pct: Math.round((pass / vals.length) * 100), pass, n: vals.length };
}

// ---- Live aggregate snapshot (the metric-box values + the pickup snapshot) ----
// Labels + supply over the last-7-day HDC window (buildHdcIndex's window);
// success rate over the standard settled-H123 window, pooled across the scope.
// For the LANGUAGE scope the success rate instead uses the canonical per-language
// number precomputed in fatigue.sql (active+live shows, published-date window) so
// it matches the team's source-of-truth SR query exactly.
export function groupLiveSnapshot(shows, data, scope, scopeValue) {
  const ids = (shows || []).map((s) => String(s.id));
  const hdcIdx = data?.hdcRows ? buildHdcIndex(data.hdcRows) : null;
  const labels = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
  let supply = 0;
  let withSupply = 0;
  if (hdcIdx) {
    ids.forEach((id) => {
      const h = hdcIdx.get(id);
      if (!h) return;
      supply += h.supply || 0;
      if (h.supply) withSupply += 1;
      GROUP_LABEL_BANDS.forEach((b) => { labels[b] += h.labels?.[b] || 0; });
    });
  }
  // Success rate over the [ref-10, ref-4] settled window. Language scope prefers
  // the canonical precomputed per-language number when the CSV carries it, and
  // otherwise (and for BU / POC) pools the scope's ACTIVE shows with the same
  // active-shows / distinct-series definition as the source-of-truth SR query.
  // Prefer the canonical per-show SR dataset (exact at any scope); fall back to
  // client-pooling the fatigue rows over the settled window when it's absent.
  let sr = scopeSuccessRate(data, shows);
  if (!sr && data?.fatRows) {
    const win = srTrailingWindow(data.fatRows);
    sr = pooledCanonicalSR(shows, data.fatRows, win.from, win.to);
  }
  sr = sr || { pct: null, pass: 0, n: 0 };
  return {
    labels,
    supply: hdcIdx ? supply : null,
    successRate: sr.pct,
    srPass: sr.pass,
    srN: sr.n,
    shows: ids.length,
    activeShows: withSupply,
  };
}

// Current value of a metric box (live snapshot) for display.
export function liveMetricValue(metricKey, snap) {
  const m = groupMetric(metricKey);
  if (!m || !snap) return null;
  if (m.kind === 'sr') return snap.successRate;
  if (m.kind === 'supply') return snap.supply;
  return snap.labels?.[m.band] ?? null;
}

// ---- Target builders / text ----
export function makeGroupTarget(metricKey, op, value) {
  const m = groupMetric(metricKey);
  if (!m) return null;
  if (m.kind === 'sr') {
    const v = Number(value);
    if (!(v >= 1 && v <= 100)) return null;
    return { kind: 'sr_gte', value: Math.round(v * 10) / 10 };
  }
  const n = Math.round(Number(value));
  if (isNaN(n) || n < 0) return null;
  const o = op === 'lte' ? 'lte' : 'gte';
  if (m.kind === 'label') return { kind: 'label_count', band: m.band, op: o, n };
  if (m.kind === 'supply') return { kind: 'supply', op: o, n };
  return null;
}

// Default direction for a metric box's pickup form. SR is always "≥"; labels
// default to reducing (≤) — the common move is cutting low-demand output — and
// supply to raising (≥). The owner can flip it.
export function defaultGroupOp(metricKey) {
  const m = groupMetric(metricKey);
  if (!m || m.kind === 'sr') return 'gte';
  if (m.kind === 'supply') return 'gte';
  return 'lte';
}

export function groupTargetText(t) {
  if (!t) return '—';
  if (t.kind === 'sr_gte') return `Success rate ≥ ${t.value}%`;
  if (t.kind === 'label_count') return `${t.band} count ${t.op === 'lte' ? '≤' : '≥'} ${t.n} by review`;
  if (t.kind === 'supply') return `Supply ${t.op === 'lte' ? '≤' : '≥'} ${t.n} videos by review`;
  return '—';
}

// The metric box a stored target maps back to (for highlighting boxes in use).
export function groupMetricKeyOfTarget(t) {
  if (!t) return null;
  if (t.kind === 'sr_gte') return 'success_rate';
  if (t.kind === 'supply') return 'supply';
  if (t.kind === 'label_count') return t.band;
  return null;
}

// The trailing-7d settled SR window [ref-10 .. ref-4] (ref = fatRefToday), as
// { from, to } YYYY-MM-DD. SR experiments are judged on THIS window as of the
// review/data day — not the experiment's action→review span.
function srTrailingWindow(fatRows) {
  const ref = fatRefToday(fatRows);
  const u = new Date(ref); u.setDate(u.getDate() - 4);
  const l = new Date(ref); l.setDate(l.getDate() - 10);
  return { from: dStr(l), to: dStr(u) };
}

// ---- Current aggregate for a running claim ----
// SR is judged on the scope's trailing-7d window (D-10..D-4) as of the review
// day; label/supply counts accumulate over the claim's action→review window.
export function groupCurrentFor(claim, shows, data) {
  const ids = (shows || []).map((s) => String(s.id));
  const t = claim?.target;
  if (!t) return {};
  const { from, to } = claimWindow(claim);
  if (t.kind === 'sr_gte') {
    // Canonical per-show SR dataset rolled up to the scope (the precomputed
    // langsr is itself the trailing-7d settled window). When absent, pool the
    // fatigue rows over the SAME trailing-7d window — NOT the claim window.
    const win = srTrailingWindow(data?.fatRows);
    const sr = scopeSuccessRate(data, shows) || pooledCanonicalSR(shows, data?.fatRows, win.from, win.to);
    return { successRate: sr && sr.n ? sr.pct : null, srWindow: sr };
  }
  if (t.kind === 'label_count') {
    let c = 0;
    ids.forEach((id) => { c += cumulativeLabelCount(data.hdcRows, id, t.band, from, to); });
    return { produced: c };
  }
  if (t.kind === 'supply') {
    let c = 0;
    ids.forEach((id) => { c += cumulativeVideoCount(data.hdcRows, id, from, to); });
    return { supply: c };
  }
  return {};
}

export function groupCurrentValue(t, cur) {
  if (!t || !cur) return null;
  if (t.kind === 'sr_gte') return cur.successRate;
  if (t.kind === 'label_count') return cur.produced ?? 0;
  if (t.kind === 'supply') return cur.supply ?? 0;
  return null;
}

export function groupTargetReached(t, cur) {
  const v = groupCurrentValue(t, cur);
  if (t == null) return false;
  if (t.kind === 'sr_gte') return v != null && v >= t.value;
  if (t.kind === 'label_count' || t.kind === 'supply') {
    return v != null && (t.op === 'lte' ? v <= t.n : v >= t.n);
  }
  return false;
}

// ---- Verdict (same timing rules as ownership.evalVerdict) ----
//  • sr_gte               → review-gated (SR isn't monotonic).
//  • count "≥ N"          → cumulative count only rises → declare reached early.
//  • count "≤ N"          → fail early if already breached, else review-gated.
export function groupEvalVerdict(claim, cur, today = todayStr()) {
  if (!claim) return 'tracking';
  if (claim.verdict_override === 'reached' || claim.verdict_override === 'failed') return claim.verdict_override;
  const t = claim.target;
  if (!t) return 'tracking';
  const rd = claim.review_date ? String(claim.review_date).slice(0, 10) : null;
  const reviewReached = rd ? rd <= today : false;

  if (t.kind === 'sr_gte') {
    if (!reviewReached) return 'tracking';
    return groupTargetReached(t, cur) ? 'reached' : 'failed';
  }
  if (t.kind === 'label_count' || t.kind === 'supply') {
    const v = groupCurrentValue(t, cur);
    if (t.op === 'lte') {
      if (v != null && v > t.n) return 'failed'; // cap breached → irreversible
      if (!reviewReached) return 'tracking';
      return v != null && v <= t.n ? 'reached' : 'failed';
    }
    if (groupTargetReached(t, cur)) return 'reached';
    if (reviewReached) return 'failed';
    return 'tracking';
  }
  return 'tracking';
}

export const GROUP_VERDICT_META = {
  tracking: { chip: 'chip-amber', label: 'Tracking' },
  reached: { chip: 'chip-green', label: 'Target reached' },
  failed: { chip: 'chip-red', label: 'Experiment failed' },
};

export function groupTrackedValueText(t, cur) {
  const v = groupCurrentValue(t, cur);
  if (v == null || v === '') return '—';
  return t?.kind === 'sr_gte' ? `${v}%` : String(v);
}

export function groupProgressLine(claim, cur) {
  const t = claim?.target;
  if (!t) return null;
  if (t.kind === 'sr_gte') {
    const w = cur?.srWindow;
    const so = w && w.n ? `${w.pct}% (${w.pass}/${w.n})` : 'no settled videos yet';
    return `Success rate of videos posted action→review: ${so} (target ≥ ${t.value}%)`;
  }
  if (t.kind === 'label_count') {
    return `${t.band} produced action→review: ${cur?.produced ?? 0} of ${t.op === 'lte' ? '≤' : '≥'} ${t.n}`;
  }
  if (t.kind === 'supply') {
    return `Videos posted action→review: ${cur?.supply ?? 0} of ${t.op === 'lte' ? '≤' : '≥'} ${t.n}`;
  }
  return null;
}

// Re-export the shared review-due helper so callers import from one place.
export { reviewDue };

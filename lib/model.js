// JOIN + RECONCILIATION ENGINE — ported verbatim, with `data`/`meta` threaded
// in place of the original global `state`.
import { num, fmtPct } from './format';
import { BU_BY_CATEGORY, DROP_STATES } from './constants';
import { dominantFromEps } from './metrics';

// Reduce eval rows -> one canonical record per show (+ keep period rows)
export function buildEvalIndex(evalRows) {
  const idx = new Map();
  if (!evalRows) return idx;
  const byShow = new Map();
  evalRows.forEach((r) => {
    const k = String(r.show_id);
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(r);
  });
  byShow.forEach((rows, k) => {
    const cur = rows.find((r) => r.period_type === 'LAST_3_CALENDAR_WEEK' && r.period_name === 'CURRENT_WEEK') || rows[rows.length - 1];
    idx.set(k, { cur, periods: rows });
  });
  return idx;
}

// Reduce fatigue rows -> one show record (+ keep episodes)
export function buildFatIndex(fatRows) {
  const idx = new Map();
  if (!fatRows) return idx;
  const byShow = new Map();
  fatRows.forEach((r) => {
    const k = String(r.show_id);
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(r);
  });
  byShow.forEach((rows, k) => {
    idx.set(k, { show: rows[0], eps: rows });
  });
  return idx;
}

// Show-metadata index: one row per show keyed by show_id (state, BU, owner,
// designer, cadence, show_manager). The meta dataset can carry duplicate rows
// per show (e.g. show_detail emits a null- and a non-null-show_manager row), so
// merge duplicates preferring non-empty values — otherwise a trailing null row
// would blank out a real show_manager.
export function buildMetaIndex(metaRows) {
  const idx = new Map();
  if (!metaRows) return idx;
  metaRows.forEach((r) => {
    const k = String(r.show_id);
    const prev = idx.get(k);
    if (!prev) { idx.set(k, r); return; }
    const merged = { ...prev };
    for (const key of Object.keys(r)) { const v = r[key]; if (v != null && v !== '') merged[key] = v; }
    idx.set(k, merged);
  });
  return idx;
}

// Time-spent index: one row per show keyed by show_id.
export function buildTimeSpentIndex(tsRows) {
  const idx = new Map();
  if (!tsRows) return idx;
  tsRows.forEach((r) => idx.set(String(r.show_id), r));
  return idx;
}

// Retention states for the next-day-return chart, in display order.
export const RETENTION_STATES = [
  { key: 'nurr', label: 'New (NURR)',         color: '#2A9D8F', desc: 'No prior watch in 60 days' },
  { key: 'curr', label: 'Current (CURR)',     color: '#1D4ED8', desc: 'Watched 1–6 days ago' },
  { key: 'rurr', label: 'Reactivated (RURR)', color: '#F4A261', desc: 'Watched 7–29 days ago' },
  { key: 'surr', label: 'Resurrected (SURR)', color: '#7C3AED', desc: 'Watched 30–60 days ago' },
];

// Retention index: per show_id, a dense weekly series of return rates by state.
// retRows are (show_id, ref_day, {nurr,curr,rurr,surr}_pct/_base). Returns
//   Map show_id -> { dates:[d0..dn], pct:{state:[..aligned..]}, base:{state:[...]} }
// with every ref_day present for every state (missing → null pct / 0 base).
export function buildRetentionIndex(retRows) {
  const idx = new Map();
  if (!retRows) return idx;
  const byShow = new Map();
  retRows.forEach((r) => {
    const k = String(r.show_id);
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(r);
  });
  byShow.forEach((rows, k) => {
    const dates = [...new Set(rows.map((r) => String(r.ref_day).slice(0, 10)).filter(Boolean))].sort();
    const dateIx = new Map(dates.map((d, i) => [d, i]));
    const pct = {}, base = {};
    RETENTION_STATES.forEach((s) => { pct[s.key] = new Array(dates.length).fill(null); base[s.key] = new Array(dates.length).fill(0); });
    rows.forEach((r) => {
      const i = dateIx.get(String(r.ref_day).slice(0, 10));
      if (i == null) return;
      RETENTION_STATES.forEach((s) => {
        const p = num(r[s.key + '_pct']);
        if (p != null) pct[s.key][i] = p;
        base[s.key][i] += num(r[s.key + '_base']) || 0;
      });
    });
    idx.set(k, { dates, pct, base });
  });
  return idx;
}

// Language-median return-rate series for the reference overlay. For the given
// dates and the set of show_ids in a language, returns { state: [median per date] }
// — the median of each state's return % across those shows on each date (nulls
// skipped; a date with no data → null).
export function retentionLangMedian(retIdx, showIds, dates) {
  const out = {};
  const median = (a) => {
    const v = a.filter((x) => x != null).sort((x, y) => x - y);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10) / 10;
  };
  RETENTION_STATES.forEach((s) => {
    out[s.key] = dates.map((d) => {
      const vals = [];
      showIds.forEach((id) => {
        const rec = retIdx.get(String(id));
        if (!rec) return;
        const di = rec.dates.indexOf(d);
        if (di >= 0) vals.push(rec.pct[s.key][di]);
      });
      return median(vals);
    });
  });
  return out;
}

// In-app launch surfaces tracked in the daily audience chart, in display order,
// each with a colour + readable label. Surfaces beyond this list still render
// (with a fallback colour assigned in the chart).
export const AUDIENCE_SURFACE_STYLE = {
  home:             { label: 'Home',             color: '#2A9D8F' },
  player_autoplay:  { label: 'Player autoplay',  color: '#1D4ED8' },
  push:             { label: 'Push',             color: '#7C3AED' },
  search:           { label: 'Search',           color: '#F4A261' },
  category:         { label: 'Category',         color: '#E63946' },
  show_page:        { label: 'Show page',        color: '#0EA5E9' },
  library:          { label: 'Library',          color: '#16A34A' },
  new_n_hot:        { label: 'New & Hot',        color: '#DB2777' },
  learning_journey: { label: 'Learning journey', color: '#CA8A04' },
  ai_chat:          { label: 'AI chat',          color: '#9333EA' },
  shared:           { label: 'Shared',           color: '#F59E0B' },
  other:            { label: 'Other',            color: '#94A3B8' },
  unknown:          { label: 'Unknown',          color: '#CBD5E1' },
};
export const AUDIENCE_SURFACE_ORDER = Object.keys(AUDIENCE_SURFACE_STYLE);

// Paid-DAU index: per show_id, a dense daily series of paid DAU + its trailing
// 7-day average. dauRows are (show_id, date_, paid_users, paid_users_7d_avg).
// Returns Map show_id -> { dates:[d0..dn], paidUsers:[..], paidUsers7dAvg:[..] }.
export function buildDauIndex(dauRows) {
  const idx = new Map();
  if (!dauRows || !dauRows.length) return idx;
  const byShow = new Map();
  dauRows.forEach((r) => {
    const k = String(r.show_id);
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(r);
  });
  byShow.forEach((rows, k) => {
    const dates = [...new Set(rows.map((r) => String(r.date_).slice(0, 10)).filter(Boolean))].sort();
    const dateIx = new Map(dates.map((d, i) => [d, i]));
    const paidUsers = new Array(dates.length).fill(0);
    const paidUsers7dAvg = new Array(dates.length).fill(null);
    rows.forEach((r) => {
      const i = dateIx.get(String(r.date_).slice(0, 10));
      if (i == null) return;
      paidUsers[i] = num(r.paid_users) || 0;
      const a = num(r.paid_users_7d_avg);
      if (a != null) paidUsers7dAvg[i] = a;
    });
    idx.set(k, { dates, paidUsers, paidUsers7dAvg });
  });
  return idx;
}

// Audience index: per show_id, a dense daily series by in-app launch surface for
// the multi-line chart. audRows are (show_id, date_, surface, views, users).
// Returns Map show_id -> { dates:[d0..dn], surfaces:[...present, ordered],
//   views:{surface:[..aligned..]}, users:{surface:[...]} } with every date
// present for every surface (missing day → 0).
export function buildAudienceIndex(audRows) {
  const idx = new Map();
  if (!audRows || !audRows.length) return idx;
  const byShow = new Map();
  audRows.forEach((r) => {
    const k = String(r.show_id);
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(r);
  });
  byShow.forEach((rows, k) => {
    const dates = [...new Set(rows.map((r) => String(r.date_).slice(0, 10)).filter(Boolean))].sort();
    const dateIx = new Map(dates.map((d, i) => [d, i]));
    // surfaces actually present for this show — known order first, then any extras.
    const present = new Set(rows.map((r) => String(r.surface || '').toLowerCase()).filter(Boolean));
    const surfaces = [
      ...AUDIENCE_SURFACE_ORDER.filter((s) => present.has(s)),
      ...[...present].filter((s) => !AUDIENCE_SURFACE_ORDER.includes(s)),
    ];
    const views = {}, users = {};
    surfaces.forEach((s) => { views[s] = new Array(dates.length).fill(0); users[s] = new Array(dates.length).fill(0); });
    rows.forEach((r) => {
      const i = dateIx.get(String(r.date_).slice(0, 10));
      const s = String(r.surface || '').toLowerCase();
      if (i == null || !(s in views)) return;
      views[s][i] += num(r.views) || 0;
      users[s][i] += num(r.users) || 0;
    });
    idx.set(k, { dates, surfaces, views, users });
  });
  return idx;
}

// JS fallback for stale experimental decisions (mirrors source tool)
export function effExperimentalDecision(cur) {
  let d = cur.experimental_decision;
  // LOW_CONFIDENCE (peer count < 10) and INSUFFICIENT_DATA are not firm calls —
  // derive a STOP/PROMOTE/CONTINUE from the current peer-contribution status so the
  // show still surfaces in the queue (the UI flags it as "derived").
  if (d && d !== 'INSUFFICIENT_DATA' && d !== 'LOW_CONFIDENCE') return d;
  const c = num(cur.l3w_current_contrib_pct);
  if (c == null) return d || 'INSUFFICIENT_DATA';
  switch (cur.period_contrib_status) {
    case 'very_strong':
    case 'meets_retain_threshold':
      return num(cur.show_users) >= 500 ? 'PROMOTE' : 'CONTINUE';
    case 'below_stop_threshold':
      return 'STOP';
    case 'continue_observing':
      return 'CONTINUE';
    default:
      return d || 'CONTINUE';
  }
}

// Lifecycle classification -> {band, score, decaying, isExp, label, tone}
export function lifeClass(rec) {
  if (!rec) return { band: 'na', score: 0, decaying: false, isExp: false, label: 'no lifecycle data', tone: 'grey' };
  const cur = rec.cur;
  const isExp = String(cur.show_type || '').toLowerCase() === 'experimental';
  const decaying = cur.recent_trajectory === 'declining';
  if (isExp) {
    const d = effExperimentalDecision(cur);
    const map = {
      PROMOTE: { band: 'strong', score: 2, label: 'PROMOTE', tone: 'green' },
      STOP: { band: 'stop', score: -2, label: 'STOP', tone: 'red' },
      CONTINUE: { band: 'watch', score: 0, label: 'CONTINUE', tone: 'amber' },
      LOW_CONFIDENCE: { band: 'na', score: 0, label: 'LOW CONFIDENCE', tone: 'grey' },
      INSUFFICIENT_DATA: { band: 'na', score: 0, label: 'INSUFFICIENT DATA', tone: 'grey' },
    };
    const m = map[d] || map.INSUFFICIENT_DATA;
    return { ...m, decaying, isExp: true, verdictRaw: d };
  }
  const v = cur.show_verdict;
  const map = {
    very_strong: { band: 'strong', score: 2, label: 'Top-tier vs peers', tone: 'green' },
    retain_or_scale: { band: 'healthy', score: 1, label: 'Above retain bar', tone: 'green' },
    continue_observing: { band: 'watch', score: 0, label: 'Between stop & retain', tone: 'amber' },
    below_stop_threshold: { band: 'stop', score: -2, label: 'Below peer stop bar', tone: 'red' },
    insufficient_data: { band: 'na', score: 0, label: 'Insufficient data', tone: 'grey' },
  };
  const m = map[v] || map.insufficient_data;
  let score = m.score;
  if (decaying && score > -2) score -= 1;
  return { ...m, score, decaying, isExp: false, verdictRaw: v };
}

// The fatigue LENS label/tone = the actual retention diagnosis (failure mode
// first, else the fatigue zone). This is what the lens is meant to describe —
// "retention & failure mode" — and is independent of the recommended ACTION.
function fatigueDiagnosis(mode, zone) {
  if (mode === 'HOOK') return { label: 'Hook failing', tone: 'amber' };
  if (mode === 'PACE') return { label: 'Mid-video drop-off', tone: 'amber' };
  if (mode === 'ENDING') return { label: 'Ending drop-off', tone: 'amber' };
  if (mode === 'INSUFFICIENT_DATA') return { label: 'Insufficient data', tone: 'grey' };
  // retention curve healthy (OK / unknown) → judge by the fatigue zone.
  if (zone === 'red') return { label: 'Comp & return weak', tone: 'red' };
  if (zone === 'yellow') return { label: 'Softening vs peers', tone: 'amber' };
  return { label: 'Drop-off healthy', tone: 'green' };
}

// Fatigue classification -> {band, score, mode, label, tone}
// The creative/retention dimension (HOOK/PACE/ENDING/OK) is driven by the
// dominant failure mode RECOMPUTED from the episodes (dominantFromEps), so the
// fatigue lens always matches the Last-10 table's "Failure" column. Non-creative
// actions from the query (saturation / comp / return based) take precedence.
export function fatClass(rec) {
  if (!rec) return { band: 'na', score: 0, mode: null, label: 'no fatigue data', tone: 'grey' };
  const s = rec.show;
  const act = s.show_action_recommendation;
  const zone = s.show_fatigue_zone;
  const mode = dominantFromEps(rec.eps); // 'HOOK'|'PACE'|'ENDING'|'OK'|'INSUFFICIENT_DATA'|null

  // Non-creative actions first (these aren't about the retention failure mode).
  if (act === 'SHUTDOWN_CANDIDATE') {
    const d = fatigueDiagnosis(mode, zone);
    return { band: 'shutdown', score: -2, mode, act, zone, label: d.label, tone: d.tone };
  }
  if (act === 'CADENCE_UP') return { band: 'scale', score: 2, mode, act, zone, label: 'Frequency headroom', tone: 'green' };
  if (act === 'CADENCE_DOWN') return { band: 'overpub', score: -1, mode, act, zone, label: 'Over-publishing', tone: 'amber' };

  // Creative / retention dimension — from the recomputed dominant failure mode.
  if (mode === 'HOOK') return { band: 'fix', score: -1, mode, act, zone, label: 'Hook failing', tone: 'amber' };
  if (mode === 'PACE') return { band: 'fix', score: -1, mode, act, zone, label: 'Mid-video drop-off', tone: 'amber' };
  if (mode === 'ENDING') return { band: 'fix', score: -1, mode, act, zone, label: 'Ending drop-off', tone: 'amber' };
  if (mode === 'OK') return { band: 'ok', score: 1, mode, act, zone, label: 'Drop-off healthy', tone: 'green' };
  return { band: 'na', score: 0, mode, act, zone, label: 'Insufficient data', tone: 'grey' };
}

export function wrap(key, tone, headline, detail, priority) {
  return { key, tone, headline, detail, priority, agreement: 'partial' };
}

// Lifecycle-only call: used when there is no Fatigue lens data.
export function lifecycleOnlyCall(L) {
  if (L.band === 'na') return wrap('REVIEW', 'grey', 'Needs a look', 'No lifecycle or fatigue data to evaluate this show.', 11);
  if (L.isExp) {
    if (L.band === 'strong') return wrap('PROMOTE', 'green', 'Promote to production', 'Clears the peer retain bar in its (re)launch weeks (lifecycle verdict only — no fatigue data).', 5);
    if (L.band === 'stop') return wrap('STOP_REVIEW', 'red', 'Review for stop', 'Experiment is below the peer stop bar (lifecycle verdict only — no fatigue data to diagnose the cause).', 2);
    return wrap('WATCH', 'grey', 'Keep watching', 'Experiment between stop and retain bars (lifecycle verdict only — no fatigue data).', 11);
  }
  if (L.band === 'stop') return wrap('STOP_REVIEW', 'red', 'Review for stop', 'Below the peer stop bar (lifecycle verdict only — no fatigue data to diagnose the cause).', 2);
  if (L.decaying) return wrap('WATCH_AND_FIX', 'amber', 'Watch — slipping vs peers', 'Recent trajectory is declining (lifecycle verdict only — upload the Fatigue CSV to diagnose why).', 10);
  if (L.band === 'strong' || L.band === 'healthy') return wrap('HOLD_HEALTHY', 'green', 'Hold — healthy vs peers', 'Above the peer retain bar (lifecycle verdict only — no fatigue data).', 12);
  return wrap('WATCH', 'grey', 'Keep watching', 'Between the stop and retain bars (lifecycle verdict only — no fatigue data).', 11);
}

// THE HARMONY: reconcile both lenses into one unified recommendation
export function reconcile(show) {
  const L = show.life,
    F = show.fat,
    src = show.source;
  const negLife = L.band === 'stop' || L.band === 'weak' || L.decaying;
  const fixMode = F.band === 'fix';

  // No fatigue lens → base the call entirely on the Lifecycle verdict (NSE).
  if (src === 'eval' || F.band === 'na') {
    const r = lifecycleOnlyCall(L);
    r.agreement = 'one-lens';
    return r;
  }
  if (src === 'fatigue') {
    const r = wrap('SINGLE_LENS_FAT', F.tone, 'Fatigue only — ' + F.label, 'No lifecycle/peer data for this show. Diagnosis is creative-only; upload the Evaluation CSV to see how it ranks against peers.', 13);
    r.agreement = 'one-lens';
    return r;
  }

  // both lenses present — reconcile
  let r;
  if (L.band === 'stop' && F.band === 'shutdown')
    r = wrap('CONFIRMED_STOP', 'red', 'Confirmed stop', `Below the peer stop bar AND a sustained completion+retention miss. Both lenses agree this show isn't earning its slot — shut down or move to hiatus.`, 1);
  else if (negLife && F.band === 'overpub')
    r = wrap('OVERPUBLISHING', 'amber', "Cut cadence, don't kill", `Slipping vs peers, but the diagnosis is over-publishing: demand can't absorb the current frequency (saturation ${fmtPct(num(F._sat), 0)}). Trim cadence before considering a stop.`, 3);
  else if (negLife && fixMode)
    r = wrap('FIXABLE_DECLINE', 'amber', 'Fixable decline — fix before cutting', `Peers are pulling ahead, but the drop traces to a fixable creative cause: ${F.label.toLowerCase()}. Try a ${F.mode ? F.mode.toLowerCase() : 'creative'} fix on the next 2 episodes before a stop decision.`, 4);
  else if (L.band === 'stop')
    r = wrap('STOP_REVIEW', 'red', 'Review for stop', `Below the peer stop bar with no fixable creative pattern (drop-off looks healthy). The problem is demand, not craft — review for stop or hiatus.`, 2);
  else if (L.isExp && L.band === 'strong' && fixMode)
    r = wrap('PROMOTE_WITH_FIX', 'green', 'Promote — with a fix', `Clears the peer bar in its launch weeks and deserves promotion, but carries a ${F.mode ? F.mode.toLowerCase() : ''} weakness. Promote and fix on the way up.`, 6);
  else if (L.isExp && L.band === 'strong')
    r = wrap('PROMOTE', 'green', 'Promote to production', `Clears the peer retain bar in its (re)launch weeks and the drop-off pattern is healthy. Graduate from experiment to production.`, 5);
  else if ((L.band === 'strong' || L.band === 'healthy') && F.band === 'scale')
    r = wrap('SCALE', 'green', 'Scale up', `Strong vs peers and saturated (audience wants more than you publish). Increase frequency toward the cap, or add a sibling show in this category.`, 7);
  else if ((L.band === 'healthy' || L.band === 'strong') && F.band === 'overpub' && !L.decaying)
    r = wrap('TRIM_CADENCE', 'amber', 'Trim cadence', `Healthy vs peers but publishing faster than demand absorbs. A small frequency cut should lift per-episode performance without hurting reach.`, 8);
  else if ((L.band === 'healthy' || L.band === 'strong') && fixMode)
    r = wrap('TUNE_HEALTHY', 'amber', 'Tune while ahead', `Performing well against peers, but episodes show a ${F.mode ? F.mode.toLowerCase() : ''} weak spot. Tune proactively to protect the lead.`, 9);
  else if (L.band === 'watch' && (fixMode || F.band === 'shutdown'))
    r = wrap('WATCH_AND_FIX', 'amber', 'Watch & fix', `Sitting between the stop and retain bars; episodes show ${F.label.toLowerCase()}. Address the creative issue and re-check next week — it decides which way this tips.`, 10);
  else if (L.band === 'watch')
    r = wrap('WATCH', 'grey', 'Keep watching', `Between the stop and retain bars with no decisive creative signal. Monitor the next 2 weeks of contribution % before acting.`, 11);
  else if ((L.band === 'strong' || L.band === 'healthy') && (F.band === 'ok' || F.band === 'scale'))
    r = wrap('HOLD_HEALTHY', 'green', 'Hold — healthy on both', `Above the peer retain bar and clean drop-off. Nothing to do — keep the current cadence.`, 12);
  else
    r = wrap('REVIEW', 'grey', 'Needs a look', `Signals don't fall into a standard pattern (lifecycle: ${L.label}; fatigue: ${F.label}). Open the deep dive to judge.`, 11);

  let ag = 'partial';
  if (L.score < 0 && F.score < 0) ag = 'aligned-negative';
  else if (L.score > 0 && F.score > 0) ag = 'aligned-positive';
  else if ((L.score < 0 && F.score > 0) || (L.score > 0 && F.score < 0)) ag = 'conflict';
  r.agreement = ag;
  r._sat = num(F._sat);
  return r;
}

// Normalise any raw catalog value to active / experiment / inactive.
export function normStatus(raw) {
  raw = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'inactive' || raw === 'expired' || raw === 'gtm' || raw === 'ai' || raw === 'paused' || raw === 'archived' || raw === 'deleted') return 'inactive';
  if (raw === 'experimental' || raw === 'experiment' || raw === 'exp' || raw.includes('experiment') || raw.includes('test')) return 'experiment';
  if (raw === 'active' || raw === 'live' || raw === 'main' || raw === 'production' || raw === 'prod') return 'active';
  return null;
}

// show status (active / experiment / inactive); prefers the most recently uploaded CSV.
export function statusOf(e, f, meta) {
  const ev = e ? e.cur : null;
  const evalStatus = ev ? normStatus(ev.show_type) || normStatus(ev.state) : null;
  const fatStatus = f ? normStatus(f.show.show_state) : null;
  const ts = (m) => (m ? +new Date(m.uploadedAt) : -1);
  const fatNewer = ts(meta?.fatMeta) >= ts(meta?.evalMeta);
  const ordered = fatNewer ? [fatStatus, evalStatus] : [evalStatus, fatStatus];
  for (const st of ordered) if (st) return st;
  return 'inactive';
}

export function toneCls(t) {
  return t === 'green' ? 'green' : t === 'red' ? 'red' : t === 'amber' ? 'amber' : 'grey';
}

// Build the joined model: array of show records with life/fat/rec attached.
export function buildModel(data) {
  const { evalRows, fatRows, evalMeta, fatMeta, metaRows, managerOverrides } = data || {};
  const ov = managerOverrides || {};
  const E = buildEvalIndex(evalRows),
    Fi = buildFatIndex(fatRows),
    M = buildMetaIndex(metaRows);
  const keys = new Set([...E.keys(), ...Fi.keys()]);
  const out = [];
  keys.forEach((k) => {
    const e = E.get(k),
      f = Fi.get(k),
      m = M.get(k);
    // Drop shows the catalog marks draft/deleted (canonical state from the meta CSV,
    // falling back to the eval/fatigue state when meta isn't present).
    const rawState = String((m && m.state) || (e && e.cur.state) || (f && f.show.show_state) || '').trim().toLowerCase();
    if (DROP_STATES.has(rawState)) return;
    const source = e && f ? 'both' : e ? 'eval' : 'fatigue';
    const title = e ? e.cur.show_title : f.show.show_title;
    const language = e ? e.cur.language : f.show.language;
    const category = e ? e.cur.category_name || '' : f.show.category_title || '';
    const catId = e ? num(e.cur.category_id) : (f && f.show.category_id != null ? num(f.show.category_id) : null);
    // Prefer the meta CSV's BU (authoritative), else derive from category_id.
    const bu = (m && m.bu_name) || (catId != null ? (BU_BY_CATEGORY[catId] || '') : '');
    // Effective show manager: a self-assigned override (KV) wins over the query's
    // show_manager. An override key present but empty = explicitly unassigned.
    const manager = Object.prototype.hasOwnProperty.call(ov, k) ? (ov[k] || null) : (m?.show_manager || null);
    const show = { id: k, source, title, language, category, bu, meta: m || null, manager, status: statusOf(e, f, { evalMeta, fatMeta }), eval: e || null, fat: f || null, life: lifeClass(e) };
    show.fat_c = fatClass(f);
    if (f) show.fat_c._sat = num(f.show.show_avg_saturation_pct);
    show.fat = show.fat_c;
    show.rec = reconcile(show);
    out.push(show);
  });
  return out;
}

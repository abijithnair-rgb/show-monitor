// JOIN + RECONCILIATION ENGINE — ported verbatim, with `data`/`meta` threaded
// in place of the original global `state`.
import { num, fmtPct } from './format';

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

// JS fallback for stale experimental decisions (mirrors source tool)
export function effExperimentalDecision(cur) {
  let d = cur.experimental_decision;
  if (d && d !== 'INSUFFICIENT_DATA') return d;
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

// Fatigue classification -> {band, score, mode, label, tone}
export function fatClass(rec) {
  if (!rec) return { band: 'na', score: 0, mode: null, label: 'no fatigue data', tone: 'grey' };
  const s = rec.show;
  const act = s.show_action_recommendation;
  const mode = s.show_dominant_failure_mode;
  const map = {
    CADENCE_UP: { band: 'scale', score: 2, label: 'Frequency headroom', tone: 'green' },
    HOLD: { band: 'ok', score: 1, label: 'Drop-off healthy', tone: 'green' },
    HOOK_FIX: { band: 'fix', score: -1, label: 'Hook failing', tone: 'amber' },
    PACE_FIX: { band: 'fix', score: -1, label: 'Mid-video drop-off', tone: 'amber' },
    ENDING_FIX: { band: 'fix', score: -1, label: 'Ending drop-off', tone: 'amber' },
    CADENCE_DOWN: { band: 'overpub', score: -1, label: 'Over-publishing', tone: 'amber' },
    SHUTDOWN_CANDIDATE: { band: 'shutdown', score: -2, label: 'Sustained comp+retention miss', tone: 'red' },
  };
  const m = map[act] || { band: 'na', score: 0, label: '—', tone: 'grey' };
  return { ...m, mode, act };
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
  const { evalRows, fatRows, evalMeta, fatMeta } = data || {};
  const E = buildEvalIndex(evalRows),
    Fi = buildFatIndex(fatRows);
  const keys = new Set([...E.keys(), ...Fi.keys()]);
  const out = [];
  keys.forEach((k) => {
    const e = E.get(k),
      f = Fi.get(k);
    const source = e && f ? 'both' : e ? 'eval' : 'fatigue';
    const title = e ? e.cur.show_title : f.show.show_title;
    const language = e ? e.cur.language : f.show.language;
    const category = e ? e.cur.category_name || '' : f.show.category_title || '';
    const show = { id: k, source, title, language, category, status: statusOf(e, f, { evalMeta, fatMeta }), eval: e || null, fat: f || null, life: lifeClass(e) };
    show.fat_c = fatClass(f);
    if (f) show.fat_c._sat = num(f.show.show_avg_saturation_pct);
    show.fat = show.fat_c;
    show.rec = reconcile(show);
    out.push(show);
  });
  return out;
}

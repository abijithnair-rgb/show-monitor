'use client';
import { Fragment, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import { metricSnapshot, currentFor, reviewDue, evalVerdict, VERDICT_META, metricLabel, canAssign, ROSTER, defaultMetricForReasons, cumulativeVideoCount, todayStr } from '@/lib/ownership';
import { successRate } from '@/lib/metrics';
import { computeNseVerdict } from '@/lib/nseVerdict';
import PickupPanel from '@/components/PickupPanel';
import { fmtDate, weeksAgo, timeAgo, fmtPct, fmtNum, num, addDays, LANG_NAMES } from '@/lib/format';

// A show is flagged "L5-heavy" when ≥5/7 (≈71%) of the videos it published in
// the last 7 days landed in the worst view band (L5 — below the day×language
// p25). That's a sustained reach/discovery failure worth a manual review.
const L5_SHARE_THRESHOLD = 5 / 7;
const L5_MIN_SUPPLY = 3; // need a few videos before the share means anything
const SR_REVIEW_BELOW = 75; // success rate under this % → review & take action

// Queue buckets. Experiments are STOP / PROMOTE / REVIEW (insufficient data).
// CONTINUE is intentionally excluded — no action needed. REVIEW_ACT covers the
// metric-driven reasons (L5-heavy reach, success rate < 75%).
const DECISION_ORDER = ['STOP', 'PROMOTE', 'REVIEW_ACT', 'REVIEW'];
const DECISION_LABELS = {
  STOP: 'STOP', PROMOTE: 'PROMOTE', REVIEW_ACT: 'Review & act', REVIEW: 'Review',
};
const DECISION_META = {
  STOP: { bg: '#fee2e2', fg: '#991b1b', ring: 'ring-red-300', chip: 'chip-red' },
  PROMOTE: { bg: '#dcfce7', fg: '#065f46', ring: 'ring-green-300', chip: 'chip-green' },
  REVIEW_ACT: { bg: '#ede9fe', fg: '#5b21b6', ring: 'ring-purple-300', chip: 'chip-purple' },
  REVIEW: { bg: '#f1f5f9', fg: '#475569', ring: 'ring-slate-300', chip: 'chip-grey' },
};
// Map an experimental verdict to a queue bucket. CONTINUE stays CONTINUE (it's
// filtered out — no action needed); insufficient/low-confidence → REVIEW.
const dispDecision = (verdict) => {
  if (verdict === 'STOP' || verdict === 'PROMOTE') return verdict;
  if (verdict === 'CONTINUE') return 'CONTINUE';
  return 'REVIEW';
};

// L5-heavy detector: returns {l5, supply, pct} when the show's last-7d label mix
// is dominated by L5 past the threshold, else null.
function l5Info(hd) {
  if (!hd || !hd.supply || hd.supply < L5_MIN_SUPPLY) return null;
  const l5 = (hd.labels && hd.labels.L5) || 0;
  const share = l5 / hd.supply;
  if (share < L5_SHARE_THRESHOLD) return null;
  return { l5, supply: hd.supply, pct: Math.round(share * 100) };
}

const SORTS = [
  { id: 'overdue', label: 'Most overdue decision' },
  { id: 'recent', label: 'Most recent launch' },
  { id: 'recommendation', label: 'Recommendation (STOP first)' },
];

// Human "why" for an experimental decision — uses the query's decision_reason
// when present, else a concise derived sentence from the peer status.
function whyText(s, decision) {
  const ev = s.eval?.cur || {};
  if (ev.decision_reason) return ev.decision_reason;
  const c = num(ev.l3w_current_contrib_pct);
  const lang = ev.language || s.language || '';
  if (decision === 'STOP') return `In the bottom band of ${lang} shows${c != null ? ` — contributes only ${fmtPct(c)}` : ''}.`;
  if (decision === 'PROMOTE') return `Clears the retain bar${c != null ? ` — ${fmtPct(c)} contribution` : ''}${num(ev.show_users) != null ? `, ${fmtNum(num(ev.show_users))} users` : ''}.`;
  return '—';
}

// Where a video fix can be made — the dominant failure mode from the fatigue lens.
function FixCell({ mode }) {
  const m = String(mode || '').toUpperCase();
  const map = {
    HOOK: ['chip-amber', 'Hook'],
    PACE: ['chip-amber', 'Pace / mid'],
    ENDING: ['chip-indigo', 'Ending'],
  };
  if (map[m]) return <span className={'chip ' + map[m][0]}>{map[m][1]}</span>;
  if (m === 'OK') return <span className="text-slate-400 text-xs">healthy</span>;
  return <span className="text-slate-300">—</span>;
}

// Filter dropdown — module-level so it isn't remounted on every parent render.
function Dd({ label, value, set, options, fmt, allLabel }) {
  return (
    <label className="text-xs text-slate-500 flex flex-col gap-1">
      {label}
      <select className="border border-slate-300 rounded-md px-2 py-1 text-sm text-slate-800" value={value} onChange={(e) => set(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>{fmt ? fmt(o) : o}</option>
        ))}
      </select>
    </label>
  );
}

function ConfidenceChip({ value }) {
  const v = String(value || '').toLowerCase();
  const cls = v === 'high' ? 'chip-green' : v === 'medium' ? 'chip-amber' : v === 'low' ? 'chip-grey' : 'chip-light';
  return <span className={'chip ' + cls}>{v || '—'}</span>;
}

function TrajectoryCell({ value }) {
  const v = String(value || '').toLowerCase();
  const m = {
    improving: ['chip-green', '↑ improving'],
    declining: ['chip-red', '↓ declining'],
    stable: ['chip-grey', '→ stable'],
    volatile: ['chip-amber', '~ volatile'],
  };
  if (m[v]) return <span className={'chip ' + m[v][0]}>{m[v][1]}</span>;
  return <span className="text-slate-300">—&nbsp;·</span>;
}

export default function ActionQueueTab() {
  const data = useStore((s) => s.data());
  const openDeepDive = useStore((s) => s.openDeepDive);
  const actions = useStore((s) => s.actions);
  const actionsConfigured = useStore((s) => s.actionsConfigured);
  const nse = useStore((s) => s.nse);
  const userName = useStore((s) => s.userName);
  const setUserName = useStore((s) => s.setUserName);

  // which show's panel is open, and in which mode: { id, assign }
  const [expanded, setExpanded] = useState({ id: null, assign: false });

  // Filters live in the store (in-memory): they survive tab switches and only
  // reset on a full page refresh or via "Reset filters".
  const aqFilters = useStore((s) => s.aqFilters);
  const setAqFilter = useStore((s) => s.setAqFilter);
  const resetAqFilters = useStore((s) => s.resetAqFilters);
  const { search, sortBy, language, status, bu, category, recommendation, reason, confidence, fixArea, manager } = aqFilters;
  // Setter factory that also accepts the functional-updater form some pills use.
  const mkSet = (key) => (v) => setAqFilter(key, typeof v === 'function' ? v(aqFilters[key]) : v);
  const setSearch = mkSet('search');
  const setSortBy = mkSet('sortBy');
  const setLanguage = mkSet('language');
  const setStatus = mkSet('status');
  const setBu = mkSet('bu');
  const setCategory = mkSet('category');
  const setRecommendation = mkSet('recommendation');
  const setReason = mkSet('reason');
  const setConfidence = mkSet('confidence');
  const setFixArea = mkSet('fixArea');
  const setManager = mkSet('manager');

  const iCanAssign = canAssign(userName);

  const model = useMemo(() => buildModel(data), [data]);
  const hdcIdx = useMemo(() => (data.hdcRows ? buildHdcIndex(data.hdcRows) : null), [data]);
  const fatIdx = useMemo(() => (data.fatRows ? buildFatIndex(data.fatRows) : null), [data]);

  // Shows needing a decision:
  //  • experimental shows with a STOP / PROMOTE / REVIEW(insufficient) verdict —
  //    CONTINUE is dropped (no action needed);
  //  • non-experimental stop candidates (below the peer stop bar / reconciled stop);
  //  • metric-driven reviews: L5-heavy reach (≥5/7 worst-band) OR success rate < 75%.
  // Inactive shows are already stopped, so they're excluded.
  const rows = useMemo(() => {
    // Active-claim metrics per show — used to drop issues already being worked on.
    // An issue leaves the queue once an experiment covering it is picked up; the
    // moment that experiment is concluded (removed from `actions`) the issue
    // re-derives from the data here and reappears if it still persists.
    const claimMetrics = {};
    for (const c of Object.values(actions || {})) {
      const k = String(c.show_id);
      (claimMetrics[k] || (claimMetrics[k] = new Set())).add(c.metric);
    }
    // Which experiment metric(s) "cover" each issue tag. 'Insufficient data' has
    // no natural lever → covered by ANY active experiment on the show.
    const coversTag = (tag, metrics) => {
      if (!metrics || !metrics.size) return false;
      if (tag === 'Success rate') return metrics.has('success_rate');
      if (tag === 'L5 reach') return ['label', 'frequency', 'hook_fix', 'pace_fix', 'ending_fix'].some((m) => metrics.has(m));
      if (tag === 'Stop') return metrics.has('stop');
      if (tag === 'Promote') return metrics.has('promote');
      if (tag === 'Insufficient data') return metrics.size > 0;
      return false;
    };

    return model
      .map((s) => {
        const l5 = hdcIdx ? l5Info(hdcIdx.get(s.id)) : null;
        const eps = fatIdx?.get(s.id)?.eps;
        const sr = eps ? successRate(eps, data.fatRows) : null;
        const srLow = sr && sr.n && sr.pct < SR_REVIEW_BELOW ? sr : null;
        return { s, l5, srLow };
      })
      .map(({ s, l5, srLow }) => {
        if (s.status === 'inactive') return null;
        const ev = s.eval?.cur || {};
        // New-show guard: keep a freshly-launched show OUT of the queue until it
        // has published 5 videos after its launch date — unless it's already
        // older than a month (launch date > 30 days ago), in which case surface
        // it even with fewer than 5. Shows with no launch date are treated as
        // established and pass through.
        const launch = ev.launch_date ? String(ev.launch_date).slice(0, 10) : null;
        if (launch && launch > addDays(todayStr(), -30)) {
          if (cumulativeVideoCount(data.hdcRows, s.id, launch, todayStr()) < 5) return null;
        }
        const raw = String(ev.experimental_decision || '').toUpperCase();
        const isExp = !!s.life?.isExp;
        const expDecision = isExp ? dispDecision(s.life.verdictRaw) : null;
        const isStop = !isExp && (s.life?.band === 'stop' || ['CONFIRMED_STOP', 'STOP_REVIEW'].includes(s.rec?.key));

        // Build this show's ISSUES. Each = { tag, bucket, text } where bucket is
        // the queue lane (STOP/PROMOTE/REVIEW_ACT/REVIEW).
        const issues = [];
        if (isExp && expDecision === 'STOP') issues.push({ tag: 'Stop', bucket: 'STOP', text: whyText(s, 'STOP') });
        else if (isExp && expDecision === 'PROMOTE') issues.push({ tag: 'Promote', bucket: 'PROMOTE', text: whyText(s, 'PROMOTE') });
        else if (isExp && expDecision === 'REVIEW') issues.push({ tag: 'Insufficient data', bucket: 'REVIEW', text: whyText(s, 'REVIEW') });
        else if (isStop) issues.push({ tag: 'Stop', bucket: 'STOP', text: s.rec?.detail || ev.decision_reason || whyText(s, 'STOP') });
        if (l5) issues.push({ tag: 'L5 reach', bucket: 'REVIEW_ACT', text: `trending L5 (${l5.l5}/${l5.supply} of this week ≈${l5.pct}% in the worst view band — review reach/discovery)` });
        if (srLow) issues.push({ tag: 'Success rate', bucket: 'REVIEW_ACT', text: `success rate ${srLow.pct}% (${srLow.pass}/${srLow.n}) below ${SR_REVIEW_BELOW}% — review content quality` });

        if (!issues.length) return null; // healthy / exp CONTINUE with no review reason

        // Drop issues already covered by an active experiment. If every issue is
        // covered, the show leaves the queue entirely (it's being worked on; track
        // it in Experiments). Otherwise keep only the OPEN issues.
        const metrics = claimMetrics[String(s.id)];
        const open = issues.filter((i) => !coversTag(i.tag, metrics));
        if (!open.length) return null;

        // Highest-priority open lane drives the row's bucket + recommendation.
        const order = ['STOP', 'PROMOTE', 'REVIEW_ACT', 'REVIEW'];
        const decision = order.find((b) => open.some((i) => i.bucket === b));
        const reasonTags = [...new Set(open.map((i) => i.tag))];

        const actReasons = open.filter((i) => i.bucket === 'REVIEW_ACT').map((i) => i.text);
        let why;
        if (decision === 'REVIEW_ACT') {
          why = 'Review & take action: ' + actReasons.join('; ') + '.';
        } else {
          why = (open.find((i) => i.bucket === decision) || {}).text || '';
          if (actReasons.length) why = `${why} · Also: ${actReasons.join('; ')}.`;
        }

        return {
          s,
          decision,
          isExp,
          reasonTags,
          derived: isExp && (!raw || raw === 'INSUFFICIENT_DATA' || raw === 'LOW_CONFIDENCE'),
          launch: ev.launch_date || null,
          trajectory: ev.recent_trajectory,
          confidence: ev.confidence,
          why,
        };
      })
      .filter(Boolean);
  }, [model, hdcIdx, fatIdx, data.fatRows, actions]);

  // New-show experiments that have landed on a stop/promote verdict become queue
  // candidates too. The effective verdict already folds in Deepak's override, so
  // an override replaces the candidate rather than duplicating it. These take
  // precedence over any model-derived row for the same show.
  const byIdModel = useMemo(() => new Map(model.map((s) => [String(s.id), s])), [model]);
  const today = useMemo(() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }, []);
  const nseRows = useMemo(() => {
    return Object.values(nse || {})
      .map((rec) => {
        const show = byIdModel.get(String(rec.show_id)) || null;
        const eps = fatIdx?.get(String(rec.show_id))?.eps || null;
        const v = computeNseVerdict(rec, show, data.hdcRows, eps, today);
        if (!v.queueCandidate) return null;
        const decision = v.queueCandidate === 'promote' ? 'PROMOTE' : 'STOP';
        const s = show || { id: String(rec.show_id), title: rec.show_name, language: rec.language, category: rec.category, bu: '', status: 'experiment', manager: rec.manager, fat: null, eval: null };
        return {
          s, decision, isExp: true,
          reasonTags: ['New-show experiment', decision === 'STOP' ? 'Stop' : 'Promote'],
          derived: false, launch: rec.launch_date || null,
          trajectory: null, confidence: null,
          why: `New-show experiment → ${v.effectiveVerdict}${rec.manager_verdict ? ' (manager override)' : ''}.`,
        };
      })
      .filter(Boolean);
  }, [nse, byIdModel, fatIdx, today]);

  // Merge: NSE candidates win over a model row for the same show id.
  const mergedRows = useMemo(() => {
    const nseIds = new Set(nseRows.map((r) => String(r.s.id)));
    return [...nseRows, ...rows.filter((r) => !nseIds.has(String(r.s.id)))];
  }, [nseRows, rows]);

  const langs = [...new Set(mergedRows.map((r) => r.s.language).filter(Boolean))].sort();
  const statuses = [...new Set(mergedRows.map((r) => r.s.status).filter(Boolean))].sort();
  const bus = [...new Set(mergedRows.map((r) => r.s.bu).filter(Boolean))].sort();
  const cats = [...new Set(mergedRows.map((r) => r.s.category).filter(Boolean))].sort();
  const reasonsList = [...new Set(mergedRows.flatMap((r) => r.reasonTags))].sort();
  const managers = [...new Set(mergedRows.map((r) => r.s.manager).filter(Boolean))].sort();

  const decisionCount = (d) => mergedRows.filter((r) => r.decision === d).length;

  const FIX_PILLS = [
    ['HOOK', 'Hook', '#fef3c7', '#92400e'],
    ['PACE', 'Pace / mid', '#fef3c7', '#92400e'],
    ['ENDING', 'Ending', '#e0e7ff', '#3730a3'],
  ];
  const fixCount = (code) => mergedRows.filter((r) => String(r.s.fat?.mode || '').toUpperCase() === code).length;

  let filtered = mergedRows.filter((r) => {
    if (language && r.s.language !== language) return false;
    if (status && r.s.status !== status) return false;
    if (bu && r.s.bu !== bu) return false;
    if (category && r.s.category !== category) return false;
    if (recommendation && r.decision !== recommendation) return false;
    if (manager && (r.s.manager || '') !== manager) return false;
    if (reason && !r.reasonTags.includes(reason)) return false;
    if (fixArea && String(r.s.fat?.mode || '').toUpperCase() !== fixArea) return false;
    if (confidence && String(r.confidence || '').toLowerCase() !== confidence) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(String(r.s.title || '').toLowerCase().includes(q) || String(r.s.id).includes(q))) return false;
    }
    return true;
  });

  // Active experiments grouped by show (a show may have several). [0] = primary
  // (oldest); the Action Queue manages the primary, extras live in Deep Dive.
  const claimsByShow = useMemo(() => {
    const m = {};
    for (const c of Object.values(actions || {})) {
      const k = String(c.show_id);
      (m[k] || (m[k] = [])).push(c);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => String(a.claimed_at || '').localeCompare(String(b.claimed_at || '')));
    return m;
  }, [actions]);

  const launchT = (r) => (r.launch ? new Date(r.launch).getTime() || Infinity : Infinity);
  // Rank purely by the chosen sort — the queue does NOT reorder by the result of
  // any experiment already running on a show.
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === 'recent') return launchT(b) - launchT(a);
    if (sortBy === 'recommendation') return (a.decision === 'STOP' ? 0 : 1) - (b.decision === 'STOP' ? 0 : 1) || launchT(a) - launchT(b);
    return launchT(a) - launchT(b); // overdue: oldest launch first
  });

  const clearFilters = () => resetAqFilters();

  return (
    <div>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h2 className="text-xl font-semibold">Action Queue</h2>
        {actionsConfigured && (
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span className="text-slate-400">You:</span>
            {userName ? (
              <>
                <span className="chip chip-blue">{userName}</span>
                <button className="text-slate-400 hover:text-slate-700 underline" onClick={() => setUserName('')}>change</button>
              </>
            ) : (
              <select
                value=""
                onChange={(e) => { if (e.target.value) setUserName(e.target.value); }}
                className="border border-slate-300 rounded-md px-2 py-1 text-xs"
              >
                <option value="">select your name…</option>
                {ROSTER.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
          </div>
        )}
      </div>
      <p className="text-sm text-slate-500 mb-3">Experiments, stop candidates & shows trending at the L5 label — needing a decision.{actionsConfigured ? " Pick up an action to set review dates and let the team know you're on it." : ''}</p>
      {!actionsConfigured && <p className="hint mb-3">Shared "pick up" is not configured on the server — actions are view-only here. (Link a Vercel KV store to enable team ownership.)</p>}

      <div className="card p-4 mb-4">
        <div className="flex gap-2 mb-3 flex-wrap">
          {DECISION_ORDER.map((d) => {
            const meta = DECISION_META[d];
            const n = decisionCount(d);
            if (!n && recommendation !== d) return null;
            return (
              <button
                key={d}
                onClick={() => setRecommendation((v) => (v === d ? '' : d))}
                className={'rounded-full px-3 py-1 text-sm font-semibold transition ' + (recommendation === d ? 'ring-2 ' + meta.ring + ' ' : '')}
                style={{ background: meta.bg, color: meta.fg }}
              >
                {n} {DECISION_LABELS[d] || d}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 mb-3 flex-wrap items-center">
          <span className="text-xs text-slate-400 mr-1">Fix area:</span>
          {FIX_PILLS.map(([code, label, bg, fg]) => (
            <button
              key={code}
              onClick={() => setFixArea((v) => (v === code ? '' : code))}
              className={'rounded-full px-3 py-1 text-sm font-semibold transition ' + (fixArea === code ? 'ring-2 ring-amber-300 ' : '') + (fixCount(code) === 0 ? 'opacity-50 ' : '')}
              style={{ background: bg, color: fg }}
            >
              {fixCount(code)} {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-3 items-end mb-3">
          <input
            value={search}
            placeholder="Search title or show_id…"
            className="border border-slate-300 rounded-md px-3 py-2 text-sm flex-1 min-w-[220px]"
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            &nbsp;
            <select className="border border-slate-300 rounded-md px-2 py-2 text-sm text-slate-800" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORTS.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
            </select>
          </label>
          <button className="btn btn-ghost" onClick={clearFilters}>Reset filters</button>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <Dd label="LANGUAGE" value={language} set={setLanguage} options={langs} fmt={(l) => LANG_NAMES[l] || l} allLabel="All languages" />
          <Dd label="STATUS" value={status} set={setStatus} options={statuses} fmt={(s) => s[0].toUpperCase() + s.slice(1)} allLabel="All statuses" />
          <Dd label="BU" value={bu} set={setBu} options={bus} allLabel="All BUs" />
          <Dd label="CATEGORY" value={category} set={setCategory} options={cats} allLabel="All categories" />
          <Dd label="RECOMMENDATION" value={recommendation} set={setRecommendation} options={DECISION_ORDER} fmt={(d) => DECISION_LABELS[d] || d} allLabel="All recommendations" />
          <Dd label="REASON" value={reason} set={setReason} options={reasonsList} allLabel="All reasons" />
          {managers.length > 0 && <Dd label="SHOW MANAGER" value={manager} set={setManager} options={managers} allLabel="All managers" />}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Show</th>
              <th>Show manager</th>
              <th>Launched</th>
              <th>Recommendation</th>
              <th>Reason</th>
              <th>Why</th>
              {actionsConfigured && <th>Owner / status</th>}
              <th>Fix area</th>
              <th>Trajectory</th>
              {actionsConfigured && <th>Active experiments</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((r) => {
                const showClaims = claimsByShow[String(r.s.id)] || [];
                // Pickup from the queue always starts a FRESH experiment for the
                // open issue (claimId null), so a second issue can be picked up
                // while another experiment is already running on the same show.
                const snapNow = metricSnapshot(r.s, hdcIdx, fatIdx, data.fatRows);
                const owners = [...new Set(showClaims.map((c) => c.by).filter(Boolean))];
                const isExpanded = expanded.id === r.s.id;
                const colCount = actionsConfigured ? 10 : 8;
                const openPanel = (e, asAssign) => { e.stopPropagation(); setExpanded((v) => (v.id === r.s.id && v.assign === asAssign ? { id: null, assign: false } : { id: r.s.id, assign: asAssign })); };
                return (
                <Fragment key={r.s.id}>
                <tr className="row-clickable" onClick={() => openDeepDive(r.s.id)}>
                  <td>
                    <div className="font-medium">{r.s.title || '—'}</div>
                    <div className="mt-1 flex gap-1 flex-wrap">
                      <span className="chip chip-blue">{LANG_NAMES[r.s.language] || r.s.language || '?'}</span>
                      {r.s.category && <span className="chip chip-purple">{r.s.category}</span>}
                    </div>
                  </td>
                  <td className="text-sm text-slate-700">{r.s.manager || <span className="hint">—</span>}</td>
                  <td>
                    <div>{fmtDate(r.launch)}</div>
                    <div className="hint">{weeksAgo(r.launch)}</div>
                  </td>
                  <td>
                    <span className={'chip ' + (DECISION_META[r.decision]?.chip || 'chip-grey')}>{DECISION_LABELS[r.decision] || r.decision}</span>
                    {r.derived && <div className="hint mt-1">ⓘ derived</div>}
                  </td>
                  <td>
                    <div className="flex flex-col gap-1">
                      {r.reasonTags.map((t) => <span key={t} className="chip chip-light whitespace-nowrap">{t}</span>)}
                    </div>
                  </td>
                  <td>
                    <div className="text-sm text-slate-600 truncate" style={{ maxWidth: 320 }} title={r.why}>{r.why}</div>
                  </td>
                  {actionsConfigured && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-2">
                        <button className="btn btn-ghost text-xs" onClick={(e) => openPanel(e, false)}>{isExpanded && !expanded.assign ? 'Cancel' : 'Pick up'}</button>
                        {iCanAssign && <button className="btn btn-ghost text-xs" onClick={(e) => openPanel(e, true)}>{isExpanded && expanded.assign ? 'Cancel' : 'Assign'}</button>}
                      </div>
                    </td>
                  )}
                  <td><FixCell mode={r.s.fat?.mode} /></td>
                  <td><TrajectoryCell value={r.trajectory} /></td>
                  {actionsConfigured && (
                    <td>
                      {showClaims.length > 0
                        ? <span className="font-medium text-slate-700" title={owners.length ? `${owners.join(', ')} · manage in Deep Dive` : 'manage in Deep Dive'}>{showClaims.length}</span>
                        : <span className="text-slate-300">0</span>}
                    </td>
                  )}
                </tr>
                {actionsConfigured && isExpanded && (
                  <tr>
                    <td colSpan={colCount} className="p-2 bg-white">
                      <PickupPanel s={r.s} snapshotNow={snapNow} assign={expanded.assign} claimId={null} defaultMetric={defaultMetricForReasons(r.reasonTags)} onClose={() => setExpanded({ id: null, assign: false })} />
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan={actionsConfigured ? 10 : 8} className="text-center text-slate-400 py-6">No shows need a decision right now. ✓</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

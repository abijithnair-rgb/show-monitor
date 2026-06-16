'use client';
import { Fragment, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import { metricSnapshot, reviewDue, evalVerdict, VERDICT_META, metricLabel } from '@/lib/ownership';
import { successRate } from '@/lib/metrics';
import PickupPanel from '@/components/PickupPanel';
import { fmtDate, weeksAgo, timeAgo, fmtPct, fmtNum, num, LANG_NAMES } from '@/lib/format';

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
  const userName = useStore((s) => s.userName);
  const setUserName = useStore((s) => s.setUserName);

  const [nameDraft, setNameDraft] = useState('');
  const [expandedId, setExpandedId] = useState(null); // which show's pickup panel is open

  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('overdue');
  const [language, setLanguage] = useState('');
  const [status, setStatus] = useState('');
  const [bu, setBu] = useState('');
  const [category, setCategory] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [confidence, setConfidence] = useState('');
  const [fixArea, setFixArea] = useState('');

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
        const raw = String(ev.experimental_decision || '').toUpperCase();
        const isExp = !!s.life?.isExp;
        const expDecision = isExp ? dispDecision(s.life.verdictRaw) : null;
        const isStop = !isExp && (s.life?.band === 'stop' || ['CONFIRMED_STOP', 'STOP_REVIEW'].includes(s.rec?.key));

        // Metric review reasons (drive the REVIEW_ACT bucket / why text).
        const reasons = [];
        if (l5) reasons.push(`trending L5 (${l5.l5}/${l5.supply} of this week ≈${l5.pct}% in the worst view band — review reach/discovery)`);
        if (srLow) reasons.push(`success rate ${srLow.pct}% (${srLow.pass}/${srLow.n}) below ${SR_REVIEW_BELOW}% — review content quality`);

        // Decide the bucket; CONTINUE-only experiments with no reasons are dropped.
        let decision;
        if (isExp && expDecision !== 'CONTINUE') decision = expDecision; // STOP / PROMOTE / REVIEW
        else if (isStop) decision = 'STOP';
        else if (reasons.length) decision = 'REVIEW_ACT';
        else return null; // exp CONTINUE (or healthy) with no review reason → not in queue

        let why;
        if (decision === 'REVIEW_ACT') {
          why = 'Review & take action: ' + reasons.join('; ') + '.';
        } else {
          why = isExp ? whyText(s, decision) : (s.rec?.detail || ev.decision_reason || whyText(s, 'STOP'));
          if (reasons.length) why = `${why} · Also: ${reasons.join('; ')}.`;
        }
        return {
          s,
          decision,
          isExp,
          derived: isExp && (!raw || raw === 'INSUFFICIENT_DATA' || raw === 'LOW_CONFIDENCE'),
          launch: ev.launch_date || null,
          trajectory: ev.recent_trajectory,
          confidence: ev.confidence,
          why,
        };
      })
      .filter(Boolean);
  }, [model, hdcIdx, fatIdx, data.fatRows]);

  const langs = [...new Set(rows.map((r) => r.s.language).filter(Boolean))].sort();
  const statuses = [...new Set(rows.map((r) => r.s.status).filter(Boolean))].sort();
  const bus = [...new Set(rows.map((r) => r.s.bu).filter(Boolean))].sort();
  const cats = [...new Set(rows.map((r) => r.s.category).filter(Boolean))].sort();

  const decisionCount = (d) => rows.filter((r) => r.decision === d).length;

  const FIX_PILLS = [
    ['HOOK', 'Hook', '#fef3c7', '#92400e'],
    ['PACE', 'Pace / mid', '#fef3c7', '#92400e'],
    ['ENDING', 'Ending', '#e0e7ff', '#3730a3'],
  ];
  const fixCount = (code) => rows.filter((r) => String(r.s.fat?.mode || '').toUpperCase() === code).length;

  let filtered = rows.filter((r) => {
    if (language && r.s.language !== language) return false;
    if (status && r.s.status !== status) return false;
    if (bu && r.s.bu !== bu) return false;
    if (category && r.s.category !== category) return false;
    if (recommendation && r.decision !== recommendation) return false;
    if (fixArea && String(r.s.fat?.mode || '').toUpperCase() !== fixArea) return false;
    if (confidence && String(r.confidence || '').toLowerCase() !== confidence) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(String(r.s.title || '').toLowerCase().includes(q) || String(r.s.id).includes(q))) return false;
    }
    return true;
  });

  const launchT = (r) => (r.launch ? new Date(r.launch).getTime() || Infinity : Infinity);
  // A picked-up experiment "needs attention" when its review date has arrived OR
  // the target has been auto-judged reached/failed — those float to the very top,
  // regardless of the chosen sort.
  const attnOf = (r) => {
    const claim = actions[String(r.s.id)];
    if (!claim) return false;
    if (reviewDue(claim)) return true;
    const v = evalVerdict(claim, metricSnapshot(r.s, hdcIdx, fatIdx, data.fatRows));
    return v !== 'tracking';
  };
  filtered = [...filtered].sort((a, b) => {
    const da = attnOf(a), db = attnOf(b);
    if (da !== db) return da ? -1 : 1;
    if (sortBy === 'recent') return launchT(b) - launchT(a);
    if (sortBy === 'recommendation') return (a.decision === 'STOP' ? 0 : 1) - (b.decision === 'STOP' ? 0 : 1) || launchT(a) - launchT(b);
    return launchT(a) - launchT(b); // overdue: oldest launch first
  });
  const dueCount = filtered.filter(attnOf).length;

  function clearFilters() {
    setSearch(''); setLanguage(''); setStatus(''); setBu(''); setCategory(''); setRecommendation(''); setConfidence(''); setFixArea('');
  }

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
                <button className="text-slate-400 hover:text-slate-700 underline" onClick={() => { setNameDraft(userName); setUserName(''); }}>change</button>
              </>
            ) : (
              <form
                onSubmit={(e) => { e.preventDefault(); if (nameDraft.trim()) setUserName(nameDraft.trim()); }}
                className="flex items-center gap-1"
              >
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="your name"
                  className="border border-slate-300 rounded-md px-2 py-1 text-xs w-32"
                />
                <button type="submit" className="btn btn-ghost text-xs">Save</button>
              </form>
            )}
          </div>
        )}
      </div>
      <p className="text-sm text-slate-500 mb-3">Experiments, stop candidates & shows trending at the L5 label — needing a decision.{actionsConfigured ? " Pick up an action to set review dates and let the team know you're on it." : ''}</p>
      {!actionsConfigured && <p className="hint mb-3">Shared "pick up" is not configured on the server — actions are view-only here. (Link a Vercel KV store to enable team ownership.)</p>}
      {actionsConfigured && dueCount > 0 && <div className="banner banner-red text-[12px] mb-3"><span>⏰ {dueCount} picked-up {dueCount === 1 ? 'experiment needs' : 'experiments need'} attention (review due, or target reached/failed) — shown at the top.</span></div>}

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
          <button className="btn btn-ghost" onClick={clearFilters}>Clear filters</button>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <Dd label="LANGUAGE" value={language} set={setLanguage} options={langs} fmt={(l) => LANG_NAMES[l] || l} allLabel="All languages" />
          <Dd label="STATUS" value={status} set={setStatus} options={statuses} fmt={(s) => s[0].toUpperCase() + s.slice(1)} allLabel="All statuses" />
          <Dd label="BU" value={bu} set={setBu} options={bus} allLabel="All BUs" />
          <Dd label="CATEGORY" value={category} set={setCategory} options={cats} allLabel="All categories" />
          <Dd label="RECOMMENDATION" value={recommendation} set={setRecommendation} options={DECISION_ORDER} fmt={(d) => DECISION_LABELS[d] || d} allLabel="All recommendations" />
          <Dd label="CONFIDENCE" value={confidence} set={setConfidence} options={['high', 'medium', 'low']} allLabel="All confidence" />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Show</th>
              <th>Launched</th>
              <th>Recommendation</th>
              <th>Why</th>
              {actionsConfigured && <th>Owner / status</th>}
              <th>Fix area</th>
              <th>Trajectory</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((r) => {
                const claim = actions[String(r.s.id)];
                const snapNow = metricSnapshot(r.s, hdcIdx, fatIdx, data.fatRows);
                const verdict = claim ? evalVerdict(claim, snapNow) : null;
                const vMeta = verdict ? VERDICT_META[verdict] : null;
                const due = reviewDue(claim);
                const attn = claim && (due || verdict !== 'tracking');
                const expanded = expandedId === r.s.id;
                const colCount = actionsConfigured ? 8 : 7;
                const toggle = (e) => { e.stopPropagation(); setExpandedId((v) => (v === r.s.id ? null : r.s.id)); };
                return (
                <Fragment key={r.s.id}>
                <tr className={'row-clickable' + (attn ? ' bg-red-50' : '')} onClick={() => openDeepDive(r.s.id)}>
                  <td>
                    <div className="font-medium">{r.s.title || '—'}</div>
                    <div className="mt-1 flex gap-1 flex-wrap">
                      <span className="chip chip-blue">{LANG_NAMES[r.s.language] || r.s.language || '?'}</span>
                      {r.s.category && <span className="chip chip-purple">{r.s.category}</span>}
                    </div>
                  </td>
                  <td>
                    <div>{fmtDate(r.launch)}</div>
                    <div className="hint">{weeksAgo(r.launch)}</div>
                  </td>
                  <td>
                    <span className={'chip ' + (DECISION_META[r.decision]?.chip || 'chip-grey')}>{DECISION_LABELS[r.decision] || r.decision}</span>
                    {r.derived && <div className="hint mt-1">ⓘ derived</div>}
                  </td>
                  <td>
                    <div className="text-sm text-slate-600 truncate" style={{ maxWidth: 360 }} title={r.why}>{r.why}</div>
                  </td>
                  {actionsConfigured && (
                    <td onClick={(e) => e.stopPropagation()}>
                      {claim ? (
                        <button className="text-left text-xs hover:opacity-80" onClick={toggle}>
                          <div className="flex items-center gap-1 flex-wrap">
                            {vMeta && <span className={'chip ' + vMeta.chip}>{vMeta.label}</span>}
                            <span className="font-medium text-slate-700">{claim.by}</span>
                            <span className="chip chip-purple">{metricLabel(claim.metric)}</span>
                            {due && verdict === 'tracking' && <span className="chip chip-red">review due</span>}
                          </div>
                          <div className="hint mt-0.5">
                            picked up {timeAgo(claim.claimed_at)}
                            {claim.review_date ? ` · review ${fmtDate(claim.review_date)}` : ''}
                            {' '}{expanded ? '▾' : '▸'}
                          </div>
                        </button>
                      ) : (
                        <button className="btn btn-ghost text-xs" onClick={toggle}>{expanded ? 'Cancel' : 'Pick up'}</button>
                      )}
                    </td>
                  )}
                  <td><FixCell mode={r.s.fat?.mode} /></td>
                  <td><TrajectoryCell value={r.trajectory} /></td>
                  <td><ConfidenceChip value={r.confidence} /></td>
                </tr>
                {actionsConfigured && expanded && (
                  <tr>
                    <td colSpan={colCount} className="p-2 bg-white">
                      <PickupPanel s={r.s} snapshotNow={metricSnapshot(r.s, hdcIdx, fatIdx, data.fatRows)} onClose={() => setExpandedId(null)} />
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan={actionsConfigured ? 8 : 7} className="text-center text-slate-400 py-6">No shows need a decision right now. ✓</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

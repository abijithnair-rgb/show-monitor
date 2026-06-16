'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import { fmtDate, weeksAgo, fmtPct, fmtNum, num, LANG_NAMES } from '@/lib/format';

// A show is flagged "L5-heavy" when ≥5/7 (≈71%) of the videos it published in
// the last 7 days landed in the worst view band (L5 — below the day×language
// p25). That's a sustained reach/discovery failure worth a manual review.
const L5_SHARE_THRESHOLD = 5 / 7;
const L5_MIN_SUPPLY = 3; // need a few videos before the share means anything

// Every experimental decision shows up in the queue. STOP/PROMOTE/CONTINUE are
// firm calls; anything else (INSUFFICIENT_DATA / LOW_CONFIDENCE left underived)
// is bucketed as REVIEW so the show is never silently dropped. REVIEW_L5 is the
// L5-heavy flag above.
const DECISION_ORDER = ['STOP', 'PROMOTE', 'CONTINUE', 'REVIEW_L5', 'REVIEW'];
const DECISION_LABELS = {
  STOP: 'STOP', PROMOTE: 'PROMOTE', CONTINUE: 'CONTINUE', REVIEW_L5: 'Review & act', REVIEW: 'REVIEW',
};
const DECISION_META = {
  STOP: { bg: '#fee2e2', fg: '#991b1b', ring: 'ring-red-300', chip: 'chip-red' },
  PROMOTE: { bg: '#dcfce7', fg: '#065f46', ring: 'ring-green-300', chip: 'chip-green' },
  CONTINUE: { bg: '#fef3c7', fg: '#92400e', ring: 'ring-amber-300', chip: 'chip-amber' },
  REVIEW_L5: { bg: '#ede9fe', fg: '#5b21b6', ring: 'ring-purple-300', chip: 'chip-purple' },
  REVIEW: { bg: '#f1f5f9', fg: '#475569', ring: 'ring-slate-300', chip: 'chip-grey' },
};
const dispDecision = (verdict) => (['STOP', 'PROMOTE', 'CONTINUE'].includes(verdict) ? verdict : 'REVIEW');

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

  // Shows needing a decision: every experimental show (STOP/PROMOTE/CONTINUE/REVIEW)
  // PLUS non-experimental shows that are stop candidates (below the peer stop bar or
  // reconciled to a stop) PLUS L5-heavy shows (≥5/7 of last-7d videos in the worst
  // view band). Inactive shows are already stopped, so they're excluded.
  const rows = useMemo(() => {
    return model
      .map((s) => ({ s, l5: hdcIdx ? l5Info(hdcIdx.get(s.id)) : null }))
      .filter(({ s, l5 }) => {
        if (s.status === 'inactive') return false;
        if (s.life?.isExp) return true;
        if (s.life?.band === 'stop' || ['CONFIRMED_STOP', 'STOP_REVIEW'].includes(s.rec?.key)) return true;
        return !!l5;
      })
      .map(({ s, l5 }) => {
        const ev = s.eval?.cur || {};
        const raw = String(ev.experimental_decision || '').toUpperCase();
        const isExp = !!s.life?.isExp;
        const isStop = !isExp && (s.life?.band === 'stop' || ['CONFIRMED_STOP', 'STOP_REVIEW'].includes(s.rec?.key));
        const decision = isExp ? dispDecision(s.life.verdictRaw) : isStop ? 'STOP' : 'REVIEW_L5';
        const l5Why = l5 ? `Trending L5: ${l5.l5}/${l5.supply} of this week's videos (≈${l5.pct}%) fell into the worst view band (below the p25 reach bar) — review reach/discovery (thumbnails, topics, recommendations) and take action.` : null;
        let why;
        if (decision === 'REVIEW_L5') why = l5Why;
        else {
          why = isExp ? whyText(s, decision) : (s.rec?.detail || ev.decision_reason || whyText(s, 'STOP'));
          if (l5) why = `${why} · Also trending L5 (${l5.l5}/${l5.supply}, ≈${l5.pct}%).`;
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
      });
  }, [model, hdcIdx]);

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
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === 'recent') return launchT(b) - launchT(a);
    if (sortBy === 'recommendation') return (a.decision === 'STOP' ? 0 : 1) - (b.decision === 'STOP' ? 0 : 1) || launchT(a) - launchT(b);
    return launchT(a) - launchT(b); // overdue: oldest launch first
  });

  function clearFilters() {
    setSearch(''); setLanguage(''); setStatus(''); setBu(''); setCategory(''); setRecommendation(''); setConfidence(''); setFixArea('');
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-1">Action Queue</h2>
      <p className="text-sm text-slate-500 mb-3">Experiments, stop candidates & shows trending at the L5 label — needing a decision</p>

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
              <th>Fix area</th>
              <th>Trajectory</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((r) => (
                <tr key={r.s.id} className="row-clickable" onClick={() => openDeepDive(r.s.id)}>
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
                  <td><FixCell mode={r.s.fat?.mode} /></td>
                  <td><TrajectoryCell value={r.trajectory} /></td>
                  <td><ConfidenceChip value={r.confidence} /></td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-6">No shows need a decision right now. ✓</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

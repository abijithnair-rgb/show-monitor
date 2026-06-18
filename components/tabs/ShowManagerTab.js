'use client';
import { useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex, normStatus } from '@/lib/model';
import { buildHdcIndex, windowedHdcRate } from '@/lib/hdc';
import { windowedSuccessRate } from '@/lib/metrics';
import {
  ROSTER, currentFor, metricLabel, targetText, trackedValueText, evalVerdict, VERDICT_META, reviewDue,
  weekKey, monthKey, weekRange, monthRange, todayStr,
} from '@/lib/ownership';
import { computeNseVerdict, V } from '@/lib/nseVerdict';
import { fmtDate, LANG_NAMES } from '@/lib/format';

const slice10 = (v) => String(v || '').slice(0, 10);

// Terminal NSE verdicts that count as a failed new-show experiment.
const NSE_FAIL = new Set([V.MIN_VIDEO_FAIL, V.LAUNCH_FAIL, V.REPLACE, V.REPLACE_SR, V.STOP_LIFECYCLE, V.STOP_CONTRIB]);
const nseVerdictChip = (v) => {
  if (v === V.PROMOTE) return 'chip-green';
  if (v === V.CONTINUE_5) return 'chip-amber';
  if (NSE_FAIL.has(v)) return 'chip-red';
  return 'chip-grey';
};
const firstTok = (v) => String(v || '').trim().toLowerCase().split(/[\s._@]+/)[0];

// Per-POC experiment tracking & ownership, scoped to a chosen week/month. A
// "show manager" = the POC who owns (picked up / was assigned) an experiment.
export default function ShowManagerTab() {
  const data = useStore((s) => s.data());
  const actions = useStore((s) => s.actions);
  const history = useStore((s) => s.history);
  const nse = useStore((s) => s.nse);
  const actionsConfigured = useStore((s) => s.actionsConfigured);
  const userName = useStore((s) => s.userName);
  const openDeepDive = useStore((s) => s.openDeepDive);

  const [manager, setManager] = useState(ROSTER.includes(userName) ? userName : '');
  const [granularity, setGranularity] = useState('weekly'); // 'weekly' | 'monthly'
  const [periodSel, setPeriodSel] = useState(''); // chosen period key
  const [detailView, setDetailView] = useState('experiments'); // 'experiments' | 'shows'

  const model = useMemo(() => buildModel(data), [data]);
  const byId = useMemo(() => new Map(model.map((s) => [String(s.id), s])), [model]);

  // Shows each POC manages, from show_detail.show_manager (carried in metaRows),
  // counting ONLY active/experimental shows. Match a manager name to a POC by
  // first name (handles "Abijith" / "Abijith Nair" / "abijith@…").
  // Driven by the model's EFFECTIVE manager (s.manager = self-assign override,
  // else the query's show_manager), so Explorer assignments count here too.
  const managedByPoc = useMemo(() => {
    const m = new Map();
    ROSTER.forEach((p) => m.set(p, new Set()));
    for (const s of model) {
      const mgr = s.manager;
      if (!mgr) continue;
      if (s.status !== 'active' && s.status !== 'experiment') continue;
      const tok = firstTok(mgr);
      const poc = ROSTER.find((p) => p.toLowerCase() === tok || p.toLowerCase() === String(mgr).trim().toLowerCase());
      if (poc) m.get(poc).add(String(s.id));
    }
    return m;
  }, [model]);
  const managedCount = (p) => managedByPoc.get(p)?.size ?? 0;
  const metaById = useMemo(() => {
    const m = new Map();
    for (const r of data.metaRows || []) m.set(String(r.show_id), r);
    return m;
  }, [data.metaRows]);
  const tableRef = useRef(null);
  const hdcIdx = useMemo(() => (data.hdcRows ? buildHdcIndex(data.hdcRows) : null), [data]);
  const fatIdx = useMemo(() => (data.fatRows ? buildFatIndex(data.fatRows) : null), [data]);

  // Flatten every experiment (active + concluded) into one normalised list.
  const experiments = useMemo(() => {
    const out = [];
    for (const claim of Object.values(actions || {})) {
      const s = byId.get(String(claim.show_id));
      const cur = s ? currentFor(claim, s, data, hdcIdx, fatIdx) : null;
      out.push({
        id: claim.id, claim, cur, concluded: false, by: claim.by, showId: String(claim.show_id), s,
        claimedAt: slice10(claim.claimed_at), concludedAt: null,
        metric: claim.metric, target: claim.target,
        verdict: cur ? evalVerdict(claim, cur) : 'tracking',
        reviewDate: claim.review_date || null,
      });
    }
    for (const arr of Object.values(history || {})) {
      for (const rec of arr || []) {
        const s = byId.get(String(rec.show_id));
        out.push({
          id: rec.id || `${rec.show_id}:${rec.concluded_at}`, claim: rec, cur: null, concluded: true,
          by: rec.by, showId: String(rec.show_id), s,
          claimedAt: slice10(rec.claimed_at), concludedAt: slice10(rec.concluded_at),
          metric: rec.metric, target: rec.target,
          verdict: rec.verdict === 'reached' ? 'reached' : 'failed',
          reviewDate: rec.review_date || null,
        });
      }
    }
    return out;
  }, [actions, history, byId, data, hdcIdx, fatIdx]);

  // New-show experiments (the NSE board), with each record's live verdict. Keyed
  // by its assigned show manager so the single-manager view can list them.
  const nseAll = useMemo(() => {
    const today = todayStr();
    return Object.values(nse || {}).map((rec) => {
      const s = byId.get(String(rec.show_id)) || null;
      const eps = fatIdx?.get(String(rec.show_id))?.eps || null;
      const v = computeNseVerdict(rec, s, eps, today);
      return { rec, s, v };
    });
  }, [nse, byId, fatIdx]);

  // Period list, generated from the actual data coverage (hdc publish dates, ep
  // approved dates, experiment dates) so we never offer empty future periods.
  const periods = useMemo(() => {
    const dates = [];
    (data.hdcRows || []).forEach((r) => { const d = slice10(r.publish_date); if (d) dates.push(d); });
    (data.fatRows || []).forEach((r) => { const d = slice10(r.approved_dt); if (d) dates.push(d); });
    experiments.forEach((e) => { if (e.claimedAt) dates.push(e.claimedAt); if (e.concludedAt) dates.push(e.concludedAt); });
    const today = todayStr();
    if (!dates.length) return granularity === 'weekly' ? [weekKey(today)] : [monthKey(today)];
    const min = dates.reduce((a, b) => (a < b ? a : b));
    const max = dates.reduce((a, b) => (a > b ? a : b));
    const out = [];
    if (granularity === 'weekly') {
      const lo = weekKey(min);
      let d = new Date(weekKey(max) + 'T00:00:00');
      for (let i = 0; i < 30; i++) { const k = weekKey(d); out.push(k); if (k <= lo) break; d.setDate(d.getDate() - 7); }
    } else {
      const lo = monthKey(min);
      let d = new Date(monthKey(max) + '-01T00:00:00');
      for (let i = 0; i < 24; i++) { const k = monthKey(d); out.push(k); if (k <= lo) break; d.setMonth(d.getMonth() - 1); }
    }
    return out;
  }, [data.hdcRows, data.fatRows, experiments, granularity]);

  const selPeriod = periods.includes(periodSel) ? periodSel : periods[0];
  const win = granularity === 'weekly' ? weekRange(selPeriod) : monthRange(selPeriod);
  const periodLabel = (key) => {
    const r = granularity === 'weekly' ? weekRange(key) : monthRange(key);
    if (!r.start) return key;
    if (granularity === 'weekly') return `${fmtDate(r.start)} – ${fmtDate(r.end)}`;
    const dt = new Date(r.start + 'T00:00:00');
    return `${dt.toLocaleString('en-US', { month: 'long' })} ${dt.getFullYear()}`;
  };

  // An experiment is "in the period" when its lifespan overlaps the window.
  const inPeriod = (e) => {
    if (!win.start || !win.end) return false;
    if (!e.claimedAt || e.claimedAt > win.end) return false;
    return e.concludedAt == null || e.concludedAt >= win.start;
  };
  const within = (d) => d && d >= win.start && d <= win.end;

  // Scoped aggregate for one POC over the selected period.
  const scopedFor = (name) => {
    const exps = experiments.filter((e) => e.by === name && inPeriod(e));
    const shows = new Set(exps.map((e) => e.showId));
    const pickedUp = exps.filter((e) => within(e.claimedAt)).length;
    const concludedInP = exps.filter((e) => e.concluded && within(e.concludedAt));
    const reached = concludedInP.filter((e) => e.verdict === 'reached').length;
    const failed = concludedInP.filter((e) => e.verdict === 'failed').length;
    const active = exps.filter((e) => !e.concluded).length;
    const n = reached + failed;
    return { exps, shows, pickedUp, concluded: concludedInP.length, reached, failed, active, win: n ? Math.round((reached / n) * 100) : null };
  };

  if (!actionsConfigured) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">Show Manager</h2>
        <p className="hint">Shared experiments are not configured on the server — link a Vercel KV (Upstash) store to enable per-POC ownership tracking.</p>
      </div>
    );
  }

  const header = (
    <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
      <div>
        <h2 className="text-xl font-semibold mb-1">Show Manager</h2>
        <p className="text-sm text-slate-500">Experiment tracking & ownership by POC, scoped to a week or month.</p>
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Manager
          <select className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800" value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">All managers</option>
            {ROSTER.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs self-end">
          {[['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([k, label]) => (
            <button key={k} onClick={() => { setGranularity(k); setPeriodSel(''); }}
              className={`px-3 py-2 ${granularity === k ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          {granularity === 'weekly' ? 'Week' : 'Month'}
          <select className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 min-w-[180px]" value={selPeriod || ''} onChange={(e) => setPeriodSel(e.target.value)}>
            {periods.map((k) => <option key={k} value={k}>{periodLabel(k)}</option>)}
          </select>
        </label>
      </div>
    </div>
  );

  // ---- A) All managers — period-scoped leaderboard ----
  if (!manager) {
    const rows = ROSTER.map((p) => ({ p, g: scopedFor(p) }))
      .sort((a, b) => b.g.exps.length - a.g.exps.length || a.p.localeCompare(b.p));
    return (
      <div>
        {header}
        <p className="text-sm text-slate-500 mb-3">Showing <b>{periodLabel(selPeriod)}</b>. Click a manager to drill in.</p>
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr><th>Manager</th><th>Shows managed</th><th>Active</th><th>Picked up</th><th>Concluded</th><th>Reached</th><th>Failed</th><th>Experiment success %</th></tr>
            </thead>
            <tbody>
              {rows.map(({ p, g }) => (
                <tr key={p} className="row-clickable" onClick={() => setManager(p)}>
                  <td className="font-medium text-slate-700">{p}</td>
                  <td>{managedCount(p) || <span className="text-slate-300">0</span>}</td>
                  <td>{g.active || <span className="text-slate-300">0</span>}</td>
                  <td>{g.pickedUp || <span className="text-slate-300">0</span>}</td>
                  <td>{g.concluded || <span className="text-slate-300">0</span>}</td>
                  <td>{g.reached ? <span className="chip chip-green">{g.reached}</span> : <span className="text-slate-300">0</span>}</td>
                  <td>{g.failed ? <span className="chip chip-red">{g.failed}</span> : <span className="text-slate-300">0</span>}</td>
                  <td>{g.win == null ? <span className="text-slate-300">—</span> : <span className="font-semibold">{g.win}%</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ---- B) Single manager — period-scoped ----
  const g = scopedFor(manager);
  const statusChip = (st) => st === 'active' ? 'chip-green' : st === 'experiment' ? 'chip-amber' : 'chip-grey';
  // The manager's MANAGED shows (assigned active/experimental), with HDC rate &
  // success rate over the selected window + any experiments on them.
  const managedIds = [...(managedByPoc.get(manager) || [])];
  const showRows = managedIds.map((id) => {
    const s = byId.get(id);
    const meta = metaById.get(id);
    const title = s?.title || meta?.show_name || `#${id}`;
    const language = s?.language || meta?.language || '';
    const category = s?.category || meta?.category_name || '';
    const status = s?.status || normStatus(meta?.state) || normStatus(meta?.show_type) || '—';
    const hr = windowedHdcRate(data.hdcRows, id, win.start, win.end);
    const eps = fatIdx?.get(id)?.eps;
    const sr = eps ? windowedSuccessRate(eps, win.start, win.end) : { pct: null, n: 0 };
    const exps = g.exps.filter((e) => e.showId === id);
    return { id, s, title, language, category, status, hr, sr, exps };
  }).sort((a, b) => String(a.title).localeCompare(String(b.title)));

  // Experiment-level rows for this manager in the period (one row per experiment).
  const expRows = [...g.exps].sort((a, b) => {
    const aAttn = !a.concluded && (a.verdict !== 'tracking' || reviewDue(a.claim));
    const bAttn = !b.concluded && (b.verdict !== 'tracking' || reviewDue(b.claim));
    if (aAttn !== bAttn) return aAttn ? -1 : 1;
    return String(b.claimedAt || '').localeCompare(String(a.claimedAt || ''));
  });

  // This manager's new-show experiments (match by exact name or first-name token),
  // newest pickup first. Shown in full (not period-scoped) so nothing is hidden.
  const nseRows = nseAll
    .filter(({ rec }) => rec.manager && (rec.manager === manager || firstTok(rec.manager) === manager.toLowerCase()))
    .sort((a, b) => String(b.rec.pickup_date || '').localeCompare(String(a.rec.pickup_date || '')));
  // New-show experiment KPIs for this manager (matches the NSE tab's header).
  const NSE_CLOSED = new Set([V.REPLACE, V.REPLACE_SR, V.STOP_LIFECYCLE, V.STOP_CONTRIB, V.LAUNCH_FAIL]);
  const nseKpis = {
    pickedUp: nseRows.length,
    launches: nseRows.filter(({ v }) => v.tags.includes('launch successful')).length,
    promoted: nseRows.filter(({ v }) => v.effectiveVerdict === V.PROMOTE).length,
    closed: nseRows.filter(({ v }) => NSE_CLOSED.has(v.effectiveVerdict)).length,
  };

  const avg = (arr) => { const v = arr.filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const avgHdc = avg(showRows.map((r) => (r.hr.n ? r.hr.pct : null)));
  const avgSr = avg(showRows.map((r) => (r.sr.n ? r.sr.pct : null)));

  const cards = [
    ['Shows managed', managedCount(manager), true],
    ['Avg HDC rate', avgHdc == null ? '—' : avgHdc + '%'],
    ['Avg success rate', avgSr == null ? '—' : avgSr + '%'],
    ['Picked up', g.pickedUp],
    ['Concluded', g.concluded],
    ['Experiment success %', g.win == null ? '—' : g.win + '%'],
    ['New shows picked up', nseKpis.pickedUp],
    ['Successful launches', nseKpis.launches],
    ['Promoted shows', nseKpis.promoted],
    ['Closed shows', nseKpis.closed],
  ];

  return (
    <div>
      {header}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <button className="text-xs text-slate-500 hover:text-slate-700 underline" onClick={() => setManager('')}>← All managers</button>
        <span className="chip chip-blue">{manager}</span>
        <span className="text-xs text-slate-500">{periodLabel(selPeriod)}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        {cards.map(([k, v, clickable]) => clickable ? (
          <button key={k} className="card p-3 text-left hover:ring-2 hover:ring-slate-300 transition" onClick={() => { setDetailView('shows'); setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }}>
            <div className="text-[11px] text-slate-500">{k} <span className="text-slate-400">· view ↓</span></div>
            <div className="text-xl font-semibold text-slate-800">{v}</div>
          </button>
        ) : (
          <div key={k} className="card p-3">
            <div className="text-[11px] text-slate-500">{k}</div>
            <div className="text-xl font-semibold text-slate-800">{v}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto" ref={tableRef}>
        <div className="px-4 pt-3 flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-semibold">
            {detailView === 'nse' ? 'New show experiments' : detailView === 'shows' ? 'Shows managed' : 'Experiments'}
            {detailView !== 'nse' && <> — {periodLabel(selPeriod)}</>}
            <span className="hint"> ({detailView === 'nse' ? 'all new-show launch experiments owned by this manager' : detailView === 'shows' ? 'HDC rate & success rate over the window' : 'one row per experiment'})</span>
          </div>
          <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs">
            {[['experiments', 'Experiments'], ['shows', 'Shows managed'], ['nse', 'New show experiments']].map(([k, label]) => (
              <button key={k} onClick={() => setDetailView(k)}
                className={`px-3 py-1.5 ${detailView === k ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {detailView === 'nse' ? (
          <>
            <table className="data-table">
              <thead>
                <tr><th>Pickup</th><th>Show</th><th>Show id</th><th>Status</th><th>Videos</th><th>Lifecycle</th><th>Success rate</th><th>Launch</th><th>Review</th><th>Final verdict</th></tr>
              </thead>
              <tbody>
                {nseRows.length ? nseRows.map(({ rec, s, v }) => {
                  const sr = v.stage === 2 ? v.sr2 : v.sr1;
                  const activeReview = rec.extended ? rec.review_date2 : rec.review_date;
                  const launchTag = v.tags.find((t) => t === 'launch successful' || t === 'launch date missed');
                  return (
                    <tr key={rec.id} className={s ? 'row-clickable' : ''} onClick={() => s && openDeepDive(s.id)}>
                      <td className="whitespace-nowrap">{fmtDate(rec.pickup_date)}</td>
                      <td>
                        <div className="font-medium">{rec.show_name || `#${rec.show_id}`}</div>
                        <div className="mt-1 flex gap-1 flex-wrap">
                          <span className="chip chip-blue">{LANG_NAMES[rec.language] || rec.language || '?'}</span>
                          {rec.category && <span className="chip chip-purple">{rec.category}</span>}
                        </div>
                      </td>
                      <td className="text-sm text-slate-600">{rec.show_id || <span className="text-slate-300">—</span>}</td>
                      <td><span className={'chip ' + (s?.status === 'experiment' ? 'chip-amber' : s?.status === 'active' ? 'chip-green' : 'chip-grey')}>{s ? s.status : 'not in data'}</span></td>
                      <td className="font-semibold">{v.stage === 2 ? v.count : Math.min(v.count, 5)}<span className="hint">{v.stage === 2 ? ' /10' : ' /5'}</span></td>
                      <td>{v.lifecycle ? <span className="chip chip-grey">{v.lifecycle}</span> : <span className="text-slate-300">—</span>}</td>
                      <td>{sr && sr.pct != null ? <span className="font-semibold">{sr.pct}%</span> : <span className="text-slate-300">—</span>}{sr && sr.n ? <div className="hint">{sr.pass}/{sr.n}</div> : null}</td>
                      <td className="whitespace-nowrap">{fmtDate(rec.launch_date)}{launchTag && <div><span className={'chip ' + (launchTag === 'launch successful' ? 'chip-green' : 'chip-amber')}>{launchTag}</span></div>}</td>
                      <td className="whitespace-nowrap">{fmtDate(activeReview)}{rec.extended && <div className="hint">extended</div>}</td>
                      <td>{v.effectiveVerdict ? <span className={'chip ' + nseVerdictChip(v.effectiveVerdict)}>{v.effectiveVerdict}</span> : <span className="chip chip-grey">Tracking</span>}</td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan={10} className="text-center text-slate-400 py-6">No new-show experiments owned by {manager}.</td></tr>
                )}
              </tbody>
            </table>
          </>
        ) : detailView === 'shows' ? (
          <table className="data-table">
            <thead>
              <tr><th>Show</th><th>Status</th><th>HDC rate</th><th>Success rate</th><th>Experiments</th><th>Verdict</th></tr>
            </thead>
            <tbody>
              {showRows.length ? showRows.map((r) => (
                <tr key={r.id} className="row-clickable" onClick={() => openDeepDive(r.id)}>
                  <td>
                    <div className="font-medium">{r.title}</div>
                    <div className="mt-1 flex gap-1 flex-wrap">
                      {r.language && <span className="chip chip-blue">{LANG_NAMES[r.language] || r.language}</span>}
                      {r.category && <span className="chip chip-purple">{r.category}</span>}
                    </div>
                  </td>
                  <td><span className={'chip ' + statusChip(r.status)}>{r.status}</span></td>
                  <td>{r.hr.pct == null ? <span className="text-slate-300">—</span> : <span className="font-semibold">{r.hr.pct}%</span>}{r.hr.n ? <div className="hint">{r.hr.hdc}/{r.hr.n}</div> : null}</td>
                  <td>{r.sr.pct == null ? <span className="text-slate-300">—</span> : <span className="font-semibold">{r.sr.pct}%</span>}{r.sr.n ? <div className="hint">{r.sr.pass}/{r.sr.n}</div> : null}</td>
                  <td>{r.exps.length ? <div className="flex flex-col gap-1">{r.exps.map((e) => <span key={e.id} className="chip chip-purple whitespace-nowrap" title={targetText(e.target)}>{metricLabel(e.metric)}</span>)}</div> : <span className="text-slate-300">—</span>}</td>
                  <td>{r.exps.length ? <div className="flex flex-col gap-1">{r.exps.map((e) => { const vm = VERDICT_META[e.verdict] || VERDICT_META.tracking; return <span key={e.id} className={'chip ' + vm.chip}>{vm.label}</span>; })}</div> : <span className="text-slate-300">—</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={6} className="text-center text-slate-400 py-6">No active/experimental shows assigned to {manager}.</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Show</th><th>Metric</th><th>Target</th><th>At pickup</th><th>Current / result</th><th>Date</th><th>Verdict</th></tr>
            </thead>
            <tbody>
              {expRows.length ? expRows.map((e) => {
                const vm = VERDICT_META[e.verdict] || VERDICT_META.tracking;
                const title = e.s?.title || metaById.get(e.showId)?.show_name || `#${e.showId}`;
                const due = !e.concluded && reviewDue(e.claim) && e.verdict === 'tracking';
                const result = e.concluded
                  ? (e.claim.final_snapshot ? trackedValueText(e.target, e.claim.final_snapshot) : '—')
                  : (e.cur ? trackedValueText(e.target, e.cur) : '—');
                return (
                  <tr key={e.id} className="row-clickable" onClick={() => e.s && openDeepDive(e.s.id)}>
                    <td>
                      <div className="font-medium">{title}</div>
                      {e.s && (
                        <div className="mt-1 flex gap-1 flex-wrap">
                          <span className="chip chip-blue">{LANG_NAMES[e.s.language] || e.s.language || '?'}</span>
                          {e.s.category && <span className="chip chip-purple">{e.s.category}</span>}
                        </div>
                      )}
                    </td>
                    <td><span className="chip chip-purple">{metricLabel(e.metric)}</span></td>
                    <td className="text-sm text-slate-600">{targetText(e.target)}</td>
                    <td>{trackedValueText(e.target, e.claim.snapshot)}</td>
                    <td className="font-semibold">{result}</td>
                    <td className="text-sm text-slate-600">
                      {e.concluded ? `concluded ${fmtDate(e.concludedAt)}` : (e.reviewDate ? `review ${fmtDate(e.reviewDate)}` : '—')}
                      {due && <div className="hint" style={{ color: '#991b1b' }}>due</div>}
                    </td>
                    <td><span className={'chip ' + vm.chip}>{vm.label}</span></td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={7} className="text-center text-slate-400 py-6">No experiments for {manager} in {periodLabel(selPeriod)}.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

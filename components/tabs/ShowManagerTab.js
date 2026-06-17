'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex, windowedHdcRate } from '@/lib/hdc';
import { windowedSuccessRate } from '@/lib/metrics';
import {
  POCS, currentFor, metricLabel, targetText, evalVerdict, VERDICT_META,
  weekKey, monthKey, weekRange, monthRange, todayStr,
} from '@/lib/ownership';
import { fmtDate, LANG_NAMES } from '@/lib/format';

const slice10 = (v) => String(v || '').slice(0, 10);

// Per-POC experiment tracking & ownership, scoped to a chosen week/month. A
// "show manager" = the POC who owns (picked up / was assigned) an experiment.
export default function ShowManagerTab() {
  const data = useStore((s) => s.data());
  const actions = useStore((s) => s.actions);
  const history = useStore((s) => s.history);
  const actionsConfigured = useStore((s) => s.actionsConfigured);
  const userName = useStore((s) => s.userName);
  const openDeepDive = useStore((s) => s.openDeepDive);

  const [manager, setManager] = useState(POCS.includes(userName) ? userName : '');
  const [granularity, setGranularity] = useState('weekly'); // 'weekly' | 'monthly'
  const [periodSel, setPeriodSel] = useState(''); // chosen period key

  const model = useMemo(() => buildModel(data), [data]);
  const byId = useMemo(() => new Map(model.map((s) => [String(s.id), s])), [model]);
  const hdcIdx = useMemo(() => (data.hdcRows ? buildHdcIndex(data.hdcRows) : null), [data]);
  const fatIdx = useMemo(() => (data.fatRows ? buildFatIndex(data.fatRows) : null), [data]);

  // Flatten every experiment (active + concluded) into one normalised list.
  const experiments = useMemo(() => {
    const out = [];
    for (const claim of Object.values(actions || {})) {
      const s = byId.get(String(claim.show_id));
      const cur = s ? currentFor(claim, s, data, hdcIdx, fatIdx) : null;
      out.push({
        id: claim.id, claim, concluded: false, by: claim.by, showId: String(claim.show_id), s,
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
          id: rec.id || `${rec.show_id}:${rec.concluded_at}`, claim: rec, concluded: true,
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
            {POCS.map((p) => <option key={p} value={p}>{p}</option>)}
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
    const rows = POCS.map((p) => ({ p, g: scopedFor(p) }))
      .sort((a, b) => b.g.exps.length - a.g.exps.length || a.p.localeCompare(b.p));
    return (
      <div>
        {header}
        <p className="text-sm text-slate-500 mb-3">Showing <b>{periodLabel(selPeriod)}</b>. Click a manager to drill in.</p>
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr><th>Manager</th><th>Shows managed</th><th>Active</th><th>Picked up</th><th>Concluded</th><th>Reached</th><th>Failed</th><th>Win rate</th></tr>
            </thead>
            <tbody>
              {rows.map(({ p, g }) => (
                <tr key={p} className="row-clickable" onClick={() => setManager(p)}>
                  <td className="font-medium text-slate-700">{p}</td>
                  <td>{g.shows.size || <span className="text-slate-300">0</span>}</td>
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
  const showRows = [...g.shows].map((id) => {
    const s = byId.get(id);
    const hr = windowedHdcRate(data.hdcRows, id, win.start, win.end);
    const eps = fatIdx?.get(id)?.eps;
    const sr = eps ? windowedSuccessRate(eps, win.start, win.end) : { pct: null, n: 0 };
    const exps = g.exps.filter((e) => e.showId === id);
    return { id, s, hr, sr, exps };
  }).sort((a, b) => (a.s?.title || a.id).localeCompare(b.s?.title || b.id));

  const avg = (arr) => { const v = arr.filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const avgHdc = avg(showRows.map((r) => (r.hr.n ? r.hr.pct : null)));
  const avgSr = avg(showRows.map((r) => (r.sr.n ? r.sr.pct : null)));

  const cards = [
    ['Shows managed', g.shows.size],
    ['Avg HDC rate', avgHdc == null ? '—' : avgHdc + '%'],
    ['Avg success rate', avgSr == null ? '—' : avgSr + '%'],
    ['Picked up', g.pickedUp],
    ['Concluded', g.concluded],
    ['Win rate', g.win == null ? '—' : g.win + '%'],
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
        {cards.map(([k, v]) => (
          <div key={k} className="card p-3">
            <div className="text-[11px] text-slate-500">{k}</div>
            <div className="text-xl font-semibold text-slate-800">{v}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <div className="px-4 pt-3 text-sm font-semibold">Shows managed — {periodLabel(selPeriod)} <span className="hint">({granularity === 'weekly' ? 'this week' : 'this month'}: HDC rate & success rate over the window)</span></div>
        <table className="data-table">
          <thead>
            <tr><th>Show</th><th>HDC rate</th><th>Success rate</th><th>Experiments</th><th>Target</th><th>Verdict</th></tr>
          </thead>
          <tbody>
            {showRows.length ? showRows.map((r) => (
              <tr key={r.id} className="row-clickable" onClick={() => r.s && openDeepDive(r.s.id)}>
                <td>
                  <div className="font-medium">{r.s?.title || `#${r.id}`}</div>
                  {r.s && (
                    <div className="mt-1 flex gap-1 flex-wrap">
                      <span className="chip chip-blue">{LANG_NAMES[r.s.language] || r.s.language || '?'}</span>
                      {r.s.category && <span className="chip chip-purple">{r.s.category}</span>}
                    </div>
                  )}
                </td>
                <td>{r.hr.pct == null ? <span className="text-slate-300">—</span> : <span className="font-semibold">{r.hr.pct}%</span>}{r.hr.n ? <div className="hint">{r.hr.hdc}/{r.hr.n}</div> : null}</td>
                <td>{r.sr.pct == null ? <span className="text-slate-300">—</span> : <span className="font-semibold">{r.sr.pct}%</span>}{r.sr.n ? <div className="hint">{r.sr.pass}/{r.sr.n}</div> : null}</td>
                <td><div className="flex flex-col gap-1">{r.exps.map((e) => <span key={e.id} className="chip chip-purple whitespace-nowrap">{metricLabel(e.metric)}</span>)}</div></td>
                <td className="text-sm text-slate-600"><div className="flex flex-col gap-1">{r.exps.map((e) => <span key={e.id}>{targetText(e.target)}</span>)}</div></td>
                <td><div className="flex flex-col gap-1">{r.exps.map((e) => { const vm = VERDICT_META[e.verdict] || VERDICT_META.tracking; return <span key={e.id} className={'chip ' + vm.chip}>{vm.label}</span>; })}</div></td>
              </tr>
            )) : (
              <tr><td colSpan={6} className="text-center text-slate-400 py-6">No experiments for {manager} in {periodLabel(selPeriod)}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

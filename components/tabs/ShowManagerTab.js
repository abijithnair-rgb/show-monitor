'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import {
  POCS, currentFor, metricLabel, targetText, trackedValueText,
  evalVerdict, VERDICT_META, reviewDue, weekKey, monthKey,
} from '@/lib/ownership';
import { fmtDate, LANG_NAMES } from '@/lib/format';

// Per-POC experiment tracking & ownership. A "show manager" = the POC who owns
// (picked up / was assigned) an experiment. Shows what each manager is working
// on (active) and has worked on (concluded), with a weekly/monthly time bucket.
export default function ShowManagerTab() {
  const data = useStore((s) => s.data());
  const actions = useStore((s) => s.actions);
  const history = useStore((s) => s.history);
  const actionsConfigured = useStore((s) => s.actionsConfigured);
  const userName = useStore((s) => s.userName);
  const openDeepDive = useStore((s) => s.openDeepDive);

  const initialManager = POCS.includes(userName) ? userName : '';
  const [manager, setManager] = useState(initialManager);
  const [period, setPeriod] = useState('weekly'); // 'weekly' | 'monthly'

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
        id: claim.id, claim, record: null, concluded: false,
        by: claim.by, showId: String(claim.show_id), s, cur,
        claimedAt: claim.claimed_at, concludedAt: null,
        metric: claim.metric, target: claim.target,
        verdict: cur ? evalVerdict(claim, cur) : 'tracking',
      });
    }
    for (const arr of Object.values(history || {})) {
      for (const rec of arr || []) {
        const s = byId.get(String(rec.show_id));
        out.push({
          id: rec.id || `${rec.show_id}:${rec.concluded_at}`, claim: rec, record: rec, concluded: true,
          by: rec.by, showId: String(rec.show_id), s, cur: null,
          claimedAt: rec.claimed_at, concludedAt: rec.concluded_at,
          metric: rec.metric, target: rec.target,
          verdict: rec.verdict === 'reached' ? 'reached' : 'failed',
        });
      }
    }
    return out;
  }, [actions, history, byId, data, hdcIdx, fatIdx]);

  // Per-POC aggregates for the leaderboard.
  const statsByPoc = useMemo(() => {
    const m = new Map();
    const ensure = (p) => { if (!m.has(p)) m.set(p, { active: 0, concluded: 0, reached: 0, failed: 0, shows: new Set() }); return m.get(p); };
    POCS.forEach((p) => ensure(p));
    for (const e of experiments) {
      if (!e.by) continue;
      const g = ensure(e.by);
      g.shows.add(e.showId);
      if (e.concluded) { g.concluded += 1; if (e.verdict === 'reached') g.reached += 1; else g.failed += 1; }
      else g.active += 1;
    }
    return m;
  }, [experiments]);

  const winRate = (g) => {
    const n = g.reached + g.failed;
    return n ? Math.round((g.reached / n) * 100) : null;
  };

  if (!actionsConfigured) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">Show Manager</h2>
        <p className="hint">Shared experiments are not configured on the server — link a Vercel KV (Upstash) store to enable per-POC ownership tracking.</p>
      </div>
    );
  }

  // ---- Header + controls ----
  const header = (
    <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
      <div>
        <h2 className="text-xl font-semibold mb-1">Show Manager</h2>
        <p className="text-sm text-slate-500">Experiment tracking & ownership by POC — what each manager is working on and has worked on.</p>
      </div>
      <div className="flex items-end gap-3">
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Manager
          <select className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800" value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">All managers</option>
            {POCS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs">
          {[['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([k, label]) => (
            <button key={k} onClick={() => setPeriod(k)}
              className={`px-3 py-2 ${period === k ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // ---- A) All managers — ownership leaderboard ----
  if (!manager) {
    const rows = POCS.map((p) => ({ p, g: statsByPoc.get(p) })).sort((a, b) =>
      (b.g.active + b.g.concluded) - (a.g.active + a.g.concluded) || a.p.localeCompare(b.p));
    const totalExp = experiments.length;
    return (
      <div>
        {header}
        <p className="text-sm text-slate-500 mb-3">{totalExp} experiment{totalExp === 1 ? '' : 's'} across {POCS.length} managers. Click a manager to drill in.</p>
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Manager</th><th>Active</th><th>Concluded</th><th>Reached</th><th>Failed</th><th>Win rate</th><th>Shows owned</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, g }) => {
                const wr = winRate(g);
                return (
                  <tr key={p} className="row-clickable" onClick={() => setManager(p)}>
                    <td className="font-medium text-slate-700">{p}</td>
                    <td>{g.active || <span className="text-slate-300">0</span>}</td>
                    <td>{g.concluded || <span className="text-slate-300">0</span>}</td>
                    <td>{g.reached ? <span className="chip chip-green">{g.reached}</span> : <span className="text-slate-300">0</span>}</td>
                    <td>{g.failed ? <span className="chip chip-red">{g.failed}</span> : <span className="text-slate-300">0</span>}</td>
                    <td>{wr == null ? <span className="text-slate-300">—</span> : <span className="font-semibold">{wr}%</span>}</td>
                    <td>{g.shows.size || <span className="text-slate-300">0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ---- B) Single manager view ----
  const mine = experiments.filter((e) => e.by === manager);
  const active = mine.filter((e) => !e.concluded)
    .sort((a, b) => String(b.claimedAt || '').localeCompare(String(a.claimedAt || '')));
  const concluded = mine.filter((e) => e.concluded)
    .sort((a, b) => String(b.concludedAt || '').localeCompare(String(a.concludedAt || '')));
  const g = statsByPoc.get(manager);
  const wr = winRate(g);

  // Per-period buckets, by pickup date.
  const keyOf = period === 'weekly' ? weekKey : monthKey;
  const buckets = (() => {
    const m = new Map();
    for (const e of mine) {
      const k = keyOf(e.claimedAt);
      if (!m.has(k)) m.set(k, { k, pickedUp: 0, concluded: 0, reached: 0, failed: 0 });
      const b = m.get(k);
      b.pickedUp += 1;
      if (e.concluded) { b.concluded += 1; if (e.verdict === 'reached') b.reached += 1; else b.failed += 1; }
    }
    return [...m.values()].sort((a, b) => b.k.localeCompare(a.k));
  })();
  const periodLabel = (k) => (period === 'weekly' ? `Week of ${fmtDate(k)}` : k);

  const cards = [
    ['Active', active.length, 'text-slate-800'],
    ['Concluded', concluded.length, 'text-slate-800'],
    ['Reached', g.reached, 'text-emerald-700'],
    ['Failed', g.failed, 'text-red-700'],
    ['Win rate', wr == null ? '—' : wr + '%', 'text-slate-800'],
    ['Shows owned', g.shows.size, 'text-slate-800'],
  ];

  const ShowCell = ({ s, showId }) => (
    <td>
      <div className="font-medium">{s?.title || `#${showId}`}</div>
      {s && (
        <div className="mt-1 flex gap-1 flex-wrap">
          <span className="chip chip-blue">{LANG_NAMES[s.language] || s.language || '?'}</span>
          {s.category && <span className="chip chip-purple">{s.category}</span>}
        </div>
      )}
    </td>
  );

  return (
    <div>
      {header}
      <div className="flex items-center gap-2 mb-3">
        <button className="text-xs text-slate-500 hover:text-slate-700 underline" onClick={() => setManager('')}>← All managers</button>
        <span className="chip chip-blue">{manager}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        {cards.map(([k, v, cls]) => (
          <div key={k} className="card p-3">
            <div className="text-[11px] text-slate-500">{k}</div>
            <div className={`text-xl font-semibold ${cls}`}>{v}</div>
          </div>
        ))}
      </div>

      {/* Per-period breakdown */}
      <div className="card overflow-x-auto mb-4">
        <div className="px-4 pt-3 text-sm font-semibold">Activity by {period === 'weekly' ? 'week' : 'month'} <span className="hint">(by pickup date)</span></div>
        <table className="data-table">
          <thead>
            <tr><th>Period</th><th>Picked up</th><th>Concluded</th><th>Reached</th><th>Failed</th></tr>
          </thead>
          <tbody>
            {buckets.length ? buckets.map((b) => (
              <tr key={b.k}>
                <td className="font-medium">{periodLabel(b.k)}</td>
                <td>{b.pickedUp}</td>
                <td>{b.concluded}</td>
                <td>{b.reached ? <span className="chip chip-green">{b.reached}</span> : <span className="text-slate-300">0</span>}</td>
                <td>{b.failed ? <span className="chip chip-red">{b.failed}</span> : <span className="text-slate-300">0</span>}</td>
              </tr>
            )) : (
              <tr><td colSpan={5} className="text-center text-slate-400 py-5">No experiments yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Working on (active) */}
      <div className="card overflow-x-auto mb-4">
        <div className="px-4 pt-3 text-sm font-semibold">Working on ({active.length})</div>
        <table className="data-table">
          <thead>
            <tr><th>Show</th><th>Metric</th><th>Target</th><th>Current</th><th>Review date</th><th>Verdict</th></tr>
          </thead>
          <tbody>
            {active.length ? active.map((e) => {
              const vm = VERDICT_META[e.verdict] || VERDICT_META.tracking;
              const due = reviewDue(e.claim) && e.verdict === 'tracking';
              return (
                <tr key={e.id} className="row-clickable" onClick={() => e.s && openDeepDive(e.s.id)}>
                  <ShowCell s={e.s} showId={e.showId} />
                  <td><span className="chip chip-purple">{metricLabel(e.metric)}</span></td>
                  <td className="text-sm text-slate-600">{targetText(e.target)}</td>
                  <td className="font-semibold">{e.cur ? trackedValueText(e.target, e.cur) : '—'}</td>
                  <td>{e.claim.review_date ? fmtDate(e.claim.review_date) : <span className="text-slate-300">—</span>}{due && <div className="hint" style={{ color: '#991b1b' }}>due</div>}</td>
                  <td><span className={'chip ' + vm.chip}>{vm.label}</span></td>
                </tr>
              );
            }) : (
              <tr><td colSpan={6} className="text-center text-slate-400 py-5">Nothing active right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Worked on (concluded) */}
      <div className="card overflow-x-auto">
        <div className="px-4 pt-3 text-sm font-semibold">Worked on ({concluded.length})</div>
        <table className="data-table">
          <thead>
            <tr><th>Show</th><th>Metric</th><th>Target</th><th>At pickup</th><th>Result</th><th>Concluded</th><th>Verdict</th></tr>
          </thead>
          <tbody>
            {concluded.length ? concluded.map((e) => {
              const vm = VERDICT_META[e.verdict] || VERDICT_META.failed;
              return (
                <tr key={e.id} className="row-clickable" onClick={() => e.s && openDeepDive(e.s.id)}>
                  <ShowCell s={e.s} showId={e.showId} />
                  <td><span className="chip chip-purple">{metricLabel(e.metric)}</span></td>
                  <td className="text-sm text-slate-600">{targetText(e.target)}</td>
                  <td>{trackedValueText(e.target, e.record.snapshot)}</td>
                  <td className="font-semibold">{e.record.final_snapshot ? trackedValueText(e.target, e.record.final_snapshot) : '—'}</td>
                  <td>{e.concludedAt ? fmtDate(e.concludedAt) : <span className="text-slate-300">—</span>}</td>
                  <td><span className={'chip ' + vm.chip}>{vm.label}</span></td>
                </tr>
              );
            }) : (
              <tr><td colSpan={7} className="text-center text-slate-400 py-5">No concluded experiments yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

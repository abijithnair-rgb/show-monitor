'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import {
  currentFor, metricLabel, targetText, trackedValueText,
  evalVerdict, VERDICT_META, reviewDue,
} from '@/lib/ownership';
import { fmtDate, LANG_NAMES } from '@/lib/format';
import GroupExperimentsTable, { AddGroupExperimentModal } from '@/components/GroupExperiments';

// Currently running experiments — one row per active claim (the `actions` map).
// Shows metric, POC (owner), status at pickup, target, current number, review
// date and the live verdict. Filterable by POC name.
export default function ExperimentsTab() {
  const data = useStore((s) => s.data());
  const actions = useStore((s) => s.actions);
  const actionsConfigured = useStore((s) => s.actionsConfigured);
  const openDeepDive = useStore((s) => s.openDeepDive);
  const [poc, setPoc] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const model = useMemo(() => buildModel(data), [data]);
  const byId = useMemo(() => new Map(model.map((s) => [String(s.id), s])), [model]);
  const hdcIdx = useMemo(() => (data.hdcRows ? buildHdcIndex(data.hdcRows) : null), [data]);
  const fatIdx = useMemo(() => (data.fatRows ? buildFatIndex(data.fatRows) : null), [data]);

  const rows = useMemo(() => {
    return Object.values(actions || {})
      .map((claim) => {
        const s = byId.get(String(claim.show_id));
        const cur = s ? currentFor(claim, s, data, hdcIdx, fatIdx) : null;
        const verdict = cur ? evalVerdict(claim, cur) : 'tracking';
        return { claim, s, cur, verdict };
      })
      .sort((a, b) => {
        // review-due / concluded first, then by soonest review date.
        const aAttn = a.verdict !== 'tracking' || reviewDue(a.claim);
        const bAttn = b.verdict !== 'tracking' || reviewDue(b.claim);
        if (aAttn !== bAttn) return aAttn ? -1 : 1;
        const ar = a.claim.review_date || '9999';
        const br = b.claim.review_date || '9999';
        return ar < br ? -1 : ar > br ? 1 : 0;
      });
  }, [actions, byId, hdcIdx, fatIdx, data.fatRows]);

  const pocs = useMemo(() => [...new Set(rows.map((r) => r.claim.by).filter(Boolean))].sort(), [rows]);
  const filtered = poc ? rows.filter((r) => r.claim.by === poc) : rows;

  if (!actionsConfigured) {
    return (
      <div>
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="text-xl font-semibold mb-1">Experiments</h2>
            <p className="hint">Shared experiments are not configured on the server — link a Vercel KV (Upstash) store to enable the experiment board.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add experiment</button>
        </div>
        <GroupExperimentsTable />
        {showAdd && <AddGroupExperimentModal onClose={() => setShowAdd(false)} />}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-xl font-semibold mb-1">Experiments</h2>
          <p className="text-sm text-slate-500">{rows.length} running experiment{rows.length === 1 ? '' : 's'} — metric, target, progress & review date.</p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Filter by POC
            <select className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800" value={poc} onChange={(e) => setPoc(e.target.value)}>
              <option value="">All POCs ({rows.length})</option>
              {pocs.map((p) => <option key={p} value={p}>{p} ({rows.filter((r) => r.claim.by === p).length})</option>)}
            </select>
          </label>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add experiment</button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Pickup date</th>
              <th>Show</th>
              <th>Metric</th>
              <th>POC</th>
              <th>Status at pickup</th>
              <th>Target</th>
              <th>Action by</th>
              <th>Current</th>
              <th>Review date</th>
              <th>Remark</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map(({ claim, s, cur, verdict }) => {
                const vm = VERDICT_META[verdict] || VERDICT_META.tracking;
                const due = reviewDue(claim) && verdict === 'tracking';
                // reached (completed & successful) → light green; failed or review-due → red.
                const rowTone = verdict === 'reached' ? ' bg-green-50' : (verdict === 'failed' || due) ? ' bg-red-50' : '';
                return (
                  <tr key={claim.id || claim.show_id} className={'row-clickable' + rowTone}
                    onClick={() => s && openDeepDive(s.id)}>
                    <td className="whitespace-nowrap">{claim.claimed_at ? fmtDate(claim.claimed_at) : <span className="text-slate-300">—</span>}</td>
                    <td>
                      <div className="font-medium">{s?.title || `#${claim.show_id}`}</div>
                      {s && (
                        <div className="mt-1 flex gap-1 flex-wrap">
                          <span className="chip chip-blue">{LANG_NAMES[s.language] || s.language || '?'}</span>
                          {s.category && <span className="chip chip-purple">{s.category}</span>}
                        </div>
                      )}
                    </td>
                    <td><span className="chip chip-purple">{metricLabel(claim.metric)}</span></td>
                    <td className="font-medium text-slate-700">
                      {claim.by}
                      {claim.assigned_by && (
                        <div className="mt-1"><span className="chip chip-amber" title={`Assigned by ${claim.assigned_by}`}>assigned</span></div>
                      )}
                    </td>
                    <td>{trackedValueText(claim.target, claim.snapshot)}</td>
                    <td className="text-sm text-slate-600">{targetText(claim.target)}</td>
                    <td className="whitespace-nowrap">{claim.action_date ? fmtDate(claim.action_date) : <span className="text-slate-300">—</span>}</td>
                    <td className="font-semibold">{cur ? trackedValueText(claim.target, cur) : '—'}</td>
                    <td>
                      {claim.review_date ? fmtDate(claim.review_date) : <span className="text-slate-300">—</span>}
                      {due && <div className="hint" style={{ color: '#991b1b' }}>due</div>}
                    </td>
                    <td>
                      {claim.note ? <div className="text-xs text-slate-600" style={{ maxWidth: 200 }}>{claim.note}</div> : <span className="text-slate-300">—</span>}
                    </td>
                    <td><span className={'chip ' + vm.chip}>{vm.label}</span></td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={11} className="text-center text-slate-400 py-6">
                  {rows.length ? 'No experiments for this POC.' : 'No running experiments. Pick one up in the Action Queue.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <GroupExperimentsTable />
      {showAdd && <AddGroupExperimentModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

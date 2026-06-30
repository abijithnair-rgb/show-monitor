'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import {
  currentFor, metricLabel, targetText, trackedValueText,
  evalVerdict, VERDICT_META, reviewDue, evalConstraints,
} from '@/lib/ownership';
import {
  scopeShows, groupCurrentFor, groupEvalVerdict, groupMetricKeyOfTarget,
  groupMetric, groupMetricLabel, groupTargetText, groupTrackedValueText,
  groupProgressLine, scopeMetaLabel, scopeValueLabel, liveMetricValue,
  GROUP_VERDICT_META, evalGroupConstraints,
} from '@/lib/groupExperiments';
import { fmtDate, LANG_NAMES } from '@/lib/format';
import { ConstraintChips } from '@/components/ConstraintControls';
import { AddGroupExperimentModal, GroupRowControls } from '@/components/GroupExperiments';

const fmtGroupVal = (key, v) => {
  if (v == null) return '—';
  return groupMetric(key)?.unit === '%' ? `${v}%` : v.toLocaleString('en-IN');
};

// Currently running experiments — both per-show ownership experiments (the
// `actions` map) and group experiments scoped to a language / BU / POC (the
// `groupActions` map), merged into one table. Each row shows metric, POC (owner),
// status at pickup, target, current value, review date and the live verdict.
// Filterable by POC name across both kinds.
export default function ExperimentsTab() {
  const data = useStore((s) => s.data());
  const actions = useStore((s) => s.actions);
  const groupActions = useStore((s) => s.groupActions);
  const actionsConfigured = useStore((s) => s.actionsConfigured);
  const openDeepDive = useStore((s) => s.openDeepDive);
  // POC filter lives in the store so it survives navigating into a Deep Dive and back.
  const poc = useStore((s) => s.expPoc);
  const setPoc = useStore((s) => s.setExpPoc);
  const [showAdd, setShowAdd] = useState(false);

  const model = useMemo(() => buildModel(data), [data]);
  const byId = useMemo(() => new Map(model.map((s) => [String(s.id), s])), [model]);
  const hdcIdx = useMemo(() => (data.hdcRows ? buildHdcIndex(data.hdcRows) : null), [data]);
  const fatIdx = useMemo(() => (data.fatRows ? buildFatIndex(data.fatRows) : null), [data]);

  // Unified rows: per-show + group, each normalized with an `isGroup` flag.
  const rows = useMemo(() => {
    const showRows = Object.values(actions || {}).map((claim) => {
      const s = byId.get(String(claim.show_id));
      const cur = s ? currentFor(claim, s, data, hdcIdx, fatIdx) : null;
      const verdict = cur ? evalVerdict(claim, cur) : 'tracking';
      return { isGroup: false, claim, s, cur, verdict, by: claim.by };
    });
    const groupRows = Object.values(groupActions || {}).map((claim) => {
      const sh = scopeShows(model, claim.scope, claim.scope_value);
      const cur = groupCurrentFor(claim, sh, data);
      const verdict = groupEvalVerdict(claim, cur);
      const constraints = claim.constraints?.length ? evalGroupConstraints(claim, sh, data) : [];
      return { isGroup: true, claim, cur, verdict, constraints, by: claim.by };
    });
    return [...showRows, ...groupRows].sort((a, b) => {
      // review-due / concluded first, then by soonest review date.
      const aAttn = a.verdict !== 'tracking' || reviewDue(a.claim);
      const bAttn = b.verdict !== 'tracking' || reviewDue(b.claim);
      if (aAttn !== bAttn) return aAttn ? -1 : 1;
      const ar = a.claim.review_date || '9999';
      const br = b.claim.review_date || '9999';
      return ar < br ? -1 : ar > br ? 1 : 0;
    });
  }, [actions, groupActions, byId, model, hdcIdx, fatIdx, data]);

  const pocs = useMemo(() => [...new Set(rows.map((r) => r.by).filter(Boolean))].sort(), [rows]);
  const filtered = poc ? rows.filter((r) => r.by === poc) : rows;

  return (
    <div>
      <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-xl font-semibold mb-1">Experiments</h2>
          <p className="text-sm text-slate-500">{rows.length} running experiment{rows.length === 1 ? '' : 's'} — show & group, metric, target, progress & review date.</p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Filter by POC
            <select className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800" value={poc} onChange={(e) => setPoc(e.target.value)}>
              <option value="">All POCs ({rows.length})</option>
              {pocs.map((p) => <option key={p} value={p}>{p} ({rows.filter((r) => r.by === p).length})</option>)}
            </select>
          </label>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add experiment</button>
        </div>
      </div>

      {!actionsConfigured && (
        <p className="hint mb-3">Shared experiments are not configured on the server — link a Vercel KV (Upstash) store to enable the experiment board.</p>
      )}

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Pickup date</th>
              <th>Show / Scope</th>
              <th>Metric</th>
              <th>POC</th>
              <th>Status at pickup</th>
              <th>Target</th>
              <th>Action by</th>
              <th>Current</th>
              <th>Review date</th>
              <th>Remark</th>
              <th>Verdict</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((row) => {
                const { claim, verdict } = row;
                const due = reviewDue(claim) && verdict === 'tracking';
                // reached (completed & successful) → light green; failed or review-due → red.
                const rowTone = verdict === 'reached' ? ' bg-green-50' : (verdict === 'failed' || due) ? ' bg-red-50' : '';

                if (row.isGroup) {
                  const { cur, constraints } = row;
                  const vm = GROUP_VERDICT_META[verdict] || GROUP_VERDICT_META.tracking;
                  const mKey = claim.metric || groupMetricKeyOfTarget(claim.target);
                  const pickVal = liveMetricValue(mKey, claim.snapshot);
                  return (
                    <tr key={'g:' + claim.id} className={rowTone}>
                      <td className="whitespace-nowrap">{claim.claimed_at ? fmtDate(claim.claimed_at) : <span className="text-slate-300">—</span>}</td>
                      <td>
                        <span className="chip chip-indigo">{scopeMetaLabel(claim.scope)}</span>
                        <div className="mt-1 font-medium">{scopeValueLabel(claim.scope, claim.scope_value)}</div>
                      </td>
                      <td><span className="chip chip-purple">{groupMetricLabel(mKey)}</span></td>
                      <td className="font-medium text-slate-700">
                        {claim.by}
                        {claim.assigned_by && <div className="mt-1"><span className="chip chip-amber" title={`Assigned by ${claim.assigned_by}`}>assigned</span></div>}
                      </td>
                      <td>{pickVal != null ? fmtGroupVal(mKey, pickVal) : <span className="text-slate-300">—</span>}</td>
                      <td className="text-sm text-slate-600">{groupTargetText(claim.target)}</td>
                      <td className="whitespace-nowrap">{claim.action_date ? fmtDate(claim.action_date) : <span className="text-slate-300">—</span>}</td>
                      <td className="font-semibold" title={groupProgressLine(claim, cur) || ''}>
                        {groupTrackedValueText(claim.target, cur)}
                        {constraints?.length > 0 && <ConstraintChips evaluated={constraints} />}
                      </td>
                      <td>
                        {claim.review_date ? fmtDate(claim.review_date) : <span className="text-slate-300">—</span>}
                        {due && <div className="hint" style={{ color: '#991b1b' }}>due</div>}
                      </td>
                      <td>{claim.note ? <div className="text-xs text-slate-600" style={{ maxWidth: 180 }}>{claim.note}</div> : <span className="text-slate-300">—</span>}</td>
                      <td><span className={'chip ' + vm.chip}>{vm.label}</span></td>
                      <td><GroupRowControls claim={claim} verdict={verdict} cur={cur} /></td>
                    </tr>
                  );
                }

                const { s, cur } = row;
                const vm = VERDICT_META[verdict] || VERDICT_META.tracking;
                return (
                  <tr key={'s:' + (claim.id || claim.show_id)} className={'row-clickable' + rowTone}
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
                    <td className="font-semibold">
                      {cur ? trackedValueText(claim.target, cur) : '—'}
                      {s && claim.constraints?.length > 0 && <ConstraintChips evaluated={evalConstraints(claim, s, data)} />}
                    </td>
                    <td>
                      {claim.review_date ? fmtDate(claim.review_date) : <span className="text-slate-300">—</span>}
                      {due && <div className="hint" style={{ color: '#991b1b' }}>due</div>}
                    </td>
                    <td>
                      {claim.note ? <div className="text-xs text-slate-600" style={{ maxWidth: 200 }}>{claim.note}</div> : <span className="text-slate-300">—</span>}
                    </td>
                    <td><span className={'chip ' + vm.chip}>{vm.label}</span></td>
                    <td></td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={12} className="text-center text-slate-400 py-6">
                  {rows.length ? 'No experiments for this POC.' : 'No running experiments. Pick one up in the Action Queue or add a group experiment.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddGroupExperimentModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

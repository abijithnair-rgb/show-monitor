'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel } from '@/lib/model';
import { fmtDate } from '@/lib/format';
import { POCS, canManageClaim, isManager, EXPERIMENT_MAX_DAYS } from '@/lib/ownership';
import {
  GROUP_SCOPES, scopeMetaLabel, scopeOptions, scopeShows, scopeValueLabel,
  categoryValues, makeCategoryScopeValue, parseCategoryScopeValue,
  GROUP_METRICS, groupMetric, groupMetricLabel,
  groupLiveSnapshot, liveMetricValue,
  makeGroupTarget, defaultGroupOp, groupTargetText, groupMetricKeyOfTarget,
  groupCurrentFor, groupEvalVerdict, GROUP_VERDICT_META,
  groupTrackedValueText, groupProgressLine, reviewDue,
  cleanConstraints, evalGroupConstraints,
} from '@/lib/groupExperiments';
import { ConstraintEditor, ConstraintChips } from '@/components/ConstraintControls';

// Max review date = today + EXPERIMENT_MAX_DAYS (HDC data window), as YYYY-MM-DD.
function maxReviewStr() {
  const d = new Date(); d.setDate(d.getDate() + EXPERIMENT_MAX_DAYS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const fmtVal = (key, v) => {
  if (v == null) return '—';
  return groupMetric(key)?.unit === '%' ? `${v}%` : v.toLocaleString('en-IN');
};

// Searchable single-select dropdown. `options` is [{ value, label }]; calls
// onChange(value) on pick. Used for the (potentially long) category list.
function SearchSelect({ value, options, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const sel = options.find((o) => o.value === value);
  const ql = q.trim().toLowerCase();
  const filtered = ql ? options.filter((o) => o.label.toLowerCase().includes(ql)) : options;
  return (
    <div className="relative" ref={ref}>
      <button type="button"
        className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 text-left min-w-[180px] flex items-center justify-between gap-2"
        onClick={() => { setOpen((o) => !o); setQ(''); }}>
        <span className="truncate">{sel ? sel.label : (placeholder || 'select…')}</span>
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-40 top-full mt-1 w-64 bg-white border border-slate-300 rounded-md shadow-lg">
          <div className="p-1 border-b border-slate-100">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
              className="w-full border border-slate-200 rounded px-2 py-1 text-sm" />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {filtered.length ? filtered.map((o) => (
              <button type="button" key={o.value}
                className={'w-full text-left px-2 py-1 text-sm rounded hover:bg-slate-50 ' + (o.value === value ? 'bg-slate-100 font-medium' : 'text-slate-700')}
                onClick={() => { onChange(o.value); setOpen(false); }}>
                {o.label}
              </button>
            )) : <div className="px-2 py-2 text-xs text-slate-400">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Pick-up form for one metric box ----
function GroupPickupForm({ scope, scopeValue, metricKey, snapshot, onClose, onSaved }) {
  const userName = useStore((s) => s.userName);
  const setUserName = useStore((s) => s.setUserName);
  const claimGroupExp = useStore((s) => s.claimGroupExp);
  const configured = useStore((s) => s.groupActionsConfigured);

  const m = groupMetric(metricKey);
  const cur = liveMetricValue(metricKey, snapshot);
  const [owner, setOwner] = useState(userName || '');
  const [op, setOp] = useState(defaultGroupOp(metricKey));
  const [value, setValue] = useState(() => {
    if (m?.kind === 'sr') return 85;
    return cur != null ? cur : 0;
  });
  const [actionDate, setActionDate] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [constraints, setConstraints] = useState([]);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const confirm = () => {
    const who = (owner || userName).trim();
    if (!who) { setErr('Pick the POC who owns this experiment.'); return; }
    const target = makeGroupTarget(metricKey, op, value);
    if (!target) { setErr(m?.kind === 'sr' ? 'Enter a success-rate target between 1 and 100%.' : 'Enter a valid number.'); return; }
    if (!userName) setUserName(who);
    setErr(null); setBusy(true);
    claimGroupExp(scope, scopeValue, who, snapshot, {
      metric: metricKey, target,
      constraints: cleanConstraints(constraints),
      note: remark.trim() || null,
      action_date: actionDate || null, review_date: reviewDate || null,
    })
      .then(() => (onSaved || onClose)?.())
      .catch((e) => setErr(e.message || 'Could not create the experiment.'))
      .finally(() => setBusy(false));
  };

  const fld = 'border border-slate-300 rounded-md px-2 py-1 text-sm';
  const max = maxReviewStr();
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm mt-3" onClick={(e) => e.stopPropagation()}>
      {err && <div className="banner banner-red text-[12px] mb-2"><span>⚠ {err}</span></div>}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="chip chip-indigo">{scopeMetaLabel(scope)}: {scopeValueLabel(scope, scopeValue)}</span>
        <span className="chip chip-purple">{groupMetricLabel(metricKey)}</span>
        <span className="hint">current {fmtVal(metricKey, cur)} across {snapshot.shows} show{snapshot.shows === 1 ? '' : 's'}</span>
      </div>

      <div className="flex gap-4 flex-wrap items-end">
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          POC (owner)
          <select className={fld} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">select…</option>
            {POCS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>

        {m?.kind === 'sr' ? (
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Target success rate
            <div className="flex items-center gap-1">
              <span className="text-sm text-slate-600">≥</span>
              <input type="number" min="1" max="100" step="1" value={value}
                onChange={(e) => setValue(e.target.value)} className={fld + ' w-20'} />
              <span className="text-sm text-slate-600">%</span>
            </div>
          </label>
        ) : (
          <div className="flex gap-2 items-end flex-wrap">
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              Target
              <select className={fld} value={op} onChange={(e) => setOp(e.target.value)}>
                <option value="gte">at least (≥)</option>
                <option value="lte">at most (≤)</option>
              </select>
            </label>
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              &nbsp;
              <input type="number" min="0" step="1" value={value}
                onChange={(e) => setValue(e.target.value)} className={fld + ' w-20'} />
            </label>
            <span className="text-sm text-slate-600 pb-1.5">
              {m?.kind === 'supply' ? 'videos by review' : `${m?.band} videos by review`}
            </span>
          </div>
        )}
      </div>

      <div className="hint mt-2">
        {m?.kind === 'sr'
          ? `Success rate (settled videos only) across all ${snapshot.shows} shows in this ${scopeMetaLabel(scope).toLowerCase()}, measured on videos posted between the "actions to be taken by" date and the review date.`
          : `Counts the ${m?.kind === 'supply' ? 'videos' : m?.band + ' videos'} this ${scopeMetaLabel(scope).toLowerCase()} publishes between the "actions to be taken by" date and the review date (cumulative across every show).`}
      </div>

      <div className="text-xs text-slate-500 flex flex-col gap-1 mt-3">
        Constraints to maintain <span className="hint">(optional — warning-only; don't change the verdict)</span>
        <ConstraintEditor rows={constraints} onChange={setConstraints} />
      </div>

      <label className="text-xs text-slate-500 flex flex-col gap-1 mt-3">
        Remark
        <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2}
          placeholder="What you're trying / context for the team (optional)"
          className={fld + ' resize-none'} />
      </label>

      <div className="flex gap-4 flex-wrap mt-3">
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Actions to be taken by
          <input type="date" value={actionDate} max={max} onChange={(e) => setActionDate(e.target.value)} className={fld} />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          To be reviewed on
          <input type="date" value={reviewDate} max={max} onChange={(e) => setReviewDate(e.target.value)} className={fld} />
        </label>
      </div>
      <div className="hint mt-1">Review date can be up to {EXPERIMENT_MAX_DAYS} days out.</div>

      <div className="flex gap-2 mt-3">
        <button className="btn btn-primary" disabled={busy || !configured} onClick={confirm}>
          {busy ? 'Saving…' : 'Confirm pick up'}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        {!configured && <span className="hint self-center">Link the shared store (Vercel KV) to enable pick-up.</span>}
      </div>
    </div>
  );
}

// ---- Running group-experiment row controls ----
// Verdict is auto-judged (no manual reached/failed override). Owner or manager
// may conclude a decided/review-due experiment; only a manager (Deepak) may discard.
export function GroupRowControls({ claim, verdict, cur }) {
  const userName = useStore((s) => s.userName);
  const archiveGroupExp = useStore((s) => s.archiveGroupExp);
  const releaseGroupExp = useStore((s) => s.releaseGroupExp);
  const [busy, setBusy] = useState(false);
  const canManage = canManageClaim(claim, userName);
  const canDiscard = isManager(userName);
  const due = reviewDue(claim);
  const canConclude = canManage && (verdict !== 'tracking' || due);

  if (!canConclude && !canDiscard) return <span className="hint">—</span>;
  const run = (fn) => { setBusy(true); Promise.resolve(fn()).finally(() => setBusy(false)); };
  return (
    <div className="flex gap-2 items-center flex-wrap text-xs" onClick={(e) => e.stopPropagation()}>
      {canConclude && (
        // Capture the current aggregate as the final snapshot so the concluded
        // record keeps its result value (groupCurrentValue reads it back).
        <button className="text-slate-700 font-medium hover:underline disabled:opacity-50" disabled={busy} onClick={() => run(() => archiveGroupExp(claim.id, verdict, cur || null))}>conclude</button>
      )}
      {canDiscard && (
        <button className="text-slate-400 hover:text-slate-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => run(() => releaseGroupExp(claim.id))}>discard</button>
      )}
    </div>
  );
}

// ---- "Add experiment" modal: scope selector + metric boxes + pickup form ----
export function AddGroupExperimentModal({ onClose }) {
  const data = useStore((s) => s.data());
  const groupActions = useStore((s) => s.groupActions);
  const configured = useStore((s) => s.groupActionsConfigured);

  const model = useMemo(() => buildModel(data), [data]);

  const [scope, setScope] = useState('language');
  const [scopeValue, setScopeValue] = useState('');
  const [openMetric, setOpenMetric] = useState(null);

  const options = useMemo(() => scopeOptions(model, scope), [model, scope]);

  // Keep scopeValue valid when the scope (or its option set) changes.
  useEffect(() => {
    if (!options.length) { if (scopeValue) setScopeValue(''); return; }
    if (!options.some((o) => o.value === scopeValue)) setScopeValue(options[0].value);
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the open pickup form whenever scope / value changes.
  useEffect(() => { setOpenMetric(null); }, [scope, scopeValue]);

  const shows = useMemo(() => scopeShows(model, scope, scopeValue), [model, scope, scopeValue]);
  const snapshot = useMemo(() => groupLiveSnapshot(shows, data, scope, scopeValue), [shows, data, scope, scopeValue]);

  // Active experiments for the selected scope value (to highlight boxes in use).
  const activeForScope = useMemo(() => {
    const map = {};
    Object.values(groupActions || {}).forEach((c) => {
      if (c.scope === scope && c.scope_value === scopeValue) {
        const k = groupMetricKeyOfTarget(c.target);
        if (k) (map[k] = map[k] || []).push(c);
      }
    });
    return map;
  }, [groupActions, scope, scopeValue]);

  // Category scope is two-level: pick a language first (or "All languages"),
  // then the category within it. The stored value stays "category" / "category::lang".
  const catSel = parseCategoryScopeValue(scopeValue);
  const catLangOptions = scope === 'category' ? scopeOptions(model, 'language') : [];
  const catOptions = scope === 'category' ? categoryValues(model, catSel.lang) : [];

  // Switching language keeps the current category if it exists in that language,
  // otherwise lands on the first category available there (never reverts language).
  const onPickLanguage = (lang) => {
    const cats = categoryValues(model, lang);
    const cat = cats.some((c) => c.value === catSel.category) ? catSel.category : (cats[0]?.value || catSel.category);
    setScopeValue(makeCategoryScopeValue(cat, lang));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 overflow-y-auto py-10" onClick={onClose}>
      <div className="card p-5 w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold mb-1">Add a group experiment</h2>
            <p className="text-sm text-slate-500">
              Move a whole language, business unit, category (optionally one language of it) or POC — pick up an experiment on any movement metric (L0–L5, success rate, supply).
            </p>
          </div>
          <button className="text-slate-400 hover:text-slate-700 text-xl leading-none" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Scope selector */}
        <div className="flex items-end gap-3 flex-wrap mb-3">
          <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
            {GROUP_SCOPES.map((sc) => (
              <button key={sc.key}
                className={'px-3 py-1.5 text-sm ' + (scope === sc.key ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100')}
                onClick={() => setScope(sc.key)}>
                {sc.label}
              </button>
            ))}
          </div>
          {scope === 'category' ? (
            <>
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                Language
                <select className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800"
                  value={catSel.lang || ''}
                  onChange={(e) => onPickLanguage(e.target.value)}>
                  <option value="">All languages</option>
                  {catLangOptions.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                Category
                <SearchSelect
                  value={catSel.category}
                  options={catOptions.map((o) => ({ value: o.value, label: `${o.label} (${o.n})` }))}
                  placeholder="Search category…"
                  onChange={(cat) => setScopeValue(makeCategoryScopeValue(cat, catSel.lang))} />
              </label>
            </>
          ) : (
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              {scopeMetaLabel(scope)}
              <select className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800"
                value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}>
                {!options.length && <option value="">no data</option>}
                {options.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
              </select>
            </label>
          )}
          {scopeValue && (
            <span className="hint pb-1.5">
              {snapshot.shows} show{snapshot.shows === 1 ? '' : 's'} · {snapshot.activeShows} publishing in the last 7 days
            </span>
          )}
        </div>

        {/* Metric boxes */}
        {scopeValue ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {GROUP_METRICS.map((m) => {
                const v = liveMetricValue(m.key, snapshot);
                const inUse = (activeForScope[m.key] || []).length;
                const active = openMetric === m.key;
                return (
                  <button key={m.key}
                    onClick={() => setOpenMetric(active ? null : m.key)}
                    className={'text-left rounded-lg border px-3 py-2 transition ' +
                      (active ? 'border-slate-800 bg-slate-50 ring-1 ring-slate-800' : 'border-slate-200 bg-white hover:border-slate-400')}>
                    <div className="text-[11px] text-slate-500 flex items-center justify-between">
                      <span>{m.label}</span>
                      {inUse ? <span className="chip chip-indigo" style={{ padding: '0 6px' }}>{inUse}</span> : null}
                    </div>
                    <div className="text-lg font-semibold text-slate-800 mt-0.5">{fmtVal(m.key, v)}</div>
                    <div className="text-[10px] text-slate-400">{m.kind === 'sr' ? 'last settled window' : 'last 7 days'}</div>
                  </button>
                );
              })}
            </div>
            <p className="hint mt-2">Click a metric to set a target and pick up an experiment for {scopeValueLabel(scope, scopeValue)}.</p>

            {openMetric && (
              <GroupPickupForm
                scope={scope} scopeValue={scopeValue} metricKey={openMetric}
                snapshot={snapshot} onClose={() => setOpenMetric(null)} onSaved={onClose} />
            )}
            {!configured && !openMetric && (
              <p className="hint mt-2">Group experiments are not configured on the server — link a Vercel KV (Upstash) store to enable pick-up. Metric boxes still compute live from the loaded data.</p>
            )}
          </>
        ) : (
          <p className="hint">No shows available for this scope.</p>
        )}
      </div>
    </div>
  );
}

// ---- Running group experiments table (rendered in the Experiments tab) ----
export default function GroupExperimentsTable() {
  const data = useStore((s) => s.data());
  const groupActions = useStore((s) => s.groupActions);
  const configured = useStore((s) => s.groupActionsConfigured);

  const model = useMemo(() => buildModel(data), [data]);

  // All running group experiments, newest-attention first.
  const rows = useMemo(() => {
    return Object.values(groupActions || {})
      .map((claim) => {
        const sh = scopeShows(model, claim.scope, claim.scope_value);
        const cur = groupCurrentFor(claim, sh, data);
        const verdict = groupEvalVerdict(claim, cur);
        const constraints = claim.constraints?.length ? evalGroupConstraints(claim, sh, data) : [];
        return { claim, cur, verdict, constraints };
      })
      .sort((a, b) => {
        const aAttn = a.verdict !== 'tracking' || reviewDue(a.claim);
        const bAttn = b.verdict !== 'tracking' || reviewDue(b.claim);
        if (aAttn !== bAttn) return aAttn ? -1 : 1;
        const ar = a.claim.review_date || '9999';
        const br = b.claim.review_date || '9999';
        return ar < br ? -1 : ar > br ? 1 : 0;
      });
  }, [groupActions, model, data]);

  // Nothing to show when there are no group experiments and the board is live.
  if (configured && !rows.length) return null;

  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">
        Group experiments {rows.length ? `(${rows.length})` : ''}
      </h3>
      {!configured ? (
        <p className="hint">Group experiments are not configured on the server — link a Vercel KV (Upstash) store to enable the board.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pickup date</th>
                <th>Scope</th>
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
              {rows.map(({ claim, cur, verdict, constraints }) => {
                const vm = GROUP_VERDICT_META[verdict] || GROUP_VERDICT_META.tracking;
                const due = reviewDue(claim) && verdict === 'tracking';
                const tone = verdict === 'reached' ? ' bg-green-50' : (verdict === 'failed' || due) ? ' bg-red-50' : '';
                const mKey = claim.metric || groupMetricKeyOfTarget(claim.target);
                const pickVal = liveMetricValue(mKey, claim.snapshot);
                return (
                  <tr key={claim.id} className={tone}>
                    <td className="whitespace-nowrap">{claim.claimed_at ? fmtDate(claim.claimed_at) : '—'}</td>
                    <td>
                      <span className="chip chip-indigo">{scopeMetaLabel(claim.scope)}</span>
                      <div className="mt-1 font-medium">{scopeValueLabel(claim.scope, claim.scope_value)}</div>
                    </td>
                    <td><span className="chip chip-purple">{groupMetricLabel(mKey)}</span></td>
                    <td className="font-medium text-slate-700">
                      {claim.by}
                      {claim.assigned_by && <div className="mt-1"><span className="chip chip-amber" title={`Assigned by ${claim.assigned_by}`}>assigned</span></div>}
                    </td>
                    <td>{pickVal != null ? fmtVal(mKey, pickVal) : <span className="text-slate-300">—</span>}</td>
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
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

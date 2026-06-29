'use client';
import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { fmtDate, timeAgo } from '@/lib/format';
import {
  METRIC_OPTIONS, metricLabel, reviewDue, todayStr,
  evalVerdict, VERDICT_META, progressLine, sincePickupParts,
  LABEL_BANDS, LABEL_MAX, EXPERIMENT_MAX_DAYS, labelDefaultOp, makeLabelTarget, makeFrequencyTarget, FREQ_MIN, FREQ_MAX, impliedTarget,
  targetText, trackedValueText, POCS, canManageClaim, isManager,
  cleanConstraints, evalConstraints,
} from '@/lib/ownership';
import { ConstraintEditor, ConstraintChips } from '@/components/ConstraintControls';

// Hoisted (stable identity so inputs don't remount on keystroke).
function Numbers({ title, snap }) {
  const cells = [
    ['Contribution', snap?.contrib != null ? snap.contrib + '%' : '—'],
    ['HDC rate', snap?.hdcRate != null ? snap.hdcRate + '%' : '—'],
    ['Success rate', snap?.successRate != null ? snap.successRate + '%' : '—'],
    ['Users', snap?.users != null ? snap.users.toLocaleString() : '—'],
  ];
  return (
    <div>
      <div className="text-xs text-slate-400 mb-1">{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {cells.map(([k, v]) => (
          <div key={k} className="rounded-md border border-slate-200 px-2 py-1.5">
            <div className="text-[11px] text-slate-500">{k}</div>
            <div className="text-sm font-semibold">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DateField({ label, value, set, readOnly, max }) {
  return (
    <label className="text-xs text-slate-500 flex flex-col gap-1">
      {label}
      {readOnly ? (
        <span className="text-sm text-slate-700 font-medium">{value ? fmtDate(value) : '—'}</span>
      ) : (
        <input type="date" value={value || ''} max={max} onChange={(e) => set(e.target.value)}
          className="border border-slate-300 rounded-md px-2 py-1 text-sm" />
      )}
    </label>
  );
}

// Reusable ownership / experiment panel.
//   claimId        → which experiment this panel manages (null = new-experiment
//                    form). A show can have several active experiments.
//   defaultMetric  → metric to pre-select on the new-experiment form (matches the
//                    Action Queue reason).
//   readOnly=true  → summary only (Deep Dive): metric, target, verdict, progress.
//   readOnly=false → interactive: pick-up (or assign) form, then status with
//                    edit dates / override verdict / archive / release.
//   assign=true    → the form assigns to another person (owner = assignee,
//                    recorded with assigned_by = current user). Only offered to
//                    users who canAssign().
export default function PickupPanel({ s, snapshotNow, onClose, readOnly = false, assign = false, claimId = null, defaultMetric = '' }) {
  const claim = useStore((st) => (claimId ? st.actions[String(claimId)] : null));
  const data = useStore((st) => st.data());
  const userName = useStore((st) => st.userName);
  const setUserName = useStore((st) => st.setUserName);
  const claimShow = useStore((st) => st.claimShow);
  const updateClaimFields = useStore((st) => st.updateClaimFields);
  const archiveShow = useStore((st) => st.archiveShow);
  const releaseShow = useStore((st) => st.releaseShow);

  const initialMetric = defaultMetric || 'success_rate';
  const initialBand = defaultMetric === 'label' ? 'L5' : 'L0';
  const [nameDraft, setNameDraft] = useState('');
  const [assignee, setAssignee] = useState('');
  const [metric, setMetric] = useState(initialMetric);
  const [srValue, setSrValue] = useState(80);     // free % entry for success-rate target
  const [labelBand, setLabelBand] = useState(initialBand);
  const [labelOp, setLabelOp] = useState(labelDefaultOp(initialBand));
  const [labelN, setLabelN] = useState(1);
  const [freqOp, setFreqOp] = useState('gte');     // 'gte' = up to, 'lte' = down to
  const [freqN, setFreqN] = useState(3);
  const [constraints, setConstraints] = useState([]); // [{ metric, op, value }]
  const [remark, setRemark] = useState('');
  const [actionDate, setActionDate] = useState(claim?.action_date || '');
  const [reviewDate, setReviewDate] = useState(claim?.review_date || '');
  const [concluding, setConcluding] = useState(false);
  const [concludeNote, setConcludeNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // When the metric or label band changes, reset the dependent target inputs.
  function onMetricChange(m) { setMetric(m); }
  function onBandChange(b) { setLabelBand(b); setLabelOp(labelDefaultOp(b)); }

  // Owner OR a manager may edit/conclude this experiment, but only a manager
  // (Deepak) may DISCARD it — POCs cannot discard their own experiments.
  const canManage = canManageClaim(claim, userName);
  const canDiscard = isManager(userName);
  const manageByManager = canManage && claim && claim.by !== userName; // editing someone else's
  const verdict = claim ? evalVerdict(claim, snapshotNow) : null;
  const vMeta = verdict ? VERDICT_META[verdict] : null;
  const due = reviewDue(claim);
  // review date can't be more than EXPERIMENT_MAX_DAYS past today (HDC data window).
  const maxReview = (() => { const d = new Date(); d.setDate(d.getDate() + EXPERIMENT_MAX_DAYS); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

  async function run(fn) {
    setErr(null); setBusy(true);
    try { await fn(); } catch (e) { setErr(e.message || 'Action failed.'); } finally { setBusy(false); }
  }

  // Build the target object from the metric-specific inputs.
  function buildTarget() {
    if (metric === 'success_rate') {
      const v = Number(srValue);
      if (!(v >= 1 && v <= 100)) return null; // free % entry, 1–100
      return { kind: 'sr_gte', value: Math.round(v * 10) / 10 };
    }
    if (metric === 'label') {
      if (!(Number(labelN) >= 0)) return null;
      return makeLabelTarget(labelBand, labelOp, labelN); // cumulative "produce by review"
    }
    if (metric === 'frequency') {
      const n = Number(freqN);
      if (!(n >= FREQ_MIN && n <= FREQ_MAX)) return null;
      return makeFrequencyTarget(freqOp, n);
    }
    return impliedTarget(metric); // hook/pace/ending fix, stop, promote
  }

  function confirmPickup() {
    const owner = assign ? assignee.trim() : (userName || nameDraft).trim();
    if (assign) {
      if (!owner) { setErr('Enter the name of the person to assign this to.'); return; }
      if (owner.toLowerCase() === String(userName).toLowerCase()) { setErr("You can't assign to yourself — use Pick up instead."); return; }
    } else if (!owner) {
      setErr('Enter your name first so the team knows who picked this up.'); return;
    }
    const target = buildTarget();
    if (!target) { setErr(metric === 'success_rate' ? 'Enter a success-rate target between 1 and 100%.' : metric === 'frequency' ? `Enter a frequency between ${FREQ_MIN} and ${FREQ_MAX}.` : 'Set a valid target.'); return; }
    if (!assign && !userName) setUserName(owner);
    run(async () => {
      await claimShow(s.id, owner, snapshotNow, {
        metric, target,
        constraints: cleanConstraints(constraints),
        assigned_by: assign ? userName : null,
        note: remark.trim() || null,
        action_date: actionDate || null, review_date: reviewDate || null,
      });
      onClose?.();
    });
  }
  const override = (v) => run(() => updateClaimFields(claim.id, { verdict_override: v }));
  const archive = () => run(async () => { await archiveShow(claim.id, verdict, snapshotNow, concludeNote.trim() || null); onClose?.(); });

  // ---- Summary block (shared by read-only + claimed views) ----
  const summary = claim && (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        {vMeta && <span className={'chip ' + vMeta.chip}>{vMeta.label}</span>}
        <span className="chip chip-purple">{metricLabel(claim.metric)}</span>
        <span className="font-medium text-slate-700">{claim.by}</span>
        {claim.assigned_by && <span className="hint">assigned by {claim.assigned_by}</span>}
        {due && verdict === 'tracking' && <span className="chip chip-amber">review due</span>}
      </div>
      <div className="text-xs text-slate-600">
        {progressLine(claim, snapshotNow) || 'Manual action — no auto-tracked target.'}
      </div>
      {claim.constraints?.length > 0 && (
        <ConstraintChips evaluated={evalConstraints(claim, s, data)} />
      )}
      {claim.note && <div className="text-xs text-slate-500">Remark: {claim.note}</div>}
      <div className="hint">
        picked up {fmtDate(claim.claimed_at)} ({timeAgo(claim.claimed_at)})
        {claim.action_date ? ` · act by ${fmtDate(claim.action_date)}` : ''}
        {claim.review_date ? ` · review ${fmtDate(claim.review_date)}` : ''}
      </div>
    </>
  );

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm" onClick={(e) => e.stopPropagation()}>
      {err && <div className="banner banner-red text-[12px] mb-2"><span>⚠ {err}</span></div>}

      {!claim ? (
        readOnly ? (
          <div className="text-slate-400">No active experiment on this show.</div>
        ) : (
          // ---- Pick-up / Assign form ----
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              {assign ? (
                <>
                  <span className="text-slate-500">Assign to:</span>
                  <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
                    className="border border-slate-300 rounded-md px-2 py-1 text-xs">
                    <option value="">select a person…</option>
                    {POCS.filter((p) => p.toLowerCase() !== String(userName).toLowerCase()).map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <span className="hint">assigned by {userName || '—'}</span>
                </>
              ) : (
                <>
                  <span className="text-slate-500">Picked up:</span>
                  <span className="chip chip-blue">today · {fmtDate(todayStr())}</span>
                  {!userName && (
                    <select value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
                      className="border border-slate-300 rounded-md px-2 py-1 text-xs">
                      <option value="">select your name…</option>
                      {POCS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  )}
                </>
              )}
            </div>
            <div className="flex gap-4 flex-wrap items-end">
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                Metric
                <select value={metric} onChange={(e) => onMetricChange(e.target.value)}
                  className="border border-slate-300 rounded-md px-2 py-1 text-sm">
                  {METRIC_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </label>

              {/* Target — metric-specific */}
              {metric === 'success_rate' && (
                <div className="flex gap-3 items-end flex-wrap">
                  <label className="text-xs text-slate-500 flex flex-col gap-1">
                    Target success rate
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-slate-600">≥</span>
                      <input type="number" min="1" max="100" step="1" value={srValue}
                        onChange={(e) => setSrValue(e.target.value)}
                        className="border border-slate-300 rounded-md px-2 py-1 text-sm w-20" />
                      <span className="text-sm text-slate-600">%</span>
                    </div>
                  </label>
                  <span className="text-xs text-slate-500 pb-1.5">
                    current 7-day SR: <b className="text-slate-700">{snapshotNow?.successRate != null ? `${snapshotNow.successRate}%` : '—'}</b>
                  </span>
                </div>
              )}

              {metric === 'frequency' && (
                <div className="flex gap-2 items-end flex-wrap">
                  <label className="text-xs text-slate-500 flex flex-col gap-1">
                    Frequency
                    <select value={freqOp} onChange={(e) => setFreqOp(e.target.value)}
                      className="border border-slate-300 rounded-md px-2 py-1 text-sm">
                      <option value="gte">up to</option>
                      <option value="lte">down to</option>
                    </select>
                  </label>
                  <label className="text-xs text-slate-500 flex flex-col gap-1">
                    &nbsp;
                    <input type="number" min={FREQ_MIN} max={FREQ_MAX} step="1" value={freqN}
                      onChange={(e) => setFreqN(e.target.value)}
                      className="border border-slate-300 rounded-md px-2 py-1 text-sm w-16" />
                  </label>
                  <span className="text-sm text-slate-600 pb-1.5">videos/week by the review date</span>
                </div>
              )}

              {metric === 'label' && (
                <div className="flex gap-2 items-end flex-wrap">
                  <span className="text-sm text-slate-600 pb-1.5">Produce</span>
                  <label className="text-xs text-slate-500 flex flex-col gap-1">
                    &nbsp;
                    <select value={labelOp} onChange={(e) => setLabelOp(e.target.value)}
                      className="border border-slate-300 rounded-md px-2 py-1 text-sm">
                      <option value="gte">at least</option>
                      <option value="lte">at most</option>
                    </select>
                  </label>
                  <label className="text-xs text-slate-500 flex flex-col gap-1">
                    &nbsp;
                    <input type="number" min="0" max={LABEL_MAX} value={labelN}
                      onChange={(e) => setLabelN(e.target.value)}
                      className="border border-slate-300 rounded-md px-2 py-1 text-sm w-16" />
                  </label>
                  <label className="text-xs text-slate-500 flex flex-col gap-1">
                    &nbsp;
                    <select value={labelBand} onChange={(e) => onBandChange(e.target.value)}
                      className="border border-slate-300 rounded-md px-2 py-1 text-sm">
                      {LABEL_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </label>
                  <span className="text-sm text-slate-600 pb-1.5">videos by the review date</span>
                </div>
              )}

              {metric !== 'success_rate' && metric !== 'label' && metric !== 'frequency' && (
                <label className="text-xs text-slate-500 flex flex-col gap-1">
                  Action
                  <span className="text-sm text-slate-700 font-medium border border-slate-200 rounded-md px-2 py-1 bg-white">{targetText(impliedTarget(metric))}</span>
                </label>
              )}
            </div>
            {metric === 'label' && (
              <div className="hint">Counts the {labelBand} videos this show publishes between the "actions to be taken by" date and the review date (cumulative) — giving the POC time to act first.</div>
            )}
            {metric === 'success_rate' && (
              <div className="hint">Measured (settled videos only) on the videos this show posts between the "actions to be taken by" date and the review date — giving the POC time to act first.</div>
            )}
            {metric === 'frequency' && (
              <div className="hint">Cadence = videos in a 7-day window (the last 7 days up to the review date). {freqOp === 'lte' ? `Reached when it cuts to ≤ ${freqN}/wk` : `Reached when it raises to ≥ ${freqN}/wk`} AND the success rate from the "actions to be taken by" date to review is ≥ 75%. Otherwise failed.</div>
            )}
            {(metric === 'hook_fix' || metric === 'pace_fix' || metric === 'ending_fix') && (
              <div className="hint">Reached when the show's drop-off is healthy (no dominant failure mode) by the review date — fixing the {metric.replace('_fix', '')} issue so nothing else is failing. Otherwise failed.</div>
            )}
            <div className="text-xs text-slate-500 flex flex-col gap-1">
              Constraints to maintain <span className="hint">(optional — warning-only; don't change the verdict)</span>
              <ConstraintEditor rows={constraints} onChange={setConstraints} />
            </div>
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              Remark
              <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2}
                placeholder="What you're trying / context for the team (optional)"
                className="border border-slate-300 rounded-md px-2 py-1 text-sm resize-none" />
            </label>
            <div className="flex gap-4 flex-wrap">
              <DateField label="Actions to be taken by" value={actionDate} set={setActionDate} max={maxReview} />
              <DateField label="To be reviewed on" value={reviewDate} set={setReviewDate} max={maxReview} />
            </div>
            <div className="hint">Review date can be up to {EXPERIMENT_MAX_DAYS} days out.</div>
            <Numbers title="Current numbers (snapshot at pickup)" snap={snapshotNow} />
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={busy} onClick={confirmPickup}>
                {busy ? 'Saving…' : assign ? 'Assign experiment' : 'Confirm pick up'}
              </button>
              {onClose && <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>}
            </div>
          </div>
        )
      ) : readOnly ? (
        // ---- Deep Dive: summary only, no actions ----
        <div className="flex flex-col gap-2">{summary}
          {(() => { const p = sincePickupParts(claim.snapshot, snapshotNow); return p.length ? <div className="text-xs text-slate-500">{p.join(' · ')}</div> : null; })()}
        </div>
      ) : (
        // ---- Action Queue: full status + controls ----
        <div className="flex flex-col gap-3">
          {summary}
          {/* Dates are fixed once the experiment is picked up — display only. */}
          <div className="flex gap-4 flex-wrap items-end">
            <DateField label="Actions to be taken by" value={actionDate} readOnly />
            <DateField label="To be reviewed on" value={reviewDate} readOnly />
          </div>
          {(() => { const p = sincePickupParts(claim.snapshot, snapshotNow); return p.length ? <Numbers title="Since pickup" snap={snapshotNow} /> : null; })()}
          {manageByManager && <div className="hint">Managing as {userName} (manager) — this experiment is owned by {claim.by}.</div>}
          {canManage && !concluding && (
            <div className="flex gap-3 items-center flex-wrap text-xs">
              {verdict !== 'reached' && <button className="text-emerald-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => override('reached')}>Mark reached</button>}
              {verdict !== 'failed' && <button className="text-red-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => override('failed')}>Mark failed</button>}
              {claim.verdict_override && <button className="text-slate-500 hover:underline disabled:opacity-50" disabled={busy} onClick={() => override(null)}>Clear override</button>}
              {/* Conclude is only offered once the experiment is decided
                  (reached/failed) or its review date has arrived. */}
              {(verdict !== 'tracking' || due) && (
                <>
                  <span className="text-slate-300">·</span>
                  <button className="text-slate-700 font-medium hover:underline disabled:opacity-50" disabled={busy} onClick={() => setConcluding(true)}>Conclude → save to history</button>
                </>
              )}
              {canDiscard && <button className="text-slate-400 hover:text-slate-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => run(() => releaseShow(claim.id))}>Discard</button>}
            </div>
          )}
          {canManage && concluding && (
            <div className="rounded-md border border-slate-200 bg-white p-2 flex flex-col gap-2">
              <div className="text-xs text-slate-600">
                Concluding as <span className={'chip ' + (vMeta?.chip || 'chip-grey')}>{vMeta?.label || verdict}</span> — result: <b>{trackedValueText(claim.target, snapshotNow)}</b> (target: {targetText(claim.target)}).
              </div>
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                Conclude remark
                <textarea value={concludeNote} onChange={(e) => setConcludeNote(e.target.value)} rows={2}
                  placeholder="Outcome / key learning to keep in history (optional)"
                  className="border border-slate-300 rounded-md px-2 py-1 text-sm resize-none" />
              </label>
              <div className="flex gap-2">
                <button className="btn btn-primary text-xs" disabled={busy} onClick={archive}>{busy ? 'Saving…' : 'Save to history'}</button>
                <button className="btn btn-ghost text-xs" disabled={busy} onClick={() => { setConcluding(false); setConcludeNote(''); }}>Cancel</button>
              </div>
            </div>
          )}
          {!canManage && <div className="hint">Only {claim.by} (the owner) or a manager can update this experiment.</div>}
        </div>
      )}
    </div>
  );
}

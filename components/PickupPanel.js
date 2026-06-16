'use client';
import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { fmtDate, timeAgo } from '@/lib/format';
import {
  METRIC_OPTIONS, metricLabel, targetOptions, reviewDue, todayStr,
  evalVerdict, VERDICT_META, progressLine, sincePickupParts,
} from '@/lib/ownership';

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

function DateField({ label, value, set, readOnly }) {
  return (
    <label className="text-xs text-slate-500 flex flex-col gap-1">
      {label}
      {readOnly ? (
        <span className="text-sm text-slate-700 font-medium">{value ? fmtDate(value) : '—'}</span>
      ) : (
        <input type="date" value={value || ''} onChange={(e) => set(e.target.value)}
          className="border border-slate-300 rounded-md px-2 py-1 text-sm" />
      )}
    </label>
  );
}

// Reusable ownership / experiment panel.
//   readOnly=true  → summary only (Deep Dive): metric, target, verdict, progress.
//   readOnly=false → interactive (Action Queue): pick-up form, then status with
//                    edit dates / override verdict / archive / release.
export default function PickupPanel({ s, snapshotNow, onClose, readOnly = false }) {
  const claim = useStore((st) => st.actions[String(s.id)]);
  const userName = useStore((st) => st.userName);
  const setUserName = useStore((st) => st.setUserName);
  const claimShow = useStore((st) => st.claimShow);
  const updateClaimFields = useStore((st) => st.updateClaimFields);
  const archiveShow = useStore((st) => st.archiveShow);
  const releaseShow = useStore((st) => st.releaseShow);

  const [nameDraft, setNameDraft] = useState('');
  const [metric, setMetric] = useState('success_rate');
  const [targetId, setTargetId] = useState('');
  const [actionDate, setActionDate] = useState(claim?.action_date || '');
  const [reviewDate, setReviewDate] = useState(claim?.review_date || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const isOwner = claim && userName && claim.by === userName;
  const verdict = claim ? evalVerdict(claim, snapshotNow) : null;
  const vMeta = verdict ? VERDICT_META[verdict] : null;
  const due = reviewDue(claim);

  async function run(fn) {
    setErr(null); setBusy(true);
    try { await fn(); } catch (e) { setErr(e.message || 'Action failed.'); } finally { setBusy(false); }
  }

  function confirmPickup() {
    const name = (userName || nameDraft).trim();
    if (!name) { setErr('Enter your name first so the team knows who picked this up.'); return; }
    const opts = targetOptions(metric);
    const chosen = opts.find((o) => o.id === targetId) || opts[0];
    if (!chosen) { setErr('Pick a target for this experiment.'); return; }
    if (!userName) setUserName(name);
    run(async () => {
      await claimShow(s.id, name, snapshotNow, {
        metric, target: chosen.target,
        action_date: actionDate || null, review_date: reviewDate || null,
      });
      onClose?.();
    });
  }
  const saveDates = () => run(() => updateClaimFields(s.id, { action_date: actionDate || null, review_date: reviewDate || null }));
  const override = (v) => run(() => updateClaimFields(s.id, { verdict_override: v }));
  const archive = () => run(() => archiveShow(s.id, verdict, snapshotNow));
  const datesChanged = (claim?.action_date || '') !== actionDate || (claim?.review_date || '') !== reviewDate;

  // ---- Summary block (shared by read-only + claimed views) ----
  const summary = claim && (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        {vMeta && <span className={'chip ' + vMeta.chip}>{vMeta.label}</span>}
        <span className="chip chip-purple">{metricLabel(claim.metric)}</span>
        <span className="font-medium text-slate-700">{claim.by}</span>
        {due && verdict === 'tracking' && <span className="chip chip-amber">review due</span>}
      </div>
      <div className="text-xs text-slate-600">
        {progressLine(claim, snapshotNow) || 'Manual action — no auto-tracked target.'}
      </div>
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
          // ---- Pick-up form ----
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-slate-500">Picked up:</span>
              <span className="chip chip-blue">today · {fmtDate(todayStr())}</span>
              {!userName && (
                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="your name"
                  className="border border-slate-300 rounded-md px-2 py-1 text-xs w-32" />
              )}
            </div>
            <div className="flex gap-4 flex-wrap">
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                Metric you're picking up
                <select value={metric} onChange={(e) => { setMetric(e.target.value); setTargetId(''); }}
                  className="border border-slate-300 rounded-md px-2 py-1 text-sm">
                  {METRIC_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                Target
                <select value={targetId} onChange={(e) => setTargetId(e.target.value)}
                  className="border border-slate-300 rounded-md px-2 py-1 text-sm min-w-[200px]">
                  <option value="">Choose a target…</option>
                  {targetOptions(metric).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>
            </div>
            <div className="flex gap-4 flex-wrap">
              <DateField label="Actions to be taken by" value={actionDate} set={setActionDate} />
              <DateField label="To be reviewed on" value={reviewDate} set={setReviewDate} />
            </div>
            <Numbers title="Current numbers (snapshot at pickup)" snap={snapshotNow} />
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={busy} onClick={confirmPickup}>{busy ? 'Saving…' : 'Confirm pick up'}</button>
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
          <div className="flex gap-4 flex-wrap items-end">
            <DateField label="Actions to be taken by" value={actionDate} set={setActionDate} readOnly={!isOwner} />
            <DateField label="To be reviewed on" value={reviewDate} set={setReviewDate} readOnly={!isOwner} />
            {isOwner && datesChanged && (
              <button className="btn btn-ghost text-xs" disabled={busy} onClick={saveDates}>{busy ? 'Saving…' : 'Save dates'}</button>
            )}
          </div>
          {(() => { const p = sincePickupParts(claim.snapshot, snapshotNow); return p.length ? <Numbers title="Since pickup" snap={snapshotNow} /> : null; })()}
          {isOwner && (
            <div className="flex gap-3 items-center flex-wrap text-xs">
              {verdict !== 'reached' && <button className="text-emerald-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => override('reached')}>Mark reached</button>}
              {verdict !== 'failed' && <button className="text-red-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => override('failed')}>Mark failed</button>}
              {claim.verdict_override && <button className="text-slate-500 hover:underline disabled:opacity-50" disabled={busy} onClick={() => override(null)}>Clear override</button>}
              <span className="text-slate-300">·</span>
              <button className="text-slate-700 font-medium hover:underline disabled:opacity-50" disabled={busy} onClick={archive}>Conclude → save to history</button>
              <button className="text-slate-400 hover:text-slate-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => run(() => releaseShow(s.id))}>Discard</button>
            </div>
          )}
          {!isOwner && <div className="hint">Only {claim.by} (the owner) can update this experiment.</div>}
        </div>
      )}
    </div>
  );
}

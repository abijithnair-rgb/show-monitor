'use client';
import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { fmtDate, timeAgo } from '@/lib/format';
import { reviewDue, sincePickupParts, todayStr } from '@/lib/ownership';

// Hoisted to module scope so their identity is stable across renders — defining
// these inside PickupPanel would remount the <input>s on every keystroke,
// dropping pending edits and focus.
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
        <input type="date" value={value} onChange={(e) => set(e.target.value)}
          className="border border-slate-300 rounded-md px-2 py-1 text-sm" />
      )}
    </label>
  );
}

// Reusable action-ownership panel — used as the expanded row in the Action Queue
// and as a card in the Deep Dive. Pulls the claim + handlers from the store;
// `snapshotNow` is the show's current metrics (computed by the caller).
//
// Two modes:
//   • no claim  → pick-up FORM (picked-up = today, optional action/review dates,
//                 current numbers, "Confirm pick up").
//   • claimed   → status (owner, dates, since-pickup deltas); the owner can edit
//                 the dates, mark done, or release.
export default function PickupPanel({ s, snapshotNow, onClose }) {
  const claim = useStore((st) => st.actions[String(s.id)]);
  const userName = useStore((st) => st.userName);
  const setUserName = useStore((st) => st.setUserName);
  const claimShow = useStore((st) => st.claimShow);
  const updateClaimDates = useStore((st) => st.updateClaimDates);
  const doneShow = useStore((st) => st.doneShow);
  const releaseShow = useStore((st) => st.releaseShow);

  const [nameDraft, setNameDraft] = useState('');
  const [actionDate, setActionDate] = useState(claim?.action_date || '');
  const [reviewDate, setReviewDate] = useState(claim?.review_date || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const isOwner = claim && userName && claim.by === userName;
  const due = reviewDue(claim);

  async function run(fn) {
    setErr(null); setBusy(true);
    try { await fn(); } catch (e) { setErr(e.message || 'Action failed.'); } finally { setBusy(false); }
  }

  function confirmPickup() {
    const name = (userName || nameDraft).trim();
    if (!name) { setErr('Enter your name first so the team knows who picked this up.'); return; }
    if (!userName) setUserName(name);
    run(async () => {
      await claimShow(s.id, name, snapshotNow, { action_date: actionDate || null, review_date: reviewDate || null });
      onClose?.();
    });
  }
  const saveDates = () => run(() => updateClaimDates(s.id, { action_date: actionDate || null, review_date: reviewDate || null }));
  const datesChanged = (claim?.action_date || '') !== actionDate || (claim?.review_date || '') !== reviewDate;

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm" onClick={(e) => e.stopPropagation()}>
      {err && <div className="banner banner-red text-[12px] mb-2"><span>⚠ {err}</span></div>}

      {!claim ? (
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
            <DateField label="Actions to be taken by" value={actionDate} set={setActionDate} />
            <DateField label="To be reviewed on" value={reviewDate} set={setReviewDate} />
          </div>
          <Numbers title="Current numbers (snapshot at pickup)" snap={snapshotNow} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={confirmPickup}>{busy ? 'Saving…' : 'Confirm pick up'}</button>
            {onClose && <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>}
          </div>
        </div>
      ) : (
        // ---- Claimed status ----
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={'chip ' + (claim.status === 'done' ? 'chip-green' : 'chip-amber')}>
              {claim.status === 'done' ? '✓ done' : '● in progress'}
            </span>
            <span className="font-medium text-slate-700">{claim.by}</span>
            <span className="hint">picked up {fmtDate(claim.claimed_at)} ({timeAgo(claim.claimed_at)})</span>
            {due && <span className="chip chip-red">review due</span>}
          </div>
          <div className="flex gap-4 flex-wrap items-end">
            <DateField label="Actions to be taken by" value={actionDate} set={setActionDate} readOnly={!isOwner} />
            <DateField label="To be reviewed on" value={reviewDate} set={setReviewDate} readOnly={!isOwner} />
            {isOwner && datesChanged && (
              <button className="btn btn-ghost text-xs" disabled={busy} onClick={saveDates}>{busy ? 'Saving…' : 'Save dates'}</button>
            )}
          </div>
          <Numbers title="Since pickup" snap={snapshotNow} />
          {(() => {
            const parts = sincePickupParts(claim.snapshot, snapshotNow);
            return parts.length ? <div className="text-xs text-slate-600">{parts.join(' · ')}</div> : null;
          })()}
          {claim.status === 'done' && claim.done_at && <div className="hint">Marked done {fmtDate(claim.done_at)} ({timeAgo(claim.done_at)})</div>}
          {isOwner && (
            <div className="flex gap-3">
              {claim.status !== 'done' && (
                <button className="text-emerald-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => run(() => doneShow(s.id, userName))}>Mark done</button>
              )}
              <button className="text-slate-400 hover:text-slate-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => run(() => releaseShow(s.id))}>Release</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

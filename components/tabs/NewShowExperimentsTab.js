'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { ROSTER, isManager } from '@/lib/ownership';
import { computeNseVerdict, V, MANAGER_VERDICTS } from '@/lib/nseVerdict';
import { fmtDate, LANG_NAMES } from '@/lib/format';

const todayStr = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// chip class for a final verdict.
function verdictChip(v) {
  if (!v) return 'chip-grey';
  if (v === V.PROMOTE) return 'chip-green';
  if (v === V.CONTINUE_5) return 'chip-amber';
  if (v === V.MIN_VIDEO_FAIL || v === V.AWAIT_LIFECYCLE || v === V.NO_SHOW_ID) return 'chip-amber';
  if (v === V.REPLACE || v === V.REPLACE_SR || v === V.STOP_LIFECYCLE || v === V.STOP_CONTRIB || v === V.LAUNCH_FAIL) return 'chip-red';
  return 'chip-grey';
}
const tagChip = (t) => (t === 'launch successful' ? 'chip-green' : t === 'Override Verdict' ? 'chip-purple' : 'chip-amber');
const srText = (sr) => (sr && sr.pct != null ? `${sr.pct}% (${sr.pass}/${sr.n})` : '—');
const monthKey = (d) => String(d || '').slice(0, 7);

// Manual experiment-workflow statuses the show manager can set. "Experiment
// extended" is auto-applied when an experiment is extended (not selectable here).
const EXP_STATUSES = ['Sourcing creator', 'Creator finalised', 'Merchandise released', 'Agreement signed', 'Videos ready in draft'];
const EXP_EXTENDED = 'Experiment extended';

// --- Add-show form ---
function AddShowPanel({ categories, onClose }) {
  const userName = useStore((s) => s.userName);
  const createNseExperiment = useStore((s) => s.createNseExperiment);
  const [f, setF] = useState({
    language: '', manager: ROSTER.includes(userName) ? userName : '', category: '',
    show_name: '', show_id: '', hypothesis: '', launch_date: '', review_date: '', remarks: '', exp_status: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    if (!f.show_name.trim()) return setErr('Show name is required.');
    if (!f.language) return setErr('Pick a language.');
    if (!f.manager) return setErr('Pick a show manager.');
    if (!f.launch_date || !f.review_date) return setErr('Set both a launch date and a review date.');
    setBusy(true); setErr('');
    try {
      await createNseExperiment({ ...f, pickup_date: todayStr(), created_by: userName });
      onClose();
    } catch (e) { setErr(e.message || 'Could not save.'); setBusy(false); }
  };

  const inp = 'border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 w-full';
  return (
    <div className="card p-4 mb-4" style={{ borderColor: '#94a3b8' }}>
      <div className="text-sm font-semibold mb-3">Add a new show experiment</div>
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="text-xs text-slate-500 flex flex-col gap-1">Language
          <select className={inp} value={f.language} onChange={set('language')}>
            <option value="">Select…</option>
            {Object.entries(LANG_NAMES).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Show manager
          <select className={inp} value={f.manager} onChange={set('manager')}>
            <option value="">Select…</option>
            {ROSTER.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Category
          <input className={inp} list="nse-cats" value={f.category} onChange={set('category')} placeholder="Category" />
          <datalist id="nse-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Show name
          <input className={inp} value={f.show_name} onChange={set('show_name')} placeholder="Show name" />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Show id
          <input className={inp} value={f.show_id} onChange={set('show_id')} placeholder="Optional — add later" />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Hypothesis
          <input className={inp} value={f.hypothesis} onChange={set('hypothesis')} placeholder="What are we testing?" />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Experiment status
          <select className={inp} value={f.exp_status} onChange={set('exp_status')}>
            <option value="">— set later</option>
            {EXP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Launch date
          <input type="date" className={inp} value={f.launch_date} onChange={set('launch_date')} />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Review date
          <input type="date" className={inp} value={f.review_date} onChange={set('review_date')} />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Remarks
          <input className={inp} value={f.remarks} onChange={set('remarks')} placeholder="Optional" />
        </label>
      </div>
      {err && <div className="text-xs text-red-600 mt-2">{err}</div>}
      <div className="flex gap-2 mt-3">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save experiment'}</button>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <span className="text-xs text-slate-400 self-center">Launch & review dates can't be changed after saving.</span>
      </div>
    </div>
  );
}

// --- Final-verdict cell (verdict chip, tags, extend control) ---
function VerdictCell({ rec, v }) {
  const extendNseExperiment = useStore((s) => s.extendNseExperiment);
  const [open, setOpen] = useState(false);
  const [d, setD] = useState('');
  const [busy, setBusy] = useState(false);
  const verdict = v.effectiveVerdict;
  const doExtend = async () => {
    if (!d) return;
    setBusy(true);
    try { await extendNseExperiment(rec.id, d); setOpen(false); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-1">
      <span className={'chip ' + verdictChip(verdict)}>{verdict || 'Tracking'}</span>
      {v.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {v.tags.map((t) => <span key={t} className={'chip ' + tagChip(t)}>{t}</span>)}
        </div>
      )}
      {v.canExtend && (
        open ? (
          <div className="flex items-center gap-1 mt-1">
            <input type="date" className="border border-slate-300 rounded-md px-1.5 py-1 text-xs" value={d} onChange={(e) => setD(e.target.value)} />
            <button className="btn btn-primary btn-xs" onClick={doExtend} disabled={busy}>{busy ? '…' : 'Go'}</button>
            <button className="text-slate-400 text-xs underline" onClick={() => setOpen(false)}>cancel</button>
          </div>
        ) : (
          <button className="text-xs text-blue-600 underline self-start mt-0.5" onClick={() => setOpen(true)}>Extend (+5 videos)</button>
        )
      )}
    </div>
  );
}

// --- Manager (Deepak) verdict cell ---
function ManagerVerdictCell({ rec }) {
  const setNseManagerVerdict = useStore((s) => s.setNseManagerVerdict);
  const [verdict, setVerdict] = useState(rec.manager_verdict || '');
  const [remark, setRemark] = useState(rec.manager_remark || '');
  const [busy, setBusy] = useState(false);
  const save = async (nextV, nextR) => {
    setBusy(true);
    try { await setNseManagerVerdict(rec.id, nextV || null, nextR); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-1" style={{ minWidth: 170 }}>
      <select
        className="border border-slate-300 rounded-md px-1.5 py-1 text-xs"
        value={verdict}
        disabled={busy}
        onChange={(e) => { setVerdict(e.target.value); save(e.target.value, remark); }}
      >
        <option value="">— (use system)</option>
        {MANAGER_VERDICTS.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <input
        className="border border-slate-300 rounded-md px-1.5 py-1 text-xs"
        placeholder="Why? (remark)"
        value={remark}
        disabled={busy}
        onChange={(e) => setRemark(e.target.value)}
        onBlur={() => save(verdict, remark)}
      />
    </div>
  );
}

// Inline editable show-id (creators get finalised after pickup, so the id can be
// added later). Remounts when the persisted show_id changes (e.g. auto-matched).
function ShowIdCell({ rec }) {
  const setNseShowId = useStore((s) => s.setNseShowId);
  const [val, setVal] = useState(rec.show_id || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const next = String(val).trim();
    if (next === String(rec.show_id || '').trim()) return;
    setBusy(true);
    try { await setNseShowId(rec.id, next); } finally { setBusy(false); }
  };
  return (
    <input
      className="border border-slate-300 rounded px-1 py-0.5 text-xs w-24"
      value={val}
      placeholder="add show id"
      disabled={busy}
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

// Experiment-workflow status: editable dropdown for the show manager, but once the
// experiment is extended it auto-locks to "Experiment extended" (read-only chip).
function ExpStatusCell({ rec }) {
  const setNseStatus = useStore((s) => s.setNseStatus);
  const [val, setVal] = useState(rec.exp_status || '');
  const [busy, setBusy] = useState(false);
  if (rec.extended) return <span className="chip chip-purple whitespace-nowrap">{EXP_EXTENDED}</span>;
  return (
    <select
      className="border border-slate-300 rounded px-1.5 py-1 text-xs"
      value={val}
      disabled={busy}
      onChange={async (e) => { const next = e.target.value; setVal(next); setBusy(true); try { await setNseStatus(rec.id, next); } finally { setBusy(false); } }}
    >
      <option value="">— set status</option>
      {EXP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

// "hypothesis" CTA under the show name — click to reveal the hypothesis text.
function HypothesisCell({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mt-1">
      <button className="text-xs text-blue-600 underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'hide hypothesis' : 'hypothesis'}
      </button>
      {open && <div className="text-xs text-slate-600 mt-1" style={{ maxWidth: 220 }}>{text}</div>}
    </div>
  );
}

// Small yes/no delete confirmation overlay (Deepak only).
function DeleteConfirm({ onYes, onNo }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onNo}>
      <div className="card p-5 max-w-xs text-center" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium mb-4">Do you want to delete this experiment?</div>
        <div className="flex gap-2 justify-center">
          <button className="btn btn-primary" onClick={onYes}>Yes</button>
          <button className="btn btn-ghost" onClick={onNo}>No</button>
        </div>
      </div>
    </div>
  );
}

export default function NewShowExperimentsTab() {
  const data = useStore((s) => s.data());
  const nse = useStore((s) => s.nse);
  const nseConfigured = useStore((s) => s.nseConfigured);
  const userName = useStore((s) => s.userName);
  const setUserName = useStore((s) => s.setUserName);
  const deleteNseExperiment = useStore((s) => s.deleteNseExperiment);
  const setNseShowId = useStore((s) => s.setNseShowId);

  const manager = isManager(userName);
  const today = todayStr();
  const [adding, setAdding] = useState(false);
  const [confirmDelId, setConfirmDelId] = useState(null); // experiment id pending delete
  const [flt, setFlt] = useState({ month: '', manager: '', language: '', bu: '', verdict: '' });

  const model = useMemo(() => buildModel(data), [data]);
  const byId = useMemo(() => new Map(model.map((s) => [String(s.id), s])), [model]);
  const fatIdx = useMemo(() => (data.fatRows ? buildFatIndex(data.fatRows) : null), [data]);
  const categories = useMemo(() => [...new Set(model.map((s) => s.category).filter(Boolean))].sort(), [model]);
  // category name → BU, to derive a BU for each experiment from its category.
  const buByCat = useMemo(() => {
    const m = new Map();
    model.forEach((s) => { if (s.category && s.bu) m.set(s.category, s.bu); });
    return m;
  }, [model]);

  // Auto-match a missing show_id from the data: when exactly one show in the model
  // shares the experiment's (show name + language), adopt its id and persist it.
  // Ambiguous (>1 match) or no match → left blank for manual entry.
  const idByNameLang = useMemo(() => {
    const id = new Map(), count = new Map();
    model.forEach((s) => {
      const k = String(s.title || '').trim().toLowerCase() + '|' + (s.language || '');
      count.set(k, (count.get(k) || 0) + 1);
      if (!id.has(k)) id.set(k, String(s.id));
    });
    return { id, count };
  }, [model]);
  const triedMatch = useRef(new Set());
  useEffect(() => {
    Object.values(nse || {}).forEach((rec) => {
      if (String(rec.show_id || '').trim() || triedMatch.current.has(rec.id)) return;
      const k = String(rec.show_name || '').trim().toLowerCase() + '|' + (rec.language || '');
      if (idByNameLang.count.get(k) === 1) {
        triedMatch.current.add(rec.id);
        setNseShowId(rec.id, idByNameLang.id.get(k)).catch(() => {});
      }
    });
  }, [nse, idByNameLang, setNseShowId]);

  const rows = useMemo(() => {
    return Object.values(nse || {})
      .map((rec) => {
        const show = byId.get(String(rec.show_id)) || null;
        const eps = fatIdx?.get(String(rec.show_id))?.eps || null;
        const v = computeNseVerdict(rec, show, data.hdcRows, eps, today);
        const bu = (show && show.bu) || buByCat.get(rec.category) || '';
        return { rec, show, v, bu };
      })
      .sort((a, b) => String(b.rec.pickup_date || '').localeCompare(String(a.rec.pickup_date || '')));
  }, [nse, byId, fatIdx, buByCat, today]);

  const months = useMemo(() => [...new Set(rows.map((r) => monthKey(r.rec.pickup_date)).filter(Boolean))].sort().reverse(), [rows]);
  const managers = useMemo(() => [...new Set(rows.map((r) => r.rec.manager).filter(Boolean))].sort(), [rows]);
  const langs = useMemo(() => [...new Set(rows.map((r) => r.rec.language).filter(Boolean))].sort(), [rows]);
  const bus = useMemo(() => [...new Set(rows.map((r) => r.bu).filter(Boolean))].sort(), [rows]);
  const verdicts = useMemo(() => [...new Set(rows.map((r) => r.v.effectiveVerdict || 'Tracking'))].sort(), [rows]);

  const filtered = rows.filter((r) =>
    (!flt.month || monthKey(r.rec.pickup_date) === flt.month) &&
    (!flt.manager || r.rec.manager === flt.manager) &&
    (!flt.language || r.rec.language === flt.language) &&
    (!flt.bu || r.bu === flt.bu) &&
    (!flt.verdict || (r.v.effectiveVerdict || 'Tracking') === flt.verdict)
  );

  // Header KPIs over the filtered set: picked up (total), successful launches
  // (launch-successful tag), promoted, and closed (any stop verdict).
  const CLOSED = new Set([V.REPLACE, V.REPLACE_SR, V.STOP_LIFECYCLE, V.STOP_CONTRIB, V.LAUNCH_FAIL]);
  const kpis = [
    ['New shows picked up', filtered.length],
    ['Successful launches', filtered.filter((r) => r.v.tags.includes('launch successful')).length],
    ['Promoted shows', filtered.filter((r) => r.v.effectiveVerdict === V.PROMOTE).length],
    ['Closed shows', filtered.filter((r) => CLOSED.has(r.v.effectiveVerdict)).length],
  ];

  // 12 base columns; manager adds Manager verdict + the delete action column.
  const colCount = manager ? 14 : 12;

  if (!nseConfigured) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">New Show Experiments</h2>
        <p className="hint">New Show Experiments storage is not configured on the server — link a Vercel KV (Upstash) store to enable the board.</p>
      </div>
    );
  }

  const sel = 'border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800';
  return (
    <div>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-xl font-semibold">New Show Experiments</h2>
          <p className="text-sm text-slate-500">Track new-show launches through the 5→10 video experiment lifecycle, success rate & lifecycle verdict.</p>
          <div className="flex items-center gap-2 text-xs text-slate-600 mt-1">
            <span className="text-slate-400">You:</span>
            {userName ? (
              <>
                <span className="chip chip-blue">{userName}</span>
                <button className="text-slate-400 hover:text-slate-700 underline" onClick={() => setUserName('')}>change</button>
              </>
            ) : (
              <select value="" onChange={(e) => { if (e.target.value) setUserName(e.target.value); }} className="border border-slate-300 rounded-md px-2 py-1 text-xs">
                <option value="">select your name…</option>
                {ROSTER.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding((a) => !a)}>+ Add show</button>
      </div>

      {/* Header KPIs — experiment metrics over the filtered set */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {kpis.map(([k, v]) => (
          <div key={k} className="card p-3">
            <div className="text-[11px] text-slate-500">{k}</div>
            <div className="text-2xl font-semibold text-slate-800">{v}</div>
          </div>
        ))}
      </div>

      {adding && <AddShowPanel categories={categories} onClose={() => setAdding(false)} />}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap mb-3">
        <select className={sel} value={flt.month} onChange={(e) => setFlt((p) => ({ ...p, month: e.target.value }))}>
          <option value="">All months</option>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className={sel} value={flt.manager} onChange={(e) => setFlt((p) => ({ ...p, manager: e.target.value }))}>
          <option value="">All managers</option>
          {managers.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className={sel} value={flt.language} onChange={(e) => setFlt((p) => ({ ...p, language: e.target.value }))}>
          <option value="">All languages</option>
          {langs.map((l) => <option key={l} value={l}>{LANG_NAMES[l] || l}</option>)}
        </select>
        <select className={sel} value={flt.bu} onChange={(e) => setFlt((p) => ({ ...p, bu: e.target.value }))}>
          <option value="">All BUs</option>
          {bus.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className={sel} value={flt.verdict} onChange={(e) => setFlt((p) => ({ ...p, verdict: e.target.value }))}>
          <option value="">All verdicts</option>
          {verdicts.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Pickup date</th>
              <th>Launch date</th>
              <th>Show name</th>
              <th>Show id</th>
              <th>Show manager</th>
              <th>Current status</th>
              <th>Experiment status</th>
              <th>Videos</th>
              <th>Lifecycle verdict</th>
              <th>Success rate</th>
              <th>Review date</th>
              {manager && <th>Manager verdict</th>}
              <th>Final verdict</th>
              {manager && <th></th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length ? filtered.map(({ rec, show, v }) => {
              const activeReview = rec.extended ? rec.review_date2 : rec.review_date;
              const sr = v.stage === 2 ? v.sr2 : v.sr1;
              return (
                <tr key={rec.id}>
                  <td className="whitespace-nowrap">{fmtDate(rec.pickup_date)}</td>
                  <td className="whitespace-nowrap">{fmtDate(rec.launch_date)}</td>
                  <td>
                    <div className="font-medium">{rec.show_name || `#${rec.show_id}`}</div>
                    <div className="mt-1 flex gap-1 flex-wrap items-center">
                      <span className="chip chip-blue">{LANG_NAMES[rec.language] || rec.language || '?'}</span>
                      {rec.category && <span className="chip chip-purple">{rec.category}</span>}
                    </div>
                    <HypothesisCell text={rec.hypothesis} />
                  </td>
                  <td><ShowIdCell key={rec.id + ':' + (rec.show_id || '')} rec={rec} /></td>
                  <td className="font-medium text-slate-700">{rec.manager || '—'}</td>
                  <td>
                    <span className={'chip ' + (show?.status === 'experiment' ? 'chip-amber' : show?.status === 'active' ? 'chip-green' : 'chip-grey')}>
                      {show ? show.status : 'not in data'}
                    </span>
                  </td>
                  <td><ExpStatusCell key={rec.id + ':' + (rec.extended ? 'ext' : rec.exp_status || '')} rec={rec} /></td>
                  <td className="font-semibold">{v.stage === 2 ? v.count : Math.min(v.count, 5)}<span className="hint">{v.stage === 2 ? ' /10' : ' /5'}</span></td>
                  <td>{v.lifecycle ? <span className="chip chip-grey">{v.lifecycle}</span> : <span className="text-slate-300">—</span>}</td>
                  <td>{srText(sr)}</td>
                  <td className="whitespace-nowrap">
                    {fmtDate(activeReview)}
                    {rec.extended && <div className="hint">extended</div>}
                  </td>
                  {manager && <td><ManagerVerdictCell rec={rec} /></td>}
                  <td><VerdictCell rec={rec} v={v} /></td>
                  {manager && (
                    <td>
                      <button className="text-slate-300 hover:text-red-600 text-xs" title="Delete experiment"
                        onClick={() => setConfirmDelId(rec.id)}>✕</button>
                    </td>
                  )}
                </tr>
              );
            }) : (
              <tr><td colSpan={colCount} className="text-center text-slate-400 py-6">
                {rows.length ? 'No experiments match these filters.' : 'No experiments yet. Add a show to start tracking a launch.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmDelId && (
        <DeleteConfirm
          onYes={() => { deleteNseExperiment(confirmDelId); setConfirmDelId(null); }}
          onNo={() => setConfirmDelId(null)}
        />
      )}
    </div>
  );
}

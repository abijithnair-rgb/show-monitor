'use client';
import { useMemo, useState } from 'react';
import { fmtNum, num, addDays } from '@/lib/format';
import { buildHdcRca, seriesDates } from '@/lib/hdcRca';

// One full day-over-day HDC RCA block (D-2 vs D-3) for a single language or a
// language group. Self-contained: own day pickers, exec report, headline cards,
// deltas, BU (optional) + manager breakdowns, and L0 series lists. Collapsible —
// the header shows a quick L0 D-2→D-3 summary so collapsed sections still inform.

const FINDING_DOT = { bad: '#dc2626', good: '#16a34a', warn: '#d97706', info: '#64748b' };
const fmtVal = (v, unit) => (v == null ? '—' : `${v}${unit || ''}`);

function Metric({ label, big, sub, tone }) {
  return (
    <div className="kpi">
      <div className="lbl">{label}</div>
      <div className="val text-base" style={tone ? { color: tone } : undefined}>{big}</div>
      {sub && <div className="hint mt-0.5">{sub}</div>}
    </div>
  );
}

function DirChip({ dir }) {
  const map = { UP: ['chip-green', '↑ up'], DOWN: ['chip-red', '↓ down'], FLAT: ['chip-grey', '→ flat'] };
  const [cls, txt] = map[dir] || map.FLAT;
  return <span className={'chip ' + cls}>{txt}</span>;
}

export default function HdcRcaSection({ title, blurb, rows, showBU = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [sel1, setSel1] = useState('');
  const [sel2, setSel2] = useState('');

  const seriesRows = rows || [];
  const dates = useMemo(() => seriesDates(seriesRows), [seriesRows]); // newest first

  const today = useMemo(() => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }, []);
  const defCur = addDays(today, -2); // D-2
  const defPri = addDays(today, -3); // D-3
  const pick1 = sel1 || (dates.includes(defCur) ? defCur : dates[0] || '');
  const pick2 = sel2 || (dates.includes(defPri) ? defPri : dates[1] || dates[0] || '');
  // curSel = D-2 = newer; priSel = D-3 = older — derived from the dates, not the
  // dropdown order, so the labels can never be switched relative to the data.
  const curSel = pick1 >= pick2 ? pick1 : pick2;
  const priSel = pick1 >= pick2 ? pick2 : pick1;

  const rca = useMemo(
    () => (curSel && priSel ? buildHdcRca(seriesRows, curSel, priSel) : null),
    [seriesRows, curSel, priSel]
  );

  // collapsed-header summary chip: L0 D-2 → D-3
  const summary = rca
    ? `L0 ${rca.hCurrent.l0}→${rca.hPrior.l0}`
    : `${seriesRows.length} series`;
  const l0Delta = rca ? rca.hCurrent.l0 - rca.hPrior.l0 : 0;

  const Header = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className="w-full flex items-center justify-between gap-3 text-left"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-lg font-semibold">{title}</span>
        {seriesRows.length > 0 && (
          <span
            className={'chip ' + (l0Delta > 0 ? 'chip-green' : l0Delta < 0 ? 'chip-red' : 'chip-grey')}
          >
            {summary}
          </span>
        )}
      </div>
      <span className="text-slate-400 text-sm shrink-0">{open ? '▾ hide' : '▸ show'}</span>
    </button>
  );

  if (!seriesRows.length) {
    return (
      <div className="card p-4 mb-4">
        {Header}
        {open && (
          <div className="mt-3 text-sm text-slate-400">
            No per-series HDC rows for this language yet. Re-run the Daily RCA query (qid 109927) after
            the merge, then sync — or load the sample data on the Data tab.
          </div>
        )}
      </div>
    );
  }

  const { hPrior, hCurrent, dlt, bu, mgr, listPrior, listCurrent, report } = rca;

  const HeadlineCard = ({ label, day, h, n, primary }) => (
    <div className="card p-4" style={primary ? { borderColor: '#94a3b8' } : undefined}>
      <div className="text-sm font-semibold mb-2">{label} <span className="hint">· {day} · {n} series</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="L0 count" big={h.l0} tone="#16a34a" sub={`HDC ${fmtVal(h.hdcPct, '%')}`} />
        <Metric label="View pass %" big={fmtVal(h.viewPassPct, '%')} />
        <Metric label="CR pass %" big={fmtVal(h.crPassPct, '%')} />
        <Metric label="p90 threshold" big={h.p90Threshold != null ? fmtNum(h.p90Threshold) : '—'} sub="LEAST(p90, cap)" />
        <Metric label="Avg views" big={h.avgViews != null ? fmtNum(h.avgViews) : '—'} />
        <Metric label="Avg CR" big={fmtVal(h.avgCr, '%')} />
        <Metric label="Total series" big={h.total} />
      </div>
    </div>
  );

  const GroupTable = ({ tableTitle, data, driverNoun }) => (
    <div className="card p-4 mb-3">
      <div className="text-sm font-semibold mb-2">{tableTitle}</div>
      <table className="data-table">
        <thead>
          <tr><th>{driverNoun}</th><th>L0 (D-2)</th><th>L0 (D-3)</th><th>Net Δ</th><th>View pass% (D-2)</th><th>View pass% (D-3)</th></tr>
        </thead>
        <tbody>
          {data.rows.map((g) => (
            <tr key={g.key} className={g.key === data.driverKey ? 'bg-amber-50' : ''}>
              <td className="font-medium">{g.key}{g.key === data.driverKey && <span className="chip chip-amber ml-2">driver</span>}</td>
              <td>{g.l0_current}</td>
              <td>{g.l0_prior}</td>
              <td style={{ color: g.l0_delta > 0 ? '#16a34a' : g.l0_delta < 0 ? '#dc2626' : '#64748b', fontWeight: 600 }}>{g.l0_delta > 0 ? '+' : ''}{g.l0_delta}</td>
              <td>{fmtVal(g.viewPassPct_current, '%')}</td>
              <td>{fmtVal(g.viewPassPct_prior, '%')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const L0Table = ({ label, day, list }) => (
    <div className="card p-4 mb-3">
      <div className="text-sm font-semibold mb-2">{label} <span className="hint">· {day} · {list.length} L0</span></div>
      {list.length ? (
        <table className="data-table">
          <thead>
            <tr><th>Series</th><th>Show</th><th>Manager</th><th>BU</th><th>Views 24h</th><th>Achieved CR</th><th>Target CR</th></tr>
          </thead>
          <tbody>
            {list.map((x, i) => (
              <tr key={i}>
                <td>{x.series}{x.isNew && <span className="chip chip-green ml-2">new</span>}</td>
                <td>{x.show}</td>
                <td>{x.manager}</td>
                <td><span className="chip chip-blue">{x.bu}</span></td>
                <td>{x.views != null ? fmtNum(x.views) : '—'}</td>
                <td style={{ fontWeight: 600 }}>{fmtVal(num(x.achievedCr) != null ? Math.round(x.achievedCr) : null, '%')}</td>
                <td className="hint">{fmtVal(num(x.targetCr) != null ? Math.round(x.targetCr) : null, '%')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="text-sm text-slate-400">No L0 this day.</div>}
    </div>
  );

  return (
    <div className="card p-4 mb-4">
      {Header}
      {open && (
        <div className="mt-3">
          <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
            {blurb ? <p className="text-sm text-slate-500 max-w-2xl">{blurb}</p> : <span />}
            <div className="flex items-end gap-2">
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                D-2 (current · newer)
                <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={curSel} onChange={(e) => setSel1(e.target.value)}>
                  {dates.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-500 flex flex-col gap-1">
                D-3 (compare · older)
                <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={priSel} onChange={(e) => setSel2(e.target.value)}>
                  {dates.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            </div>
          </div>

          {/* §6 — executive RCA report */}
          <div className="card p-4 mb-5" style={{ background: '#fafafa', borderColor: '#cbd5e1' }}>
            <div className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">Executive RCA — D-2 ({curSel}) vs D-3 ({priSel})</div>
            <ul className="space-y-1.5">
              {report.map((f, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-700">
                  <span className="mt-1.5 shrink-0 rounded-full" style={{ width: 7, height: 7, background: FINDING_DOT[f.tone] || FINDING_DOT.info }} />
                  <span className={f.kind === 'tldr' ? 'font-medium' : ''}>{f.text}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* §1 headline numbers — D-2 (current) first */}
          <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">Day-level headline numbers</div>
          <div className="grid lg:grid-cols-2 gap-3 mb-5">
            <HeadlineCard label="D-2 (current)" day={curSel} h={hCurrent} n={rca.nCurrent} primary />
            <HeadlineCard label="D-3 (compare)" day={priSel} h={hPrior} n={rca.nPrior} />
          </div>

          {/* §2 deltas */}
          <div className="card p-4 mb-5">
            <div className="text-sm font-semibold mb-2">Key deltas <span className="hint">(D-2 vs D-3)</span></div>
            <table className="data-table">
              <thead><tr><th>Metric</th><th>D-2</th><th>D-3</th><th>Δ</th><th>% Δ</th><th>Direction</th></tr></thead>
              <tbody>
                {dlt.rows.map((m) => (
                  <tr key={m.key}>
                    <td className="font-medium">{m.label}{m.key === 'p90Threshold' && dlt.thresholdMoved && <span className="chip chip-amber ml-2">moved</span>}</td>
                    <td>{fmtVal(m.current, m.unit)}</td>
                    <td>{fmtVal(m.prior, m.unit)}</td>
                    <td style={{ fontWeight: 600 }}>{m.abs == null ? '—' : `${m.abs > 0 ? '+' : ''}${m.abs}${m.unit || ''}`}</td>
                    <td className="hint">{m.pctDelta == null ? '—' : `${m.pctDelta > 0 ? '+' : ''}${m.pctDelta}%`}</td>
                    <td><DirChip dir={m.dir} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* §3 BU (Hindi only) + §4 manager */}
          <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">Breakdowns</div>
          {showBU && <GroupTable tableTitle="By BU" data={bu} driverNoun="BU" />}
          <GroupTable tableTitle="By show manager" data={mgr} driverNoun="Manager" />

          {/* §5 L0 lists — D-2 (current) first */}
          <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2 mt-2">L0 series</div>
          <div className="grid lg:grid-cols-2 gap-3">
            <L0Table label="D-2 (current)" day={curSel} list={listCurrent} />
            <L0Table label="D-3 (compare)" day={priSel} list={listPrior} />
          </div>
        </div>
      )}
    </div>
  );
}

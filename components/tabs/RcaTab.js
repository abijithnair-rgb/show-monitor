'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { fmtNum, num, addDays } from '@/lib/format';
import { buildHdcRca, seriesDates, normalizeSeriesRow } from '@/lib/hdcRca';
import RegionalRca from '@/components/RegionalRca';

// Daily RCA. Hindi day-over-day HDC view (D-2 current vs D-3) on top, with the
// regional-language label-led RCA below.

const FINDING_DOT = { bad: '#dc2626', good: '#16a34a', warn: '#d97706', info: '#64748b' };

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

const fmtVal = (v, unit) => (v == null ? '—' : `${v}${unit || ''}`);

export default function RcaTab() {
  const rcaRows = useStore((s) => s.rcaRows);
  const seriesRows = useMemo(
    () => (rcaRows || []).filter((r) => r.level === 'HDC_SERIES').map(normalizeSeriesRow),
    [rcaRows]
  );
  const dates = useMemo(() => seriesDates(seriesRows), [seriesRows]); // newest first
  // Calendar defaults: D-2 = today − 2, D-3 = today − 3 (e.g. today 17th →
  // D-2 = 15th, D-3 = 14th). Use the exact calendar dates when the data has them,
  // else fall back to the two most-recent days present.
  const today = useMemo(() => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }, []);
  const defCur = addDays(today, -2); // D-2
  const defPri = addDays(today, -3); // D-3
  // Two day selections. D-2 (current) is ALWAYS the more-recent of the two; D-3
  // (compare) the older — derived from the actual dates, not dropdown position,
  // so the labels can never be switched relative to the data.
  const [sel1, setSel1] = useState('');
  const [sel2, setSel2] = useState('');
  const pick1 = sel1 || (dates.includes(defCur) ? defCur : dates[0] || '');
  const pick2 = sel2 || (dates.includes(defPri) ? defPri : dates[1] || dates[0] || '');
  // curSel = D-2 = the newer date; priSel = D-3 = the older date.
  const curSel = pick1 >= pick2 ? pick1 : pick2;
  const priSel = pick1 >= pick2 ? pick2 : pick1;

  const rca = useMemo(
    () => (curSel && priSel ? buildHdcRca(seriesRows, curSel, priSel) : null),
    [seriesRows, curSel, priSel]
  );

  if (!seriesRows.length) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">Daily RCA — Hindi HDC (D-2 vs D-3)</h2>
        <p className="text-sm text-slate-500 mb-4">Compares HDC performance on D-2 (the latest settled day) against D-3, with BU & manager breakdowns and the L0 series list. Regional-language RCA shows below.</p>
        <div className="card p-8 text-center text-slate-400">
          No per-series HDC rows found. This view needs the day-over-day series detail (level <code>HDC_SERIES</code>) — re-run the Daily RCA query (qid 109927) after the merge, then sync, or load the sample data on the Data tab.
        </div>
        <RegionalRca rcaRows={rcaRows} />
      </div>
    );
  }

  const { hPrior, hCurrent, dlt, bu, mgr, listPrior, listCurrent, report } = rca;

  // headline card; primary = D-2 highlighted
  const HeadlineCard = ({ label, day, h, n, primary }) => (
    <div className="card p-4" style={primary ? { borderColor: '#94a3b8' } : undefined}>
      <div className="text-sm font-semibold mb-2">{label} <span className="hint">· {day} · {n} series</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="L0 count" big={h.l0} tone="#16a34a" sub={`HDC ${fmtVal(h.hdcPct, '%')}`} />
        <Metric label="View pass %" big={fmtVal(h.viewPassPct, '%')} />
        <Metric label="CR pass %" big={fmtVal(h.crPassPct, '%')} />
        <Metric label="p90 threshold" big={h.p90Threshold != null ? fmtNum(h.p90Threshold) : '—'} sub="LEAST(p90, 1500)" />
        <Metric label="Avg views" big={h.avgViews != null ? fmtNum(h.avgViews) : '—'} />
        <Metric label="Avg CR" big={fmtVal(h.avgCr, '%')} />
        <Metric label="Total series" big={h.total} />
      </div>
    </div>
  );

  // group table — current(D-2) column first, then prior(D-3)
  const GroupTable = ({ title, data, driverNoun }) => (
    <div className="card p-4 mb-3">
      <div className="text-sm font-semibold mb-2">{title}</div>
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
    <div>
      <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-semibold">Daily RCA — Hindi HDC (D-2 vs D-3)</h2>
          <p className="text-sm text-slate-500">Where we are now (<b>D-2</b>) compared against <b>D-3</b>, with BU & manager breakdowns and the L0 series list. Regional-language RCA is below.</p>
        </div>
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

      {/* §3 BU + §4 manager */}
      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">Breakdowns</div>
      <GroupTable title="By BU" data={bu} driverNoun="BU" />
      <GroupTable title="By show manager" data={mgr} driverNoun="Manager" />

      {/* §5 L0 lists — D-2 (current) first */}
      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2 mt-2">L0 series</div>
      <div className="grid lg:grid-cols-2 gap-3">
        <L0Table label="D-2 (current)" day={curSel} list={listCurrent} />
        <L0Table label="D-3 (compare)" day={priSel} list={listPrior} />
      </div>

      {/* Regional-language RCA */}
      <RegionalRca rcaRows={rcaRows} />
    </div>
  );
}

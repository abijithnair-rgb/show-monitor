'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { fmtNum, num } from '@/lib/format';
import { buildHdcRca, seriesDates, normalizeSeriesRow } from '@/lib/hdcRca';

// Hindi day-over-day HDC RCA. Reads the per-series detail rows (level='HDC_SERIES')
// merged into the Daily RCA query and compares two publish days across 6 sections.

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
  const dates = useMemo(() => seriesDates(seriesRows), [seriesRows]);
  // default: day_b = most recent, day_a = the one before it
  const [dayA, setDayA] = useState('');
  const [dayB, setDayB] = useState('');
  const bSel = dayB || dates[0] || '';
  const aSel = dayA || dates[1] || dates[0] || '';

  const rca = useMemo(
    () => (aSel && bSel ? buildHdcRca(seriesRows, aSel, bSel) : null),
    [seriesRows, aSel, bSel]
  );

  if (!seriesRows.length) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">Daily RCA — Hindi HDC (day over day)</h2>
        <p className="text-sm text-slate-500 mb-4">Compares HDC performance between two publish days for Hindi, with BU & show-manager breakdowns and an L0 series list.</p>
        <div className="card p-8 text-center text-slate-400">
          No per-series HDC rows found. This view needs the day-over-day series detail (level <code>HDC_SERIES</code>) — re-run the Daily RCA query (qid 109927) after the merge, then sync, or load the sample data on the Data tab.
        </div>
      </div>
    );
  }

  const { hA, hB, dlt, bu, mgr, listA, listB, verdict } = rca;

  const HeadlineCard = ({ title, h, n }) => (
    <div className="card p-4">
      <div className="text-sm font-semibold mb-2">{title} <span className="hint">({n} series)</span></div>
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

  const GroupTable = ({ title, data, driverNoun }) => (
    <div className="card p-4 mb-3">
      <div className="text-sm font-semibold mb-2">{title}</div>
      <table className="data-table">
        <thead>
          <tr><th>{driverNoun}</th><th>L0 (A)</th><th>L0 (B)</th><th>Net Δ</th><th>View pass% (A)</th><th>View pass% (B)</th></tr>
        </thead>
        <tbody>
          {data.rows.map((g) => (
            <tr key={g.key} className={g.key === data.driverKey ? 'bg-amber-50' : ''}>
              <td className="font-medium">{g.key}{g.key === data.driverKey && <span className="chip chip-amber ml-2">driver</span>}</td>
              <td>{g.l0_a}</td>
              <td>{g.l0_b}</td>
              <td style={{ color: g.l0_delta > 0 ? '#16a34a' : g.l0_delta < 0 ? '#dc2626' : '#64748b', fontWeight: 600 }}>{g.l0_delta > 0 ? '+' : ''}{g.l0_delta}</td>
              <td>{fmtVal(g.viewPassPct_a, '%')}</td>
              <td>{fmtVal(g.viewPassPct_b, '%')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const L0Table = ({ title, list }) => (
    <div className="card p-4 mb-3">
      <div className="text-sm font-semibold mb-2">{title} <span className="hint">({list.length} L0)</span></div>
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
          <h2 className="text-xl font-semibold">Daily RCA — Hindi HDC (day over day)</h2>
          <p className="text-sm text-slate-500">HDC performance for Hindi compared between two publish days, with BU & manager breakdowns and the L0 series list.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Earlier day (A)
            <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={aSel} onChange={(e) => setDayA(e.target.value)}>
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Later day (B)
            <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={bSel} onChange={(e) => setDayB(e.target.value)}>
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* §6 verdict up top as the executive read */}
      <div className="card p-4 mb-5" style={{ background: '#fafafa', borderColor: '#cbd5e1' }}>
        <div className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">Root-cause verdict</div>
        <p className="text-sm text-slate-700">{verdict}</p>
        {dlt.strongerSignal && <p className="text-xs text-emerald-700 mt-1">Threshold rose while L0 still increased — a genuinely stronger signal, not an easier bar.</p>}
      </div>

      {/* §1 headline numbers */}
      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">Day-level headline numbers</div>
      <div className="grid lg:grid-cols-2 gap-3 mb-5">
        <HeadlineCard title={`Day A · ${aSel}`} h={hA} n={rca.nA} />
        <HeadlineCard title={`Day B · ${bSel}`} h={hB} n={rca.nB} />
      </div>

      {/* §2 deltas */}
      <div className="card p-4 mb-5">
        <div className="text-sm font-semibold mb-2">Key deltas <span className="hint">(B vs A)</span></div>
        <table className="data-table">
          <thead><tr><th>Metric</th><th>Day A</th><th>Day B</th><th>Δ</th><th>% Δ</th><th>Direction</th></tr></thead>
          <tbody>
            {dlt.rows.map((m) => (
              <tr key={m.key}>
                <td className="font-medium">{m.label}{m.key === 'p90Threshold' && dlt.thresholdMoved && <span className="chip chip-amber ml-2">moved</span>}</td>
                <td>{fmtVal(m.a, m.unit)}</td>
                <td>{fmtVal(m.b, m.unit)}</td>
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

      {/* §5 L0 lists */}
      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2 mt-2">L0 series</div>
      <div className="grid lg:grid-cols-2 gap-3">
        <L0Table title={`Day A · ${aSel}`} list={listA} />
        <L0Table title={`Day B · ${bSel}`} list={listB} />
      </div>
    </div>
  );
}

'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { num, fmtNum, LANG_NAMES } from '@/lib/format';

// Segment groups in display order. Each entry: how to pick the matching RCA row.
const GROUPS = [
  { title: 'Overall', match: (r) => r.level === 'TOTAL' },
  { title: 'Hindi — overall', match: (r) => r.level === 'LANGUAGE' && r.segment === 'hi' },
  { title: 'Hindi — by BU', match: (r) => r.level === 'BU', order: ['Awareness', 'Income', 'Skill'] },
  { title: 'Regional languages', match: (r) => r.level === 'LANGUAGE' && r.segment !== 'hi', order: ['te', 'ta', 'ml', 'kn'] },
];

const segLabel = (r) => (r.segment === 'overall_httmk' ? 'All languages (hi+ta+te+ml+kn)' : LANG_NAMES[r.segment] || r.segment);

// verdict → tone chip
function verdictChip(v) {
  const s = String(v || '').toUpperCase();
  let cls = 'chip-grey', txt = v || '—';
  if (/_DROP$/.test(s)) cls = 'chip-red';
  else if (/_RISE$/.test(s)) cls = 'chip-green';
  else if (s === 'NORMAL') cls = 'chip-grey';
  else if (/SETTL|TRACK|BASELINE|NO_/.test(s)) cls = 'chip-light';
  return <span className={'chip ' + cls}>{String(txt).replace(/_/g, ' ').toLowerCase()}</span>;
}

// comovement pattern → banner tone
function patternTone(p) {
  const s = String(p || '');
  if (/CONTENT-LED DECLINE|DIVERGENCE/.test(s)) return 'banner-red';
  if (/LEADING RISK/.test(s)) return 'banner-amber';
  if (/LIFTING DAU|FRESH HITS/.test(s)) return 'banner-yellow';
  if (/NOT CONTENT/.test(s)) return 'banner-yellow';
  return 'banner-yellow';
}

// delta vs baseline → coloured "+x" / "-x"
function Delta({ value, suffix = '', invert = false }) {
  const v = num(value);
  if (v == null) return <span className="hint">—</span>;
  const up = v > 0;
  const good = invert ? !up : up;
  const color = v === 0 ? '#64748b' : good ? '#16a34a' : '#dc2626';
  return <span style={{ color, fontWeight: 600 }}>{up ? '+' : ''}{v}{suffix}</span>;
}

function Metric({ label, big, sub, tone }) {
  return (
    <div className="kpi">
      <div className="lbl">{label}</div>
      <div className="val text-base" style={tone ? { color: tone } : undefined}>{big}</div>
      {sub && <div className="hint mt-0.5">{sub}</div>}
    </div>
  );
}

function RcaCard({ r }) {
  const hdcRate = num(r.hdc_rate);
  const hdcRate7 = num(r.hdc_rate_7davg);
  const hdcRateDelta = hdcRate != null && hdcRate7 != null ? Math.round((hdcRate - hdcRate7) * 10) / 10 : null;
  const hdcCount = num(r.hdc_count);
  const hdc7 = num(r.hdc_7davg);
  const supply = num(r.hdc_supply);
  const dau = num(r.dau);
  const sr = num(r.sr_pct);
  const sr7 = num(r.sr_7davg);
  const srDelta = sr != null && sr7 != null ? Math.round((sr - sr7) * 10) / 10 : null;

  const hdcTone = /_DROP$/.test(String(r.hdc_verdict).toUpperCase()) ? '#dc2626'
    : /_RISE$/.test(String(r.hdc_verdict).toUpperCase()) ? '#16a34a' : '#0f172a';

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-lg font-semibold">{segLabel(r)}</span>
        {verdictChip(r.hdc_verdict)}
      </div>

      {r.comovement_pattern && !/^(aligned|insufficient)/.test(String(r.comovement_pattern)) && (
        <div className={'banner ' + patternTone(r.comovement_pattern) + ' mb-3'} style={{ display: 'block' }}>
          <span className="text-sm">{r.comovement_pattern}</span>
        </div>
      )}

      {/* HDC is the lead block */}
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Metric
          label="HDC rate"
          big={hdcRate != null ? `${hdcRate}%` : '—'}
          tone={hdcTone}
          sub={<>7dAvg {hdcRate7 != null ? `${hdcRate7}%` : '—'} · <Delta value={hdcRateDelta} suffix="pp" /></>}
        />
        <Metric
          label="HDC count"
          big={hdcCount != null ? fmtNum(hdcCount) : '—'}
          sub={<>of {supply != null ? fmtNum(supply) : '—'} eligible · 7dAvg {hdc7 != null ? hdc7 : '—'}</>}
        />
        <Metric
          label="Misses (view / cr / both)"
          big={`${num(r.miss_view_only) ?? 0} / ${num(r.miss_cr_only) ?? 0} / ${num(r.miss_both) ?? 0}`}
          sub="view=distribution · cr=content"
        />
      </div>

      {r.hdc_attribution && (
        <div className="text-sm text-slate-700 mb-3"><b>Why:</b> {r.hdc_attribution}</div>
      )}

      {/* Relation to DAU & SR */}
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Metric
          label="Paid DAU"
          big={dau != null ? fmtNum(dau) : '—'}
          sub={<>vs7dAvg <Delta value={num(r.dau_7davg_pct)} suffix="%" /> · {String(r.dau_verdict || '').replace(/_/g, ' ').toLowerCase()}</>}
        />
        <Metric
          label="Success rate"
          big={sr != null ? `${sr}%` : '—'}
          sub={<>7dAvg {sr7 != null ? `${sr7}%` : '—'} · <Delta value={srDelta} suffix="pp" /></>}
        />
        <Metric
          label="Correlation HDC↔DAU"
          big={num(r.corr_hdc_dau) != null ? num(r.corr_hdc_dau) : '—'}
          sub={<>SR↔DAU {num(r.corr_sr_dau) ?? '—'} · HDC↔SR {num(r.corr_hdc_sr) ?? '—'}</>}
        />
      </div>

      {r.auto_rca && (
        <div className="text-sm text-slate-600 border-t border-slate-100 pt-2 whitespace-pre-wrap">{r.auto_rca}</div>
      )}
    </div>
  );
}

export default function RcaTab() {
  const rcaRows = useStore((s) => s.rcaRows);
  const dates = useMemo(
    () => [...new Set((rcaRows || []).map((r) => r.report_date).filter(Boolean))].sort().reverse(),
    [rcaRows]
  );
  const [date, setDate] = useState('');
  const activeDate = date || dates[0] || '';

  if (!rcaRows || !rcaRows.length) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">Daily RCA</h2>
        <p className="text-sm text-slate-500 mb-4">Morning content RCA — what moved across HDC, paid DAU and success rate, and why.</p>
        <div className="card p-8 text-center text-slate-400">
          No RCA data loaded. Run the <b>Daily RCA</b> query in Redash and upload its CSV on the Data tab.
        </div>
      </div>
    );
  }

  const dayRows = rcaRows.filter((r) => r.report_date === activeDate);
  const ordered = (g) => {
    const rows = dayRows.filter(g.match);
    if (g.order) rows.sort((a, b) => g.order.indexOf(a.segment) - g.order.indexOf(b.segment));
    return rows;
  };

  return (
    <div>
      <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-semibold">Daily RCA</h2>
          <p className="text-sm text-slate-500">Content health for <b>{activeDate}</b> — led by HDC, with its relation to paid DAU & success rate.</p>
        </div>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Report date
          <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={activeDate} onChange={(e) => setDate(e.target.value)}>
            {dates.map((d) => (<option key={d} value={d}>{d}</option>))}
          </select>
        </label>
      </div>

      {GROUPS.map((g) => {
        const rows = ordered(g);
        if (!rows.length) return null;
        return (
          <div key={g.title} className="mb-5">
            <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">{g.title}</div>
            {rows.map((r) => (
              <RcaCard key={`${r.level}-${r.segment}`} r={r} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

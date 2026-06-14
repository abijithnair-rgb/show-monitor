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

// Build explicit root-cause findings (what went wrong / notable) as bullet points.
// tone: 'bad' (red), 'good' (green), 'warn' (amber), 'info' (slate).
function rcaFindings(r) {
  const out = [];
  const n = (x) => num(x);
  const hdcRate = n(r.hdc_rate), hdcRate7 = n(r.hdc_rate_7davg);
  const hdcCount = n(r.hdc_count), hdc7 = n(r.hdc_7davg);
  const supply = n(r.hdc_supply), supply7 = n(r.supply_7davg);
  const mv = n(r.miss_view_only) ?? 0, mc = n(r.miss_cr_only) ?? 0, mb = n(r.miss_both) ?? 0;
  const sr = n(r.sr_pct), sr7 = n(r.sr_7davg);
  const dauPct = n(r.dau_7davg_pct);
  const hv = String(r.hdc_verdict || '').toUpperCase();

  // --- HDC (the lead) ---
  if (hv === 'HDC_DROP') {
    const pp = hdcRate != null && hdcRate7 != null ? Math.round((hdcRate - hdcRate7) * 10) / 10 : null;
    out.push({ tone: 'bad', text: `HDC dropped: ${hdcCount ?? '—'} hits vs 7-day avg ${hdc7 ?? '—'}${pp != null ? ` (rate ${hdcRate}% vs ${hdcRate7}%, ${pp}pp)` : ''}.` });
    if (r.hdc_attribution) out.push({ tone: 'bad', text: r.hdc_attribution.replace(/^HDC down /, 'Root cause: ') });
    else if (supply != null && supply7 != null && supply < supply7 * 0.85) out.push({ tone: 'warn', text: `Fewer launches today (${supply} eligible vs 7dAvg ${supply7}) — part of the HDC drop is supply, not quality.` });
  } else if (hv === 'HDC_RISE') {
    out.push({ tone: 'good', text: `HDC rose: ${hdcCount ?? '—'} hits vs 7-day avg ${hdc7 ?? '—'} (rate ${hdcRate}%).` });
  }

  // --- Miss routing (where the failure sits) ---
  const totMiss = mv + mc + mb;
  if (totMiss > 0 && (hv === 'HDC_DROP' || mc + mb >= mv)) {
    if (mc + mb >= mv && (mc + mb) > 0) {
      out.push({ tone: 'bad', text: `Mostly CONTENT misses (${mc} cr-only + ${mb} both vs ${mv} view-only) → route to show managers: hook / pacing / target mismatch.` });
    } else if (mv > 0) {
      out.push({ tone: 'warn', text: `Mostly VIEW misses (${mv} view-only) → distribution / recommendations problem, not the content itself.` });
    }
  }

  // --- Success rate ---
  if (sr != null && sr7 != null) {
    const d = Math.round((sr - sr7) * 10) / 10;
    if (d <= -10) out.push({ tone: 'bad', text: `Success rate fell to ${sr}% vs 7-day avg ${sr7}% (${d}pp) — settled cohort D-10→D-4 underperforming on completion.` });
    else if (d >= 10) out.push({ tone: 'good', text: `Success rate strong at ${sr}% vs 7-day avg ${sr7}% (+${d}pp).` });
  }

  // --- Paid DAU ---
  const dv = String(r.dau_verdict || '').toUpperCase();
  if (dv === 'REAL_DROP') {
    out.push({ tone: 'bad', text: `Paid DAU real drop (${dauPct}% vs 7dAvg, down on all 3 baselines).${r.src_drop_driver ? ` Source: ${String(r.src_drop_driver).trim()}.` : ''}${r.cohort_drop_driver ? ` Cohort: ${String(r.cohort_drop_driver).trim()}.` : ''}` });
  } else if (dv === 'SOFT_DROP') {
    out.push({ tone: 'warn', text: `Paid DAU soft dip (${dauPct}% vs 7dAvg) — not confirmed on DoD/SDLW, likely weekday noise.` });
  } else if (dv === 'REAL_RISE') {
    out.push({ tone: 'good', text: `Paid DAU real rise (+${dauPct}% vs 7dAvg).` });
  }

  // --- Co-movement (the joint story) ---
  const p = String(r.comovement_pattern || '');
  if (/CONTENT-LED DECLINE/.test(p)) out.push({ tone: 'bad', text: 'Joint signal: HDC + SR + DAU all down together — weak fresh content is dragging DAU. Highest-priority block.' });
  else if (/LEADING RISK/.test(p)) out.push({ tone: 'warn', text: 'Leading risk: HDC is down but DAU still holding on catalog — expect DAU softness in the next few days if HDC stays low.' });
  else if (/DIVERGENCE/.test(p)) out.push({ tone: 'warn', text: 'Divergence: strong new content but DAU down — distribution isn’t converting the supply.' });
  else if (/NOT CONTENT/.test(p)) out.push({ tone: 'info', text: 'DAU down while content is healthy — look outside content (distribution / notifications / seasonality).' });

  if (!out.length) out.push({ tone: 'good', text: 'No anomalies — HDC, success rate and paid DAU all within normal range vs baselines.' });
  return out;
}

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

      {/* RCA — what went wrong, as points */}
      <div className="mb-3">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Root-cause findings</div>
        <ul className="space-y-1">
          {rcaFindings(r).map((f, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-700">
              <span className="mt-1.5 shrink-0 rounded-full" style={{ width: 7, height: 7, background: FINDING_DOT[f.tone] }} />
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* HDC is the lead block */}
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Metric
          label="HDC rate (D-2)"
          big={hdcRate != null ? `${hdcRate}%` : '—'}
          tone={hdcTone}
          sub={<>7dAvg {hdcRate7 != null ? `${hdcRate7}%` : '—'} · <Delta value={hdcRateDelta} suffix="pp" /></>}
        />
        <Metric
          label="HDC count (D-2)"
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
          label="Success rate (D-10→D-4)"
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
          <p className="text-sm text-slate-500">Content health for <b>{activeDate}</b> — HDC measured at D-2, success rate over the settled D-10→D-4 cohort, with their relation to paid DAU.</p>
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

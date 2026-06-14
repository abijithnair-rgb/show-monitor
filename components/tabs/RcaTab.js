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
  const contentMiss = mc + mb;   // CR failures (incl. both) = content problem
  const viewMiss = mv;           // reach failures = distribution problem
  if (hv === 'HDC_DROP') {
    const pp = hdcRate != null && hdcRate7 != null ? Math.round((hdcRate - hdcRate7) * 10) / 10 : null;
    out.push({ tone: 'bad', text: `HDC dropped: ${hdcCount ?? '—'} hits vs 7-day avg ${hdc7 ?? '—'}${pp != null ? ` (rate ${hdcRate}% vs ${hdcRate7}%, ${pp}pp)` : ''}.` });
    // Root cause derived ONCE from the actual miss breakdown (no contradiction).
    if (supply != null && supply7 != null && supply < supply7 * 0.85) {
      out.push({ tone: 'warn', text: `Root cause: SUPPLY — fewer launches (${supply} eligible vs 7dAvg ${supply7}).` });
    } else if (viewMiss > contentMiss && viewMiss > 0) {
      out.push({ tone: 'bad', text: `Root cause: DISTRIBUTION — mostly view misses (${viewMiss} view-only vs ${contentMiss} CR). Content cleared its target; reach/recommendations are the gap.` });
    } else if (contentMiss > viewMiss && contentMiss > 0) {
      out.push({ tone: 'bad', text: `Root cause: CONTENT — mostly CR misses (${mc} cr-only + ${mb} both vs ${viewMiss} view-only) → show managers: hook / pacing / target.` });
    } else if (viewMiss + contentMiss > 0) {
      out.push({ tone: 'bad', text: `Root cause: MIXED — ${viewMiss} view-only and ${contentMiss} CR misses in roughly equal measure.` });
    }
  } else if (hv === 'HDC_RISE') {
    out.push({ tone: 'good', text: `HDC rose: ${hdcCount ?? '—'} hits vs 7-day avg ${hdc7 ?? '—'} (rate ${hdcRate}%).` });
  } else if ((viewMiss + contentMiss) > 0) {
    // Not a flagged drop, but still surface where the misses concentrate.
    if (viewMiss > contentMiss) out.push({ tone: 'info', text: `Misses lean DISTRIBUTION: ${viewMiss} view-only vs ${contentMiss} CR.` });
    else if (contentMiss > viewMiss) out.push({ tone: 'info', text: `Misses lean CONTENT: ${contentMiss} CR vs ${viewMiss} view-only.` });
  }

  // --- Success rate (D-10→D-4 settled cohort) ---
  if (sr != null) {
    if (sr < 50) out.push({ tone: 'bad', text: `Success rate ${sr}% over the settled D-10→D-4 cohort — under half of launches are clearing their completion target.` });
    else if (sr >= 75) out.push({ tone: 'good', text: `Success rate strong at ${sr}% over the settled D-10→D-4 cohort.` });
  }
  // D-4 (latest settled) vs D-2 (HDC day, live) single-day success rate
  const cr4 = n(r.cr_d4), cr2 = n(r.cr_d2);
  if (cr4 != null && cr4 < 50) out.push({ tone: 'warn', text: `D-4 single-day success rate ${cr4}% — under half of the newest settled day’s launches cleared their target.` });
  if (cr2 != null) {
    if (cr2 < 50) out.push({ tone: 'info', text: `D-2 (HDC day) success rate ${cr2}% — live 24h read (not frozen); early signal that today’s HDC-day launches are under-completing.` });
    else out.push({ tone: 'info', text: `D-2 (HDC day) success rate ${cr2}% — live 24h read (not frozen), for reference.` });
  }

  // --- Paid DAU ---
  const dv = String(r.dau_verdict || '').toUpperCase();
  // biggest DoD drop within a dimension → tells you exactly where the movement came from
  const biggestDrop = (defs) => {
    let best = null;
    defs.forEach(([label, cur, dod]) => {
      const c = n(cur), d = n(dod);
      if (c == null || d == null) return;
      const delta = c - d;          // negative = lost users
      if (delta < 0 && (!best || delta < best.delta)) best = { label, delta, cur: c, dod: d };
    });
    return best;
  };
  const srcDrop = biggestDrop([
    ['organic', r.dau_organic, r.dau_organic_dod], ['push', r.dau_push, r.dau_push_dod],
    ['MoEngage', r.dau_moe, r.dau_moe_dod], ['WhatsApp', r.dau_whatsapp, r.dau_whatsapp_dod],
  ]);
  const cohortDrop = biggestDrop([
    ['D0', r.dau_d0, r.dau_d0_dod], ['D1-D3', r.dau_d1_d3, r.dau_d1_d3_dod], ['D4-D7', r.dau_d4_d7, r.dau_d4_d7_dod],
    ['D8-D14', r.dau_d8_d14, r.dau_d8_d14_dod], ['D15-D30', r.dau_d15_d30, r.dau_d15_d30_dod], ['D30+', r.dau_d30_plus, r.dau_d30_plus_dod],
  ]);
  const utDrop = biggestDrop([
    ['new', r.dau_new, r.dau_new_dod], ['retained', r.dau_retained, r.dau_retained_dod], ['resurrected', r.dau_resurrected, r.dau_resurrected_dod],
  ]);

  if (dv === 'REAL_DROP' || dv === 'SOFT_DROP') {
    const tone = dv === 'REAL_DROP' ? 'bad' : 'warn';
    const head = dv === 'REAL_DROP'
      ? `Paid DAU real drop (${dauPct}% vs 7dAvg, down on all 3 baselines).`
      : `Paid DAU soft dip (${dauPct}% vs 7dAvg) — not confirmed on DoD/SDLW, likely weekday noise.`;
    out.push({ tone, text: head });
    if (srcDrop) out.push({ tone, text: `Source where it dropped: ${srcDrop.label} fell ${fmtNum(Math.abs(srcDrop.delta))} DoD (${fmtNum(srcDrop.dod)}→${fmtNum(srcDrop.cur)}).` });
    if (cohortDrop) out.push({ tone, text: `Cohort driving it: ${cohortDrop.label}-since-payment lost ${fmtNum(Math.abs(cohortDrop.delta))} DoD (${fmtNum(cohortDrop.dod)}→${fmtNum(cohortDrop.cur)}) — points to that acquired set, not the whole base.` });
    if (utDrop) out.push({ tone, text: `User type: ${utDrop.label} users fell ${fmtNum(Math.abs(utDrop.delta))} DoD${utDrop.label === 'new' ? ' — irregular new-acquisition softness' : ''}.` });
    if (r.top_surface_drops) out.push({ tone: 'info', text: `Surfaces with the biggest fall: ${String(r.top_surface_drops).trim()}.` });
    if (r.peak_drop_hour) out.push({ tone: 'info', text: `Worst hour vs 7dAvg: ${String(r.peak_drop_hour).trim()}.` });
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

// One dimension's split as a row of cells: each shows current value + DoD delta.
function SplitRow({ title, cells }) {
  const present = cells.filter((c) => num(c.cur) != null);
  if (!present.length) return null;
  return (
    <div className="mb-2">
      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">{title}</div>
      <div className="flex flex-wrap gap-2">
        {present.map((c) => {
          const cur = num(c.cur), dod = num(c.dod);
          const delta = cur != null && dod != null ? cur - dod : null;
          const color = delta == null || delta === 0 ? '#64748b' : delta < 0 ? '#dc2626' : '#16a34a';
          return (
            <div key={c.label} className="border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50/60 min-w-[92px]">
              <div className="text-[11px] text-slate-500">{c.label}</div>
              <div className="text-sm font-semibold text-slate-800">{fmtNum(cur)}</div>
              {delta != null && (
                <div className="text-[11px]" style={{ color }}>{delta > 0 ? '+' : ''}{fmtNum(delta)} DoD</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DauDrillDown({ r }) {
  const has = num(r.dau_organic) != null || num(r.dau_new) != null || num(r.dau_d0) != null;
  if (!has) return null;
  return (
    <div className="mb-3 border-t border-slate-100 pt-3">
      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Paid DAU drill-down (vs prior day)</div>
      <SplitRow title="By source" cells={[
        { label: 'Organic', cur: r.dau_organic, dod: r.dau_organic_dod },
        { label: 'Push', cur: r.dau_push, dod: r.dau_push_dod },
        { label: 'MoEngage', cur: r.dau_moe, dod: r.dau_moe_dod },
        { label: 'WhatsApp', cur: r.dau_whatsapp, dod: r.dau_whatsapp_dod },
      ]} />
      <SplitRow title="By user type" cells={[
        { label: 'New', cur: r.dau_new, dod: r.dau_new_dod },
        { label: 'Retained', cur: r.dau_retained, dod: r.dau_retained_dod },
        { label: 'Resurrected', cur: r.dau_resurrected, dod: r.dau_resurrected_dod },
      ]} />
      <SplitRow title="By cohort (days since payment)" cells={[
        { label: 'D0', cur: r.dau_d0, dod: r.dau_d0_dod },
        { label: 'D1-D3', cur: r.dau_d1_d3, dod: r.dau_d1_d3_dod },
        { label: 'D4-D7', cur: r.dau_d4_d7, dod: r.dau_d4_d7_dod },
        { label: 'D8-D14', cur: r.dau_d8_d14, dod: r.dau_d8_d14_dod },
        { label: 'D15-D30', cur: r.dau_d15_d30, dod: r.dau_d15_d30_dod },
        { label: 'D30+', cur: r.dau_d30_plus, dod: r.dau_d30_plus_dod },
      ]} />
      {(r.top_surface_drops || r.peak_drop_hour) && (
        <div className="text-xs text-slate-500 mt-1 space-y-0.5">
          {r.top_surface_drops && <div><b>Surfaces down most:</b> {String(r.top_surface_drops).trim()}</div>}
          {r.peak_drop_hour && <div><b>Worst hour:</b> {String(r.peak_drop_hour).trim()}</div>}
        </div>
      )}
    </div>
  );
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
  const crD4 = num(r.cr_d4), crD4N = num(r.cr_d4_n);   // single-day success rate, D-4 (settled)
  const crD2 = num(r.cr_d2), crD2N = num(r.cr_d2_n);   // single-day success rate, D-2 (HDC day, live)

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
          label="Success rate (D-10→D-4 avg)"
          big={sr != null ? `${sr}%` : '—'}
          sub={<>D-4 success {crD4 != null ? `${crD4}%` : '—'}{crD4N != null ? ` (${crD4N} videos)` : ''}</>}
        />
        <Metric
          label="Success rate (D-2, HDC day)"
          big={crD2 != null ? `${crD2}%` : '—'}
          sub={<>{crD2N != null ? `${crD2N} videos · ` : ''}live 24h gate, not frozen</>}
        />
      </div>

      <DauDrillDown r={r} />

      {r.auto_rca && (
        <div className="text-sm text-slate-600 border-t border-slate-100 pt-2 whitespace-pre-wrap">{r.auto_rca}</div>
      )}
    </div>
  );
}

const isSettled = (v) => v === true || String(v).toLowerCase() === 'true';

export default function RcaTab() {
  const rcaRows = useStore((s) => s.rcaRows);
  const dates = useMemo(
    () => [...new Set((rcaRows || []).map((r) => r.report_date).filter(Boolean))].sort().reverse(),
    [rcaRows]
  );
  // A date's HDC is settled once its CR gate has frozen (~72h). The newest 1–3 days
  // are still settling, so HDC reads ~0 there — default to the latest SETTLED date.
  const settledDates = useMemo(() => {
    const ok = new Set();
    (rcaRows || []).forEach((r) => { if (isSettled(r.hdc_is_settled)) ok.add(r.report_date); });
    return ok;
  }, [rcaRows]);
  const [date, setDate] = useState('');
  const defaultDate = dates.find((d) => settledDates.has(d)) || dates[0] || '';
  const activeDate = date || defaultDate;

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
  const activeSettled = settledDates.has(activeDate);
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
            {dates.map((d) => (
              <option key={d} value={d}>{d}{settledDates.has(d) ? '' : ' (HDC still settling)'}</option>
            ))}
          </select>
        </label>
      </div>

      {!activeSettled && (
        <div className="banner banner-amber mb-4" style={{ display: 'block' }}>
          <span className="text-sm">
            HDC for <b>{activeDate}</b> hasn’t settled yet — it needs the full 24h view+completion window to close (≈ D-2), so HDC counts read near zero on the latest day(s). Pick an earlier date for settled HDC.
          </span>
        </div>
      )}

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

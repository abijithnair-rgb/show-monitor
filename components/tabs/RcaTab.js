'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { num, fmtNum, LANG_NAMES } from '@/lib/format';

// Segment groups in display order (the daily TOTAL/LANGUAGE/BU rows).
const GROUPS = [
  { title: 'Overall', match: (r) => r.level === 'TOTAL' },
  { title: 'Hindi — overall', match: (r) => r.level === 'LANGUAGE' && r.segment === 'hi' },
  { title: 'Hindi — by BU', match: (r) => r.level === 'BU', order: ['Awareness', 'Income', 'Skill'] },
  { title: 'Regional languages', match: (r) => r.level === 'LANGUAGE' && r.segment !== 'hi', order: ['te', 'ta', 'ml', 'kn'] },
];

const segLabel = (r) => (r.segment === 'overall_httmk' ? 'All languages (hi+ta+te+ml+kn)' : LANG_NAMES[r.segment] || r.segment);
const FINDING_DOT = { bad: '#dc2626', good: '#16a34a', warn: '#d97706', info: '#64748b' };
const LABEL_COLORS = { L0: '#16a34a', L1: '#d97706', L2: '#2563eb', L3: '#4f46e5', L4: '#64748b', L5: '#dc2626' };

function verdictChip(v) {
  const s = String(v || '').toUpperCase();
  let cls = 'chip-grey', txt = v || '—';
  if (/_DROP$|POOR|HIGH_/.test(s)) cls = 'chip-red';
  else if (/_RISE$/.test(s)) cls = 'chip-green';
  else if (s === 'NORMAL' || s === 'OK') cls = 'chip-grey';
  else if (/SETTL|TRACK|BASELINE|NO_/.test(s)) cls = 'chip-light';
  return <span className={'chip ' + cls}>{String(txt).replace(/_/g, ' ').toLowerCase()}</span>;
}

function patternTone(p) {
  const s = String(p || '');
  if (/CONTENT-LED DECLINE|DIVERGENCE/.test(s)) return 'banner-red';
  if (/LEADING RISK/.test(s)) return 'banner-amber';
  if (/LIFTING DAU|FRESH HITS/.test(s)) return 'banner-yellow';
  if (/NOT CONTENT/.test(s)) return 'banner-yellow';
  return 'banner-yellow';
}

function Delta({ value, suffix = '', invert = false }) {
  const v = num(value);
  if (v == null) return <span className="hint">—</span>;
  const up = v > 0;
  const good = invert ? !up : up;
  const color = v === 0 ? '#64748b' : good ? '#16a34a' : '#dc2626';
  return <span style={{ color, fontWeight: 600 }}>{up ? '+' : ''}{v}{suffix}</span>;
}

// ---------------------------------------------------------------------------
// Root-cause findings (v2 label-led). Keeps HDC / DAU / SR, now driven by labels.
// ---------------------------------------------------------------------------
function rcaFindings(r) {
  const out = [];
  const n = (x) => num(x);
  const l0 = n(r.l0) ?? n(r.hdc_count);
  const l0_7 = n(r.hdc_count_7davg);
  const supply = n(r.supply);
  const l0pct = n(r.hdc_rate) ?? n(r.l0_pct);
  const l4l5pct = n(r.l4l5_pct);
  const hdcContrib7 = n(r.hdc_contribution_pct_7d);
  const l4l5pct7 = n(r.l4l5_pct_7d);
  const sr = n(r.sr_pct), sr7 = n(r.sr_7davg);
  const hv = String(r.hdc_verdict || '').toUpperCase();

  // DAU drivers (columns unchanged from v1)
  const totalDrop = n(r.dau) != null && n(r.dau_dod) != null ? n(r.dau_dod) - n(r.dau) : null;
  const share = (x) => (totalDrop && totalDrop > 0 ? ` (${Math.round((Math.abs(x) / totalDrop) * 100)}% of the fall)` : '');
  const biggestDrop = (defs) => {
    let best = null;
    defs.forEach(([label, cur, dod]) => {
      const c = n(cur), d = n(dod);
      if (c == null || d == null) return;
      const delta = c - d;
      if (delta < 0 && (!best || delta < best.delta)) best = { label, delta, cur: c, dod: d };
    });
    return best;
  };
  const worstCohortPct = (defs) => {
    let best = null;
    defs.forEach(([label, cur, dod]) => {
      const c = n(cur), d = n(dod);
      if (c == null || d == null || d < 500) return;
      const pct = ((c - d) / d) * 100;
      if (pct < -3 && (!best || pct < best.pct)) best = { label, pct: Math.round(pct * 10) / 10, cur: c, dod: d };
    });
    return best;
  };
  const srcDrop = biggestDrop([
    ['organic', r.dau_organic, r.dau_organic_dod], ['push', r.dau_push, r.dau_push_dod],
    ['MoEngage', r.dau_moe, r.dau_moe_dod], ['WhatsApp', r.dau_whatsapp, r.dau_whatsapp_dod],
  ]);
  const worstCohort = worstCohortPct([
    ['D0', r.dau_d0, r.dau_d0_dod], ['D1-D3', r.dau_d1_d3, r.dau_d1_d3_dod], ['D4-D7', r.dau_d4_d7, r.dau_d4_d7_dod],
    ['D8-D14', r.dau_d8_d14, r.dau_d8_d14_dod], ['D15-D30', r.dau_d15_d30, r.dau_d15_d30_dod], ['D30+', r.dau_d30_plus, r.dau_d30_plus_dod],
  ]);

  // --- HDC (label-led) ---
  if (hv === 'HDC_DROP') {
    const pp = l0_7 != null && l0 != null ? l0 - l0_7 : null;
    out.push({ tone: 'bad', text: `HDC (L0) dropped: ${l0 ?? '—'} hits vs 7-day avg ${l0_7 ?? '—'}${pp != null ? ` (${pp > 0 ? '+' : ''}${Math.round(pp * 10) / 10})` : ''}; today's L0 ${l0pct ?? '—'}% of ${supply ?? '—'} launches.` });
    if (r.hdc_attribution) out.push({ tone: 'bad', text: `Root cause: ${String(r.hdc_attribution).replace(/^HDC down /, '')}.` });
    out.push({ tone: 'bad', text: `Label split L0/L1/L2/L3/L4/L5 = ${n(r.l0) ?? 0}/${n(r.l1) ?? 0}/${n(r.l2) ?? 0}/${n(r.l3) ?? 0}/${n(r.l4) ?? 0}/${n(r.l5) ?? 0}. L4+L5 (low-view tail) is ${l4l5pct ?? '—'}% of supply.` });
  } else if (hv === 'HDC_RISE') {
    out.push({ tone: 'good', text: `HDC (L0) rose: ${l0 ?? '—'} hits vs 7-day avg ${l0_7 ?? '—'} (L0 ${l0pct ?? '—'}% of ${supply ?? '—'}).` });
  } else if (l0 != null) {
    out.push({ tone: 'info', text: `HDC steady: ${l0} L0 of ${supply ?? '—'} (${l0pct ?? '—'}%). Label tail L4+L5 ${l4l5pct ?? '—'}%.` });
  }
  if (hdcContrib7 != null) {
    out.push({ tone: 'info', text: `7-day HDC contribution: ${hdcContrib7}% of supply was L0 (${n(r.hdc_7d) ?? '—'}/${n(r.supply_7d_seg) ?? '—'}); L4+L5 over 7d = ${l4l5pct7 ?? '—'}%.` });
  }

  // --- Success rate ---
  if (sr != null) {
    const d = sr7 != null ? Math.round((sr - sr7) * 10) / 10 : null;
    if (sr < 50) out.push({ tone: 'bad', text: `Success rate ${sr}% over the settled D-10→D-4 cohort${sr7 != null ? ` (prev 7d ${sr7}%, ${d}pp)` : ''} — under half of launches clear their completion target.` });
    else if (sr >= 75) out.push({ tone: 'good', text: `Success rate strong at ${sr}% over the settled D-10→D-4 cohort${sr7 != null ? ` (prev 7d ${sr7}%)` : ''}.` });
    else out.push({ tone: 'info', text: `Success rate ${sr}% (D-10→D-4 settled cohort${sr7 != null ? `, prev 7d ${sr7}%` : ''}).` });
  }

  // --- Paid DAU ---
  const dv = String(r.dau_verdict || '').toUpperCase();
  const dauPct = n(r.dau_7davg_pct);
  if (dv === 'REAL_DROP' || dv === 'SOFT_DROP') {
    const tone = dv === 'REAL_DROP' ? 'bad' : 'warn';
    out.push({ tone, text: dv === 'REAL_DROP'
      ? `Paid DAU fell ${dauPct}% vs 7dAvg${totalDrop ? `, ${fmtNum(totalDrop)} fewer users than yesterday` : ''} (down on all 3 baselines — a real drop).`
      : `Paid DAU dipped ${dauPct}% vs 7dAvg but held on DoD/SDLW — likely weekday noise.` });
    if (srcDrop) out.push({ tone, text: `From ${srcDrop.label}: ${fmtNum(srcDrop.dod)}→${fmtNum(srcDrop.cur)}, ${fmtNum(Math.abs(srcDrop.delta))} fewer${share(srcDrop.delta)}${(srcDrop.label === 'push' || srcDrop.label === 'MoEngage') ? ' — a notification-delivery gap' : srcDrop.label === 'organic' ? ' — fewer returning on their own' : ''}.` });
    if (worstCohort) out.push({ tone, text: `Concentrated in the ${worstCohort.label} post-payment cohort: ${fmtNum(worstCohort.dod)}→${fmtNum(worstCohort.cur)} (${worstCohort.pct}% DoD)${['D0', 'D1-D3', 'D4-D7'].includes(worstCohort.label) ? ' — a freshly-acquired set' : ' — tenured users'}.` });
    if (r.top_surface_drops) out.push({ tone: 'info', text: `Surfaces down most: ${String(r.top_surface_drops).trim()}.` });
  } else if (dv === 'REAL_RISE') {
    out.push({ tone: 'good', text: `Paid DAU rose ${dauPct}% vs 7dAvg on all 3 baselines.` });
  }

  if (!out.length) out.push({ tone: 'good', text: 'No anomalies — HDC, labels, success rate and paid DAU all within normal range.' });
  return out;
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

// L0–L5 label split strip (counts + share of supply).
function LabelSplit({ r }) {
  const supply = num(r.supply);
  const cells = [
    ['L0', num(r.l0), 'HDC'], ['L1', num(r.l1), 'view✓ CR✗'], ['L2', num(r.l2), 'CR✓ scale'],
    ['L3', num(r.l3), '>median'], ['L4', num(r.l4), 'p25–p50'], ['L5', num(r.l5), '<p25'],
  ];
  if (!cells.some((c) => c[1] != null)) return null;
  return (
    <div className="mb-3">
      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Label split (settled day · {supply != null ? fmtNum(supply) : '—'} launches)</div>
      <div className="grid grid-cols-6 gap-2">
        {cells.map(([lbl, v, desc]) => {
          const pct = supply && v != null ? Math.round((v / supply) * 1000) / 10 : null;
          return (
            <div key={lbl} className="border border-slate-200 rounded-lg px-2 py-1.5 text-center">
              <div className="text-xs font-semibold" style={{ color: LABEL_COLORS[lbl] }}>{lbl}</div>
              <div className="text-sm font-semibold text-slate-800">{v != null ? v : '—'}</div>
              <div className="hint">{pct != null ? `${pct}%` : desc}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RcaCard({ r }) {
  const l0pct = num(r.hdc_rate) ?? num(r.l0_pct);
  const l0 = num(r.l0) ?? num(r.hdc_count);
  const l0_7 = num(r.hdc_count_7davg);
  const supply = num(r.supply);
  const dau = num(r.dau);
  const sr = num(r.sr_pct);
  const sr7 = num(r.sr_7davg);
  const hdcContrib7 = num(r.hdc_contribution_pct_7d);
  const l4l5pct7 = num(r.l4l5_pct_7d);
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

      {/* HDC / label headline */}
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Metric label="HDC rate (L0%, D-2)" big={l0pct != null ? `${l0pct}%` : '—'} tone={hdcTone}
          sub={<>{l0 != null ? `${l0} L0` : '—'} of {supply != null ? fmtNum(supply) : '—'}{l0_7 != null ? ` · 7dAvg ${l0_7}` : ''}</>} />
        <Metric label="HDC contribution (7d)" big={hdcContrib7 != null ? `${hdcContrib7}%` : '—'}
          sub={<>{num(r.hdc_7d) != null ? `${num(r.hdc_7d)} L0 / ${num(r.supply_7d_seg) ?? '—'} supply` : 'trailing 7 days'}</>} />
        <Metric label="L4+L5 % of supply" big={l4l5pct7 != null ? `${l4l5pct7}%` : (num(r.l4l5_pct) != null ? `${num(r.l4l5_pct)}%` : '—')}
          tone={l4l5pct7 != null && l4l5pct7 > 55 ? '#dc2626' : '#0f172a'}
          sub="low-view tail (7d) · read deviation from ~50%" />
      </div>

      <LabelSplit r={r} />

      {/* Relation to DAU & SR */}
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Metric label="Paid DAU" big={dau != null ? fmtNum(dau) : '—'}
          sub={<>vs7dAvg <Delta value={num(r.dau_7davg_pct)} suffix="%" /> · {String(r.dau_verdict || '').replace(/_/g, ' ').toLowerCase()}</>} />
        <Metric label="Success rate (D-10→D-4)" big={sr != null ? `${sr}%` : '—'}
          sub={<>{sr7 != null ? `prev 7d ${sr7}% · ` : ''}<Delta value={sr != null && sr7 != null ? Math.round((sr - sr7) * 10) / 10 : null} suffix="pp" /></>} />
        <Metric label="Correlation HDC↔DAU" big={num(r.corr_hdc_dau) != null ? num(r.corr_hdc_dau) : '—'}
          sub={<>SR↔DAU {num(r.corr_sr_dau) ?? '—'} · HDC↔SR {num(r.corr_hdc_sr) ?? '—'}</>} />
      </div>

      {r.auto_rca && (
        <div className="text-sm text-slate-600 border-t border-slate-100 pt-2 whitespace-pre-wrap">{r.auto_rca}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SHOW triage (level='SHOW') — poor L0%, high L4/L5%, supply/frequency fixes.
// ---------------------------------------------------------------------------
function ShowRow({ s, kind }) {
  const l0pct = num(s.l0_pct), buL0 = num(s.bu_l0_pct);
  const l4l5 = num(s.l4l5_pct), buL45 = num(s.bu_l4l5_pct);
  const supply = num(s.show_supply_7d) ?? num(s.supply);
  const freq = num(s.show_freq), vsFreq = num(s.show_supply_vs_freq_pct);
  let metric = null;
  if (kind === 'poor_l0') metric = <>L0 <b style={{ color: '#dc2626' }}>{l0pct ?? '—'}%</b> vs BU {buL0 ?? '—'}%</>;
  else if (kind === 'high_l45') metric = <>L4+L5 <b style={{ color: '#dc2626' }}>{l4l5 ?? '—'}%</b> vs BU {buL45 ?? '—'}%</>;
  else metric = <>{supply ?? '—'}/{freq ?? '—'}/wk <b style={{ color: '#dc2626' }}>({vsFreq ?? '—'}% of target)</b></>;
  return (
    <div className="border-b border-slate-100 py-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="font-medium text-sm">{s.show_name || '—'}</div>
        <div className="flex items-center gap-2">
          <span className="chip chip-blue">{s.segment}</span>
          {s.show_manager && <span className="hint">{s.show_manager}</span>}
        </div>
      </div>
      <div className="text-xs text-slate-600 mt-0.5">{metric}{supply != null ? ` · ${supply} series/7d` : ''}</div>
      {s.show_recommendation && <div className="text-xs text-slate-500 mt-0.5">{s.show_recommendation}</div>}
    </div>
  );
}

function ShowTriage({ shows }) {
  const poor = shows.filter((s) => num(s.poor_l0_flag) === 1).sort((a, b) => (num(a.l0_pct) || 0) - (num(b.l0_pct) || 0));
  const high = shows.filter((s) => num(s.high_l45_flag) === 1).sort((a, b) => (num(b.l4l5_pct) || 0) - (num(a.l4l5_pct) || 0));
  const supply = shows.filter((s) => num(s.needs_supply_fix_flag) === 1).sort((a, b) => (num(a.show_supply_vs_freq_pct) || 0) - (num(b.show_supply_vs_freq_pct) || 0));
  if (!shows.length) return null;
  const Block = ({ title, desc, list, kind }) => (
    <div className="card p-4 mb-3">
      <div className="font-semibold mb-0.5">{title} <span className="hint">({list.length})</span></div>
      <div className="hint mb-2">{desc}</div>
      {list.length ? list.map((s) => <ShowRow key={`${kind}-${s.show_name}`} s={s} kind={kind} />)
        : <div className="text-sm text-slate-400">None this week. ✓</div>}
    </div>
  );
  return (
    <div className="mb-5">
      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">Hindi show triage — trailing 7 days</div>
      <Block title="Poor L0% shows" desc="Hit-rate well below their BU's pooled L0% — rework formats/hooks." list={poor} kind="poor_l0" />
      <Block title="High L4+L5% shows" desc="Heavy low-view tail vs BU — review topics / thumbnails / discovery." list={high} kind="high_l45" />
      <Block title="Frequency / supply gaps" desc="Publishing below their weekly frequency target — raise output." list={supply} kind="supply" />
    </div>
  );
}

const isSettled = (v) => v === true || String(v).toLowerCase() === 'true';

export default function RcaTab() {
  const rcaRows = useStore((s) => s.rcaRows);
  const dates = useMemo(
    () => [...new Set((rcaRows || []).filter((r) => r.level !== 'SHOW').map((r) => r.report_date).filter(Boolean))].sort().reverse(),
    [rcaRows]
  );
  const settledDates = useMemo(() => {
    const ok = new Set();
    // Only segment rows define settlement; SHOW rows are always anchored at the latest date.
    (rcaRows || []).forEach((r) => { if (r.level !== 'SHOW' && isSettled(r.label_is_settled)) ok.add(r.report_date); });
    return ok;
  }, [rcaRows]);
  const [date, setDate] = useState('');
  const defaultDate = dates.find((d) => settledDates.has(d)) || dates[0] || '';
  const activeDate = date || defaultDate;

  if (!rcaRows || !rcaRows.length) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">Daily RCA</h2>
        <p className="text-sm text-slate-500 mb-4">Morning content RCA — labels (L0–L6), HDC contribution, success rate and paid DAU, with the why.</p>
        <div className="card p-8 text-center text-slate-400">No RCA data loaded. It syncs automatically from Redash; or upload the Daily RCA CSV on the Data tab.</div>
      </div>
    );
  }

  const dayRows = rcaRows.filter((r) => r.level !== 'SHOW' && r.report_date === activeDate);
  // SHOW rows are anchored at the latest date; show them regardless of the picker.
  const showRows = rcaRows.filter((r) => r.level === 'SHOW');
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
          <p className="text-sm text-slate-500">Content health for <b>{activeDate}</b> — HDC (L0) & label split at D-2, success rate over D-10→D-4, paid DAU at D-1.</p>
        </div>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Report date
          <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={activeDate} onChange={(e) => setDate(e.target.value)}>
            {dates.map((d) => (<option key={d} value={d}>{d}{settledDates.has(d) ? '' : ' (settling)'}</option>))}
          </select>
        </label>
      </div>

      {GROUPS.map((g) => {
        const rows = ordered(g);
        if (!rows.length) return null;
        return (
          <div key={g.title} className="mb-5">
            <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">{g.title}</div>
            {rows.map((r) => <RcaCard key={`${r.level}-${r.segment}`} r={r} />)}
          </div>
        );
      })}

      <ShowTriage shows={showRows} />
    </div>
  );
}

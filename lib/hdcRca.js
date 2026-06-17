// Hindi day-over-day HDC RCA — pure aggregation helpers (no React, no DOM), so
// they're unit-testable. Input = per-series detail rows (level='HDC_SERIES'),
// already filtered to Hindi by the query. Each row:
//   { publish_date, bu, manager, show, series, views, p90, threshold,
//     targetCr, achievedCr, viewPass, crPass, L0, firstL0 }
import { num } from './format';

const BU_ORDER = ['Income', 'Skill', 'Awareness'];

const avg = (arr) => {
  const v = arr.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const pct = (n, d) => (d ? (n / d) * 100 : null);

// Normalise a raw HDC_SERIES row into the shape the sections use.
export function normalizeSeriesRow(r) {
  return {
    publish_date: String(r.hdc_report_date || r.publish_date || '').slice(0, 10),
    bu: r.segment || r.bu || 'Other',
    manager: r.show_manager || r.manager || 'Unassigned',
    show: r.show_name || r.show || '—',
    series: r.hdc_series_title || r.series || '—',
    views: num(r.hdc_views_24h ?? r.views),
    p90: num(r.hdc_p90 ?? r.p90),
    threshold: num(r.hdc_threshold_value ?? r.threshold),
    targetCr: num(r.hdc_target_cr ?? r.targetCr),
    achievedCr: num(r.hdc_achieved_cr ?? r.achievedCr),
    viewPass: num(r.hdc_view_pass ?? r.viewPass) === 1 ? 1 : 0,
    crPass: num(r.hdc_cr_pass ?? r.crPass) === 1 ? 1 : 0,
    L0: num(r.l0 ?? r.L0) === 1 ? 1 : 0,
    firstL0: String(r.hdc_first_l0_date || r.firstL0 || '').slice(0, 10) || null,
  };
}

// Distinct publish_dates present, newest first.
export function seriesDates(rows) {
  return [...new Set(rows.map((r) => r.publish_date).filter(Boolean))].sort().reverse();
}

// §1 — day-level headline numbers for one day's rows.
export function headline(rows) {
  const n = rows.length;
  const l0 = rows.reduce((a, r) => a + r.L0, 0);
  const viewPass = rows.reduce((a, r) => a + r.viewPass, 0);
  const crPass = rows.reduce((a, r) => a + r.crPass, 0);
  // the per-day view threshold is one value/day (LEAST(p90,1500)) — take the max seen.
  const thr = rows.reduce((m, r) => (r.threshold != null && (m == null || r.threshold > m) ? r.threshold : m), null);
  return {
    total: n,
    l0,
    hdcPct: r1(pct(l0, n)),
    viewPassPct: r1(pct(viewPass, n)),
    crPassPct: r1(pct(crPass, n)),
    p90Threshold: thr == null ? null : Math.round(thr),
    avgViews: rows.length ? Math.round(avg(rows.map((r) => r.views)) ?? 0) : null,
    avgCr: r2(avg(rows.map((r) => r.achievedCr))),
  };
}

// §2 — key deltas (day_b vs day_a). Returns metric rows + a threshold-moved flag.
const METRICS = [
  ['Total series', 'total', '', 0],
  ['L0 count', 'l0', '', 0],
  ['HDC %', 'hdcPct', '%', 1],
  ['View pass %', 'viewPassPct', '%', 1],
  ['CR pass %', 'crPassPct', '%', 1],
  ['p90 view threshold', 'p90Threshold', '', 0],
  ['Avg views', 'avgViews', '', 0],
  ['Avg CR', 'avgCr', '%', 2],
];
export function deltas(hA, hB) {
  const rows = METRICS.map(([label, key, unit, dp]) => {
    const a = hA[key], b = hB[key];
    const abs = a != null && b != null ? b - a : null;
    const pc = a ? (abs / a) * 100 : null;
    const dir = abs == null ? 'FLAT' : abs > 0 ? 'UP' : abs < 0 ? 'DOWN' : 'FLAT';
    const round = (x) => (x == null ? null : (dp ? Math.round(x * 10 ** dp) / 10 ** dp : Math.round(x)));
    return { label, key, unit, a, b, abs: round(abs), pctDelta: r1(pc), dir };
  });
  // "rising threshold that still yields more L0" = stronger signal.
  const thrUp = hB.p90Threshold != null && hA.p90Threshold != null && hB.p90Threshold > hA.p90Threshold;
  const l0Up = hB.l0 > hA.l0;
  return {
    rows,
    thresholdMoved: hA.p90Threshold !== hB.p90Threshold,
    thresholdDir: hB.p90Threshold > hA.p90Threshold ? 'UP' : hB.p90Threshold < hA.p90Threshold ? 'DOWN' : 'FLAT',
    strongerSignal: thrUp && l0Up,
  };
}

// Group rollup (used by §3 BU and §4 manager): L0 count + view pass% per group, both days + net Δ.
function rollup(rowsA, rowsB, keyFn, order) {
  const keys = new Set([...rowsA.map(keyFn), ...rowsB.map(keyFn)]);
  const sub = (rows, k) => rows.filter((r) => keyFn(r) === k);
  const out = [...keys].map((k) => {
    const a = sub(rowsA, k), b = sub(rowsB, k);
    const l0a = a.reduce((s, r) => s + r.L0, 0), l0b = b.reduce((s, r) => s + r.L0, 0);
    return {
      key: k,
      l0_a: l0a, l0_b: l0b, l0_delta: l0b - l0a,
      viewPassPct_a: r1(pct(a.reduce((s, r) => s + r.viewPass, 0), a.length)),
      viewPassPct_b: r1(pct(b.reduce((s, r) => s + r.viewPass, 0), b.length)),
      n_a: a.length, n_b: b.length,
    };
  });
  if (order) out.sort((x, y) => {
    const ix = order.indexOf(x.key), iy = order.indexOf(y.key);
    if (ix !== -1 || iy !== -1) return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
    return y.l0_delta - x.l0_delta;
  });
  else out.sort((x, y) => y.l0_delta - x.l0_delta);
  // mark the biggest absolute mover
  let driver = null;
  out.forEach((g) => { if (driver == null || Math.abs(g.l0_delta) > Math.abs(driver.l0_delta)) driver = g; });
  return { rows: out, driverKey: driver && driver.l0_delta !== 0 ? driver.key : null };
}

export const buBreakdown = (rowsA, rowsB) => rollup(rowsA, rowsB, (r) => r.bu, BU_ORDER);
export const managerBreakdown = (rowsA, rowsB) => rollup(rowsA, rowsB, (r) => r.manager, null);

// §5 — L0 series list for one day, with the "new" flag (first L0 in window === this day).
export function l0List(rows, day) {
  return rows
    .filter((r) => r.L0 === 1)
    .map((r) => ({
      series: r.series, show: r.show, manager: r.manager, bu: r.bu,
      views: r.views, achievedCr: r.achievedCr, targetCr: r.targetCr,
      isNew: r.firstL0 != null && r.firstL0 === day,
    }))
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
}

// §6 — root-cause verdict (3–4 sentences) synthesised from §1–§5.
export function verdict({ hA, hB, dlt, bu, mgr, listA, listB }) {
  const l0Delta = hB.l0 - hA.l0;
  if (l0Delta === 0) {
    return `HDC L0 was flat at ${hB.l0} across both days. View pass% ${hA.viewPassPct ?? '—'}%→${hB.viewPassPct ?? '—'}% and CR pass% ${hA.crPassPct ?? '—'}%→${hB.crPassPct ?? '—'}% — no material swing to attribute.`;
  }
  const dir = l0Delta > 0 ? 'improved' : 'declined';
  // attribution: which lever moved most (view pass vs CR pass vs supply)
  const vpΔ = (hB.viewPassPct ?? 0) - (hA.viewPassPct ?? 0);
  const crΔ = (hB.crPassPct ?? 0) - (hA.crPassPct ?? 0);
  const supΔ = hB.total - hA.total;
  let lever;
  if (Math.abs(vpΔ) >= Math.abs(crΔ) && Math.abs(vpΔ) >= 2) lever = `a ${vpΔ > 0 ? 'rise' : 'fall'} in view pass rate (${r1(hA.viewPassPct)}%→${r1(hB.viewPassPct)}%)`;
  else if (Math.abs(crΔ) >= 2) lever = `a ${crΔ > 0 ? 'rise' : 'fall'} in CR pass rate (${r1(hA.crPassPct)}%→${r1(hB.crPassPct)}%)`;
  else if (Math.abs(supΔ) >= 2) lever = `the supply mix (${hA.total}→${hB.total} series launched)`;
  else lever = 'a mix of small shifts in view- and CR-pass rates';

  const newCount = listB.filter((x) => x.isNew).length;
  const newBit = l0Delta > 0 && newCount > 0
    ? ` ${newCount} of the day-${'B'} L0s ${newCount === 1 ? 'was a' : 'were'} first-time conversion${newCount === 1 ? '' : 's'} in the window.`
    : '';
  const thrBit = dlt.thresholdMoved
    ? ` The p90 view threshold ${dlt.thresholdDir === 'UP' ? 'rose' : 'fell'} (${hA.p90Threshold}→${hB.p90Threshold})${dlt.strongerSignal ? ' yet L0 still rose — a genuinely stronger signal' : ''}.`
    : ' The p90 view threshold was unchanged.';
  const driverBits = [];
  if (bu.driverKey) driverBits.push(`${bu.driverKey} (BU)`);
  if (mgr.driverKey) driverBits.push(`${mgr.driverKey} (manager)`);
  const driverBit = driverBits.length ? ` Primary driver: ${driverBits.join(' / ')}.` : '';

  return `HDC L0 ${dir} ${hA.l0}→${hB.l0} (${l0Delta > 0 ? '+' : ''}${l0Delta}), driven mainly by ${lever}.${thrBit}${newBit}${driverBit}`;
}

// Top-level: build everything for a chosen pair of days.
export function buildHdcRca(allRows, dayA, dayB) {
  const rows = (allRows || []).map(normalizeSeriesRow);
  const rowsA = rows.filter((r) => r.publish_date === dayA);
  const rowsB = rows.filter((r) => r.publish_date === dayB);
  const hA = headline(rowsA), hB = headline(rowsB);
  const dlt = deltas(hA, hB);
  const bu = buBreakdown(rowsA, rowsB);
  const mgr = managerBreakdown(rowsA, rowsB);
  const listA = l0List(rowsA, dayA), listB = l0List(rowsB, dayB);
  const v = verdict({ hA, hB, dlt, bu, mgr, listA, listB });
  return { hA, hB, dlt, bu, mgr, listA, listB, verdict: v, nA: rowsA.length, nB: rowsB.length };
}

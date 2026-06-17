// Hindi day-over-day HDC RCA — pure aggregation helpers (no React, no DOM), so
// they're unit-testable. Input = per-series detail rows (level='HDC_SERIES'),
// already filtered to Hindi by the query. Each row:
//   { publish_date, bu, manager, show, series, views, p90, threshold,
//     targetCr, achievedCr, viewPass, crPass, L0, firstL0 }
//
// Orientation: we are AT the current day (D-2) and compare it to the prior day
// (D-3). All deltas read current − prior (D-2 vs D-3).
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

// §2 — key deltas (current vs prior). Returns metric rows + a threshold-moved flag.
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
export function deltas(hPrior, hCurrent) {
  const rows = METRICS.map(([label, key, unit, dp]) => {
    const p = hPrior[key], c = hCurrent[key];
    const abs = p != null && c != null ? c - p : null;
    const pc = p ? (abs / p) * 100 : null;
    const dir = abs == null ? 'FLAT' : abs > 0 ? 'UP' : abs < 0 ? 'DOWN' : 'FLAT';
    const round = (x) => (x == null ? null : (dp ? Math.round(x * 10 ** dp) / 10 ** dp : Math.round(x)));
    return { label, key, unit, prior: p, current: c, abs: round(abs), pctDelta: r1(pc), dir };
  });
  // "rising threshold that still yields more L0" = stronger signal.
  const thrUp = hCurrent.p90Threshold != null && hPrior.p90Threshold != null && hCurrent.p90Threshold > hPrior.p90Threshold;
  const l0Up = hCurrent.l0 > hPrior.l0;
  return {
    rows,
    thresholdMoved: hPrior.p90Threshold !== hCurrent.p90Threshold,
    thresholdDir: hCurrent.p90Threshold > hPrior.p90Threshold ? 'UP' : hCurrent.p90Threshold < hPrior.p90Threshold ? 'DOWN' : 'FLAT',
    strongerSignal: thrUp && l0Up,
  };
}

// Group rollup (used by §3 BU and §4 manager): L0 count + view pass% per group,
// prior + current + net Δ (current − prior).
function rollup(rowsPrior, rowsCurrent, keyFn, order) {
  const keys = new Set([...rowsPrior.map(keyFn), ...rowsCurrent.map(keyFn)]);
  const sub = (rows, k) => rows.filter((r) => keyFn(r) === k);
  const out = [...keys].map((k) => {
    const p = sub(rowsPrior, k), c = sub(rowsCurrent, k);
    const l0p = p.reduce((s, r) => s + r.L0, 0), l0c = c.reduce((s, r) => s + r.L0, 0);
    return {
      key: k,
      l0_prior: l0p, l0_current: l0c, l0_delta: l0c - l0p,
      viewPassPct_prior: r1(pct(p.reduce((s, r) => s + r.viewPass, 0), p.length)),
      viewPassPct_current: r1(pct(c.reduce((s, r) => s + r.viewPass, 0), c.length)),
      n_prior: p.length, n_current: c.length,
    };
  });
  if (order) out.sort((x, y) => {
    const ix = order.indexOf(x.key), iy = order.indexOf(y.key);
    if (ix !== -1 || iy !== -1) return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
    return y.l0_delta - x.l0_delta;
  });
  else out.sort((x, y) => y.l0_delta - x.l0_delta);
  let driver = null;
  out.forEach((g) => { if (driver == null || Math.abs(g.l0_delta) > Math.abs(driver.l0_delta)) driver = g; });
  return { rows: out, driverKey: driver && driver.l0_delta !== 0 ? driver.key : null };
}

export const buBreakdown = (rowsPrior, rowsCurrent) => rollup(rowsPrior, rowsCurrent, (r) => r.bu, BU_ORDER);
export const managerBreakdown = (rowsPrior, rowsCurrent) => rollup(rowsPrior, rowsCurrent, (r) => r.manager, null);

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

// §6 — executive RCA report: a short, structured set of lines (tldr → math →
// attribution → drivers → new conversions → watch-outs). Reads current vs prior.
export function execReport({ hPrior, hCurrent, dlt, bu, mgr, listCurrent, dPrior, dCurrent }) {
  const out = [];
  const l0Δ = hCurrent.l0 - hPrior.l0;
  const dir = l0Δ > 0 ? 'rose' : l0Δ < 0 ? 'fell' : 'held flat';
  const tone = l0Δ > 0 ? 'good' : l0Δ < 0 ? 'bad' : 'info';

  // TL;DR
  out.push({ kind: 'tldr', tone, text:
    `HDC L0 ${dir} ${hPrior.l0}→${hCurrent.l0} (${l0Δ > 0 ? '+' : ''}${l0Δ}) on D-2 (${dCurrent}) vs D-3 (${dPrior}). HDC rate ${hPrior.hdcPct ?? '—'}%→${hCurrent.hdcPct ?? '—'}% of ${hCurrent.total} launches.` });

  // Key math
  const chg = (a, b) => (a != null && b != null ? `${b > a ? '+' : ''}${r1(b - a)}` : '—');
  out.push({ kind: 'math', tone: 'info', text:
    `Key math — view pass ${hPrior.viewPassPct ?? '—'}%→${hCurrent.viewPassPct ?? '—'}% (${chg(hPrior.viewPassPct, hCurrent.viewPassPct)}pp) · CR pass ${hPrior.crPassPct ?? '—'}%→${hCurrent.crPassPct ?? '—'}% (${chg(hPrior.crPassPct, hCurrent.crPassPct)}pp) · supply ${hPrior.total}→${hCurrent.total} · avg views ${hPrior.avgViews ?? '—'}→${hCurrent.avgViews ?? '—'} · avg CR ${hPrior.avgCr ?? '—'}%→${hCurrent.avgCr ?? '—'}%.` });

  // Attribution. An L0 hit needs BOTH the view threshold AND the CR target, so
  // L0 can only move via: view-pass rate, CR-pass rate, or supply (volume). The
  // DRIVER must move in the SAME direction as L0; a lever moving the other way is
  // a counter-current (a drag on a rise, a cushion on a fall) — surfacing it is
  // the real insight (e.g. "L0 rose even though completion fell").
  if (l0Δ !== 0) {
    const sign = l0Δ > 0 ? 1 : -1;
    const levers = [
      { label: 'view-pass rate', role: 'reach/discovery', from: hPrior.viewPassPct, to: hCurrent.viewPassPct, d: (hCurrent.viewPassPct ?? 0) - (hPrior.viewPassPct ?? 0), unit: 'pp', big: 2 },
      { label: 'CR-pass rate', role: 'completion/quality', from: hPrior.crPassPct, to: hCurrent.crPassPct, d: (hCurrent.crPassPct ?? 0) - (hPrior.crPassPct ?? 0), unit: 'pp', big: 2 },
      { label: 'supply', role: 'volume', from: hPrior.total, to: hCurrent.total, d: hCurrent.total - hPrior.total, unit: '', big: 2 },
    ];
    const fmtL = (l) => `${l.from ?? '—'}${l.unit === 'pp' ? '%' : ''}→${l.to ?? '—'}${l.unit === 'pp' ? '%' : ''} (${l.d > 0 ? '+' : ''}${r1(l.d)}${l.unit})`;
    const tail = levers.filter((l) => l.d * sign > 0 && Math.abs(l.d) >= l.big).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const head = levers.filter((l) => l.d * sign < 0 && Math.abs(l.d) >= l.big).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const verb = l0Δ > 0 ? 'rose' : 'fell';

    if (tail.length) {
      const d0 = tail[0];
      out.push({ kind: 'attr', tone, text:
        `Driven by ${d0.label} ${fmtL(d0)} — a ${d0.role} ${l0Δ > 0 ? 'gain' : 'loss'}${tail[1] ? `, helped by ${tail[1].label} ${fmtL(tail[1])}` : ''}.` });
      if (head.length) {
        const h0 = head[0];
        out.push({ kind: 'attr', tone: 'warn', text:
          `Counter-current: ${h0.label} moved the other way (${fmtL(h0)}) — ${l0Δ > 0 ? 'a drag the gain overcame' : 'a cushion that softened the fall'}. So L0 ${verb} on ${d0.role.split('/')[0]}, not ${h0.role.split('/')[0]}; ${l0Δ > 0 ? `watch ${h0.label} so it doesn't cap further upside` : `the ${h0.label} cushion may not hold`}.` });
      }
    } else if (head.length) {
      // No same-direction rate lever — L0 moved despite the rates (composition/supply).
      const h0 = head[0];
      out.push({ kind: 'attr', tone, text:
        `L0 ${verb} even though ${h0.label} moved against it (${fmtL(h0)}) — the move came from composition/which series cleared both bars rather than a headline rate shift.` });
    } else {
      out.push({ kind: 'attr', tone, text: `Driven by small shifts across view-pass, CR-pass and supply — no single dominant lever.` });
    }
  }

  // Threshold movement
  if (dlt.thresholdMoved) {
    out.push({ kind: 'thr', tone: dlt.strongerSignal ? 'good' : 'warn', text:
      `The p90 view threshold ${dlt.thresholdDir === 'UP' ? 'rose' : 'fell'} ${hPrior.p90Threshold}→${hCurrent.p90Threshold}${dlt.strongerSignal ? ' — yet L0 still rose, so this is a genuinely stronger signal, not an easier bar' : (l0Δ > 0 ? ' (a lower bar partly aided the L0 gain — read with caution)' : '')}.` });
  }

  // BU / manager contributors — the group that moved L0 MOST in the net direction
  // (a same-direction mover actually contributed; an opposite mover did not).
  if (l0Δ !== 0) {
    const sign = l0Δ > 0 ? 1 : -1;
    const contributor = (rows) => rows
      .filter((g) => g.l0_delta * sign > 0)
      .sort((a, b) => Math.abs(b.l0_delta) - Math.abs(a.l0_delta))[0] || null;
    const offsetter = (rows) => rows
      .filter((g) => g.l0_delta * sign < 0)
      .sort((a, b) => Math.abs(b.l0_delta) - Math.abs(a.l0_delta))[0] || null;
    const buC = contributor(bu.rows), mgrC = contributor(mgr.rows);
    const parts = [];
    if (buC) parts.push(`${buC.key} (BU, ${buC.l0_prior}→${buC.l0_current}, ${buC.l0_delta > 0 ? '+' : ''}${buC.l0_delta})`);
    if (mgrC) parts.push(`${mgrC.key} (manager, ${mgrC.l0_prior}→${mgrC.l0_current}, ${mgrC.l0_delta > 0 ? '+' : ''}${mgrC.l0_delta})`);
    if (parts.length) out.push({ kind: 'driver', tone, text: `Biggest contributor${parts.length > 1 ? 's' : ''}: ${parts.join(' · ')}.` });
    const buO = offsetter(bu.rows);
    if (buO) out.push({ kind: 'driver', tone: 'info', text: `Partly offset by ${buO.key} (BU, ${buO.l0_prior}→${buO.l0_current}, ${buO.l0_delta > 0 ? '+' : ''}${buO.l0_delta}) moving the other way.` });
  }

  // New conversions
  const news = listCurrent.filter((x) => x.isNew);
  if (news.length) {
    const names = news.slice(0, 3).map((x) => x.show).filter((v, i, a) => a.indexOf(v) === i);
    out.push({ kind: 'new', tone: 'good', text:
      `${news.length} of D-2's L0${news.length === 1 ? ' is a' : 's are'} first-time conversion${news.length === 1 ? '' : 's'} in the window${names.length ? ` (${names.join(', ')}${news.length > names.length ? '…' : ''})` : ''}.` });
  }

  return out;
}

// Top-level: build everything for a chosen current(D-2) / prior(D-3) pair.
export function buildHdcRca(allRows, dCurrent, dPrior) {
  const rows = (allRows || []).map(normalizeSeriesRow);
  const rowsPrior = rows.filter((r) => r.publish_date === dPrior);
  const rowsCurrent = rows.filter((r) => r.publish_date === dCurrent);
  const hPrior = headline(rowsPrior), hCurrent = headline(rowsCurrent);
  const dlt = deltas(hPrior, hCurrent);
  const bu = buBreakdown(rowsPrior, rowsCurrent);
  const mgr = managerBreakdown(rowsPrior, rowsCurrent);
  const listPrior = l0List(rowsPrior, dPrior), listCurrent = l0List(rowsCurrent, dCurrent);
  const report = execReport({ hPrior, hCurrent, dlt, bu, mgr, listCurrent, dPrior, dCurrent });
  return { hPrior, hCurrent, dlt, bu, mgr, listPrior, listCurrent, report, nPrior: rowsPrior.length, nCurrent: rowsCurrent.length };
}

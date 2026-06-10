// HDC index + diagnostics — ported verbatim, with hdcRows threaded in.
import { num, dStr, addDays, fmtDate, LANG_NAMES } from './format';
import { HDC_LANGS } from './constants';

// HDC reference "today" = the actual current date (matches the query's CURRENT_DATE end_date).
export function hdcRefToday() {
  return dStr(new Date());
}

// HDC index per show over the last 7 days = publish_date in [today-8, today-2] inclusive
// (today and yesterday excluded; "7 days till the 8th" when today is the 10th).
export function buildHdcIndex(hdcRows) {
  const idx = new Map();
  if (!hdcRows) return idx;
  const today = hdcRefToday();
  const upper = addDays(today, -2);
  const lower = addDays(today, -8);
  const byShow = new Map();
  hdcRows.forEach((r) => {
    const pd = String(r.publish_date || '').slice(0, 10);
    if (!pd || pd < lower || pd > upper) return;
    const k = String(r.show_id);
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(r);
  });
  byShow.forEach((rows, k) => {
    const supply = rows.length;
    const hdc = rows.filter((r) => num(r.HDC_threshold) === 1).length;
    const labels = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0 };
    rows.forEach((r) => {
      const L = String(r.Label || '').toUpperCase();
      if (L in labels) labels[L]++;
    });
    let sum = 0,
      n = 0;
    rows.forEach((r) => {
      const m = /^L([0-6])$/.exec(String(r.Label || '').toUpperCase());
      if (m) {
        sum += +m[1];
        n++;
      }
    });
    // most-common label (mode); tie-break toward WORSE (higher L) label.
    let modeLabel = null,
      modeCnt = -1;
    for (let i = 0; i <= 6; i++) {
      const L = 'L' + i,
        c = labels[L];
      if (c > 0 && c >= modeCnt) {
        modeCnt = c;
        modeLabel = L;
      }
    }
    idx.set(k, {
      rows,
      supply,
      hdc,
      hdcRatePct: supply ? Math.round((hdc / supply) * 1000) / 10 : null,
      labels,
      avgLevel: n ? sum / n : null,
      labelledCount: n,
      modeLabel,
      modeCnt,
    });
  });
  idx.window = { lower, upper };
  return idx;
}

// Why does a show have no HDC content in the window?
export function hdcDiagnose(show, hdcRows) {
  if (!hdcRows) return { code: 'noupload' };
  const id = String(show.id);
  const all = hdcRows.filter((r) => String(r.show_id) === id);
  const inWin = buildHdcIndex(hdcRows).get(id);
  if (inWin) return { code: 'ok' };
  if (!HDC_LANGS.has(show.language)) return { code: 'lang', lang: show.language };
  if (!all.length) return { code: 'none' };
  let max = '';
  all.forEach((r) => {
    const pd = String(r.publish_date || '').slice(0, 10);
    if (pd > max) max = pd;
  });
  return { code: 'stale', latest: max, count: all.length };
}

export function hdcNoContentMsg(show, hdcRows) {
  const d = hdcDiagnose(show, hdcRows);
  switch (d.code) {
    case 'noupload':
      return 'Upload the HDC CSV to see this.';
    case 'lang':
      return `HDC query does not cover ${LANG_NAMES[d.lang] || d.lang} — only Telugu/Tamil/Malayalam/Kannada.`;
    case 'none':
      return 'This show has no rows in the HDC CSV (no qualifying content, or show_id not present).';
    case 'stale':
      return `No content in the last-7-day window. Latest HDC content: ${fmtDate(d.latest)} (${d.count} row${d.count > 1 ? 's' : ''} total). Re-run the HDC query for fresh data.`;
    default:
      return 'No content for this show in the last-7-day window.';
  }
}

// buildDataset(data) — structured JSON payload for the chat bot's tool access.
// Instead of a frozen text snapshot, the bot gets (a) a flat per-show table with
// every dashboard metric (computed here so numbers match the UI exactly) and
// (b) the raw datasets, both queryable server-side via tools. Runs in the
// browser; POSTed to /api/chat. Cached 5 min by data signature.
import { buildModel, buildFatIndex, buildTimeSpentIndex } from './model';
import { buildHdcIndex } from './hdc';
import { successRate } from './metrics';
import { ACTION_META } from './constants';
import { num, LANG_NAMES } from './format';

let _cache = { sig: null, at: 0, payload: null };
const TTL = 5 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024; // ~8 MB payload guard

// friendly name -> raw store array
const RAW_MAP = [
  ['eval', 'evalRows', 'New Show Evaluation rows (lifecycle: peer-relative contribution, users, weekly trend).'],
  ['fatigue', 'fatRows', 'Content Fatigue Monitor episode rows (per-video success flag, failure modes, returns).'],
  ['hdc', 'hdcRows', 'HDC episode rows (publish_date, Label L0–L6, HDC_threshold) — high-demand-content labelling.'],
  ['rca', 'rcaRows', 'Daily RCA rows (segment/show level: DAU & HDC & SR movements, drivers, triage).'],
  ['timespent', 'tsRows', 'Time-spent rows (watch hours, avg minutes/play, video plays) per show.'],
  ['langsr', 'langsrRows', 'Per-show success-rate dataset (trailing-7d settled: successful/failed counts).'],
  ['snap', 'snapRows', 'Snapshot rows (raw).'],
  ['meta', 'metaRows', 'Show metadata rows (raw).'],
  ['audience', 'audRows', 'Audience rows (raw).'],
  ['retention', 'retRows', 'Retention rows (raw).'],
  ['dau', 'dauRows', 'DAU rows (raw).'],
];

function sigOf(data) {
  const m = (x) => (x ? x.uploadedAt : '∅');
  return [
    data.evalRows?.length || 0, m(data.evalMeta),
    data.fatRows?.length || 0, m(data.fatMeta),
    data.hdcRows?.length || 0, m(data.hdcMeta),
    data.rcaRows?.length || 0, m(data.rcaMeta),
    data.tsRows?.length || 0, m(data.tsMeta),
    data.langsrRows?.length || 0, m(data.langsrMeta),
  ].join('|');
}

export function buildDataset(data) {
  if (!data) return { empty: true, message: 'No data is currently loaded in the dashboard.' };
  const sig = sigOf(data);
  if (_cache.sig === sig && Date.now() - _cache.at < TTL && _cache.payload) return _cache.payload;
  const payload = compose(data);
  _cache = { sig, at: Date.now(), payload };
  return payload;
}

function compose(data) {
  if (!data.evalRows && !data.fatRows && !(data.rcaRows && data.rcaRows.length)) {
    return { empty: true, message: 'No data is currently loaded. Ask the user to upload the Evaluation and Fatigue CSVs on the Data tab.' };
  }

  const haveShows = !!(data.evalRows || data.fatRows);
  const model = haveShows ? buildModel(data) : [];
  const fatIdx = data.fatRows ? buildFatIndex(data.fatRows) : null;
  const hdcIdx = data.hdcRows ? buildHdcIndex(data.hdcRows) : null;
  const tsIdx = data.tsRows ? buildTimeSpentIndex(data.tsRows) : null;

  // ---- flat per-show records (dashboard-exact numbers) ----
  const shows = model.map((s) => {
    const ev = s.eval?.cur || {};
    const fs = fatIdx?.get(s.id)?.show || null;
    const hd = hdcIdx?.get(s.id) || null;
    const eps = fatIdx?.get(s.id)?.eps;
    const sr = eps ? successRate(eps, data.fatRows) : null;
    const ts = tsIdx?.get(s.id) || null;
    const r = {
      id: s.id,
      title: s.title,
      language: s.language || null,
      language_name: LANG_NAMES[s.language] || s.language || null,
      bu: s.bu || null,
      category: s.category || null,
      status: s.status,
      call: ACTION_META[s.rec.key]?.label || s.rec.key,
      call_key: s.rec.key,
      lifecycle: s.life?.label || null,
      fatigue: s.fat?.label || null,
      agreement: s.rec?.agreement || null,
      contrib_pct: num(ev.l3w_current_contrib_pct),
      prev_contribs: [num(ev.l3w_minus_1_contrib_pct), num(ev.l3w_minus_2_contrib_pct), num(ev.l3w_minus_3_contrib_pct)].filter((v) => v != null),
      users: num(ev.show_users),
      sr_pass: sr && sr.n ? sr.pass : null,
      sr_n: sr && sr.n ? sr.n : null,
      sr_pct: sr && sr.n ? sr.pct : null,
      hdc_count: hd ? hd.hdc : null,
      hdc_supply: hd ? hd.supply : null,
      hdc_pct: hd ? hd.hdcRatePct : null,
      avg_label: hd && hd.avgLevel != null ? Math.round(hd.avgLevel * 100) / 100 : null,
      mode_label: hd ? hd.modeLabel : null,
      label_split: hd ? hd.labels : null,
      fat_score: fs && num(fs.show_fatigue_score) != null ? Math.round(num(fs.show_fatigue_score) * 100) / 100 : null,
      ret6_pct: fs ? num(fs.show_6day_return_rate_pct) : null,
      cat_reach_pct: fs ? num(fs.show_avg_category_reach_rate_pct) : null,
      dominant_failure: fs ? (fs.show_dominant_failure_mode || null) : null,
      d0_delta_4w: fs ? num(fs.show_d0_viewers_pct_change_4w) : null,
      watch_hours: ts ? num(ts.watch_hours) : null,
      time_per_play_min: ts ? num(ts.avg_min_per_play) : null,
      plays: ts ? num(ts.video_plays) : null,
    };
    return r;
  });

  // ---- raw datasets (pass-through, queryable at episode grain) ----
  const datasets = {};
  const catalog = [];
  RAW_MAP.forEach(([name, key, desc]) => {
    const arr = data[key];
    if (Array.isArray(arr) && arr.length) {
      datasets[name] = arr;
      catalog.push({ name, rows: arr.length, columns: Object.keys(arr[0] || {}), description: desc });
    }
  });

  // shows catalog entry (computed table)
  if (shows.length) {
    catalog.unshift({
      name: 'shows',
      rows: shows.length,
      columns: Object.keys(shows[0]),
      description: 'Computed per-show table — the dashboard\'s reconciled view. Each row joins lifecycle + fatigue + HDC + time-spent for one show. Numbers here match the Explorer/Deep Dive exactly. PREFER this for show-level questions.',
    });
  }

  // ---- meta: window, languages, compact definitions ----
  const epDates = [];
  (data.fatRows || []).forEach((r) => { const d = String(r.approved_dt || r.publish_date || '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) epDates.push(d); });
  epDates.sort();
  const meta = {
    total_shows: model.length,
    languages: [...new Set(model.map((s) => s.language).filter(Boolean))].map((l) => `${l} (${LANG_NAMES[l] || l})`),
    episode_window: epDates.length ? `${epDates[0]} … ${epDates[epDates.length - 1]}` : null,
    hdc_window: hdcIdx && hdcIdx.window ? `${hdcIdx.window.lower} … ${hdcIdx.window.upper}` : null,
    definitions: [
      'shows.status: active / experiment / inactive. INACTIVE = already stopped (off-air) — never recommend stopping again.',
      'contrib_pct: peer-relative contribution % (show users ÷ language users). Higher = bigger share.',
      'sr_pct: success rate = settled successful videos ÷ settled (status 1 ÷ (1+0)); trailing-7d settled cohort (approved 4–10 days ago). sr_pass/sr_n are the counts.',
      'hdc_pct: HDC rate = L0 (high-demand) videos ÷ supply over the last-7d HDC window (publish_date today-8..today-2). label_split is the L0–L6 counts; avg_label lower is better.',
      'fat_score: fatigue score, z-scored within language over 7 days; ≥0.5 good, -0.5..0.5 watch, ≤-0.5 poor. ret6_pct: 6-day return.',
      'bu (Awareness/Income/Skill): a meaningful sub-division for HINDI only; for te/ta/ml/kn treat the language as a whole.',
      'rca dataset: report_date = run day (D-0); HDC/labels D-2; paid DAU D-1; SR = D-10→D-4 cohort. % moves vs 7dAvg / DoD / SDLW.',
    ],
  };

  let payload = { shows, datasets, catalog, meta };

  // ---- size guard: drop the largest raw arrays if the payload is too big ----
  const size = () => { try { return JSON.stringify(payload).length; } catch { return 0; } };
  if (size() > MAX_BYTES) {
    const byBytes = Object.keys(datasets)
      .map((name) => ({ name, bytes: JSON.stringify(datasets[name]).length }))
      .sort((a, b) => b.bytes - a.bytes);
    for (const { name } of byBytes) {
      if (size() <= MAX_BYTES) break;
      delete datasets[name];
      const c = catalog.find((x) => x.name === name);
      if (c) { c.truncated = true; c.description += ' (omitted from this payload — too large; ask the user to narrow the question or use the shows table).'; }
    }
  }

  return payload;
}

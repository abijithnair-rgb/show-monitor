// buildContext(data) — compact (~5-10 KB) text snapshot of the tool's current
// data, used as the chatbot's knowledge. Runs in the browser (the data lives in
// IndexedDB), and the snapshot is POSTed to /api/chat. Cached 5 min by signature.
import { buildModel, buildFatIndex, buildTimeSpentIndex } from './model';
import { buildHdcIndex } from './hdc';
import { successRate } from './metrics';
import { ACTION_META } from './constants';
import { num, fmtPct, LANG_NAMES } from './format';

let _cache = { sig: null, at: 0, text: '' };
const TTL = 5 * 60 * 1000;

function sigOf(data) {
  const m = (x) => (x ? x.uploadedAt : '∅');
  return [
    data.evalRows ? data.evalRows.length : 0, m(data.evalMeta),
    data.fatRows ? data.fatRows.length : 0, m(data.fatMeta),
    data.hdcRows ? data.hdcRows.length : 0, m(data.hdcMeta),
  ].join('|');
}

export function buildContext(data) {
  if (!data) return 'No data is currently loaded in the dashboard.';
  const sig = sigOf(data);
  if (_cache.sig === sig && Date.now() - _cache.at < TTL) return _cache.text;
  const text = compose(data);
  _cache = { sig, at: Date.now(), text };
  return text;
}

function compose(data) {
  const { evalRows, fatRows, hdcRows } = data;
  if (!evalRows && !fatRows) return 'No data is currently loaded in the dashboard. Ask the user to upload the Evaluation and Fatigue CSVs on the Data tab.';

  const model = buildModel(data);
  const fatIdx = buildFatIndex(fatRows);
  const hdcIdx = hdcRows ? buildHdcIndex(hdcRows) : null;
  const tsIdx = data.tsRows ? buildTimeSpentIndex(data.tsRows) : null;
  // Reports cover ACTIVE & EXPERIMENTAL shows only — inactive shows are already stopped.
  const active = model.filter((s) => s.status !== 'inactive');
  const L = [];

  // ---- numeric helpers (every report must be number-backed) ----
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const srOf = (s) => { const eps = fatIdx.get(s.id)?.eps; const r = eps ? successRate(eps, fatRows) : null; return r && r.n ? r.pct : null; };
  const hdcRateOf = (s) => { const hd = hdcIdx?.get(s.id); return hd && hd.supply ? hd.hdcRatePct : null; };
  const contribOf = (s) => num(s.eval?.cur?.l3w_current_contrib_pct);
  const usersOf = (s) => num(s.eval?.cur?.show_users);
  const fatScoreOf = (s) => num(fatIdx.get(s.id)?.show?.show_fatigue_score);
  const ret6Of = (s) => num(fatIdx.get(s.id)?.show?.show_6day_return_rate_pct);
  const whOf = (s) => num(tsIdx?.get(s.id)?.watch_hours);
  const tppOf = (s) => num(tsIdx?.get(s.id)?.avg_min_per_play);
  // dense metric rollup for any set of shows (used for product / language / BU)
  const roll = (rows) => {
    const pick = (fn) => rows.map(fn).filter((v) => v != null);
    const sumUsers = pick(usersOf).reduce((a, b) => a + b, 0);
    const sumWh = pick(whOf).reduce((a, b) => a + b, 0);
    return {
      n: rows.length,
      contrib: avg(pick(contribOf)), succ: avg(pick(srOf)), hdc: avg(pick(hdcRateOf)),
      ret6: avg(pick(ret6Of)), fat: avg(pick(fatScoreOf)), tpp: avg(pick(tppOf)),
      users: sumUsers, wh: sumWh,
    };
  };
  const rollLine = (label, rows) => {
    const r = roll(rows);
    return `  ${label}: ${r.n} shows · contrib avg ${fmtPct(r.contrib)} · success avg ${r.succ != null ? r.succ.toFixed(0) + '%' : '—'} · HDC avg ${r.hdc != null ? r.hdc.toFixed(0) + '%' : '—'} · 6dRet avg ${fmtPct(r.ret6, 0)} · fatScore avg ${r.fat != null ? r.fat.toFixed(2) : '—'} · users ${r.users.toLocaleString()} · watch ${Math.round(r.wh).toLocaleString()}h`;
  };

  L.push('=== SEEKHO SHOW MONITOR — DATA SNAPSHOT ===');
  L.push(`Total shows: ${model.length} · both-lens: ${model.filter((s) => s.source === 'both').length} · lifecycle-only: ${model.filter((s) => s.source === 'eval').length} · fatigue-only: ${model.filter((s) => s.source === 'fatigue').length}`);
  L.push(`Languages: ${[...new Set(model.map((s) => s.language).filter(Boolean))].map((l) => LANG_NAMES[l] || l).join(', ')}`);

  // headline aggregate numbers (whole product) — use these as the numeric backbone of any report
  L.push('');
  L.push('HEADLINE NUMBERS (active & experimental shows only — averages & totals; use these in reports):');
  L.push(`  Contribution %: avg ${fmtPct(avg(active.map(contribOf).filter((v) => v != null)))} · median ${fmtPct(median(active.map(contribOf).filter((v) => v != null)))} · max ${fmtPct(Math.max(...active.map(contribOf).filter((v) => v != null), 0))}`);
  L.push(`  Success rate: avg ${(() => { const a = active.map(srOf).filter((v) => v != null); return a.length ? avg(a).toFixed(0) + '%' : '—'; })()}`);
  L.push(`  HDC rate 7d: avg ${(() => { const a = active.map(hdcRateOf).filter((v) => v != null); return a.length ? avg(a).toFixed(0) + '%' : '—'; })()}`);
  L.push(`  6-day return: avg ${fmtPct(avg(active.map(ret6Of).filter((v) => v != null)), 0)}`);
  L.push(`  Fatigue score: avg ${(() => { const a = active.map(fatScoreOf).filter((v) => v != null); return a.length ? avg(a).toFixed(2) : '—'; })()}`);
  L.push(`  Total paid users: ${active.map(usersOf).filter((v) => v != null).reduce((a, b) => a + b, 0).toLocaleString()}`);
  if (tsIdx) L.push(`  Total watch hours 7d: ${Math.round(active.map(whOf).filter((v) => v != null).reduce((a, b) => a + b, 0)).toLocaleString()}h · avg time/play ${(() => { const a = active.map(tppOf).filter((v) => v != null); return a.length ? avg(a).toFixed(2) + ' min' : '—'; })()}`);

  // counts by unified action
  const byAction = {};
  model.forEach((s) => { byAction[s.rec.key] = (byAction[s.rec.key] || 0) + 1; });
  L.push('');
  L.push('UNIFIED RECOMMENDATION COUNTS:');
  Object.keys(ACTION_META).forEach((k) => { if (byAction[k]) L.push(`  ${ACTION_META[k].label} (${k}): ${byAction[k]}`); });

  // per-language breakdown (dense numeric rollup)
  L.push('');
  L.push('BY LANGUAGE (active & experimental only · shows · avg contrib% · avg success% · avg HDC% · avg 6dRet% · avg fatScore · total users · watch h):');
  const langs = [...new Set(active.map((s) => s.language).filter(Boolean))].sort();
  langs.forEach((lang) => L.push(rollLine(LANG_NAMES[lang] || lang, active.filter((s) => s.language === lang))));

  // Hindi BU breakdown — BU is only a scoping dimension for Hindi.
  const hindiRows = active.filter((s) => s.language === 'hi');
  if (hindiRows.length) {
    L.push('');
    L.push('HINDI BY BU (same metric rollup) — BU applies to Hindi only:');
    ['Awareness', 'Income', 'Skill'].forEach((bu) => {
      const rows = hindiRows.filter((s) => s.bu === bu);
      if (rows.length) L.push(rollLine(bu, rows));
    });
    const noBu = hindiRows.filter((s) => !s.bu).length;
    if (noBu) L.push(`  (BU unmapped: ${noBu})`);
  }

  // per-category breakdown
  L.push('');
  L.push('BY CATEGORY (shows · stop/review count):');
  const cats = [...new Set(model.map((s) => s.category).filter(Boolean))].sort();
  cats.slice(0, 20).forEach((cat) => {
    const rows = model.filter((s) => s.category === cat);
    const urgent = rows.filter((s) => ['CONFIRMED_STOP', 'STOP_REVIEW'].includes(s.rec.key)).length;
    L.push(`  ${cat}: ${rows.length}${urgent ? ` · ${urgent} stop/review` : ''}`);
  });

  // helper to render a show line
  const showLine = (s) => {
    const ev = s.eval?.cur;
    const fs = fatIdx.get(s.id)?.show;
    const hd = hdcIdx?.get(s.id);
    const bits = [];
    bits.push(`#${s.id} "${s.title}" [${s.language}${s.bu ? '/' + s.bu : ''}${s.category ? '/' + s.category : ''}] ${s.status}`);
    bits.push(`call=${ACTION_META[s.rec.key]?.label || s.rec.key}`);
    bits.push(`lifecycle=${s.life.label}`);
    bits.push(`fatigue=${s.fat.label}`);
    if (ev) bits.push(`contrib=${fmtPct(num(ev.l3w_current_contrib_pct))} users=${num(ev.show_users) ?? '—'}`);
    const sr = fatIdx.get(s.id)?.eps ? successRate(fatIdx.get(s.id).eps, fatRows) : null;
    if (sr && sr.n) bits.push(`success=${sr.pct}% (${sr.pass}/${sr.n})`);
    if (fs) bits.push(`fatScore=${num(fs.show_fatigue_score) != null ? num(fs.show_fatigue_score).toFixed(2) : '—'} 6dRet=${fmtPct(num(fs.show_6day_return_rate_pct), 0)} catReach=${fmtPct(num(fs.show_avg_category_reach_rate_pct))} dominant=${fs.show_dominant_failure_mode || '—'}`);
    if (hd) bits.push(`HDC7d=${hd.hdc}/${hd.supply} (${hd.hdcRatePct}%) avgLabel=${hd.avgLevel != null ? 'L' + hd.avgLevel.toFixed(2) : '—'} modeLabel=${hd.modeLabel || '—'}`);
    const t = tsIdx?.get(s.id);
    if (t) bits.push(`watch7d=${Math.round(num(t.watch_hours) || 0)}h time/play=${num(t.avg_min_per_play) != null ? num(t.avg_min_per_play).toFixed(2) + 'min' : '—'} plays=${num(t.video_plays) ?? '—'}`);
    return '  - ' + bits.join(' · ');
  };

  // TOP SHOWS by the three headline metrics (active only) — for show-centric reports.
  const topContrib = active.filter((s) => num(s.eval?.cur?.l3w_current_contrib_pct) != null)
    .sort((a, b) => num(b.eval.cur.l3w_current_contrib_pct) - num(a.eval.cur.l3w_current_contrib_pct)).slice(0, 6);
  if (topContrib.length) {
    L.push('');
    L.push('TOP SHOWS BY CONTRIBUTION % (active, highest first):');
    topContrib.forEach((s) => L.push(showLine(s)));
  }
  const topHdc = active.filter((s) => hdcRateOf(s) != null)
    .sort((a, b) => hdcRateOf(b) - hdcRateOf(a)).slice(0, 6);
  if (topHdc.length) {
    L.push('');
    L.push('TOP SHOWS BY HDC RATE 7d (active, highest first):');
    topHdc.forEach((s) => L.push(showLine(s)));
  }
  const topSuccess = active.filter((s) => srOf(s) != null)
    .sort((a, b) => srOf(b) - srOf(a)).slice(0, 6);
  if (topSuccess.length) {
    L.push('');
    L.push('TOP SHOWS BY SUCCESS RATE (active, highest first):');
    topSuccess.forEach((s) => L.push(showLine(s)));
  }

  // Performance tiers (good / average / bad) for numbers-only performance reports.
  const tierOf = (s) => {
    const z = fatIdx.get(s.id)?.show?.show_fatigue_zone;
    if (z === 'green') return 'good';
    if (z === 'red') return 'bad';
    if (z === 'yellow') return 'average';
    const t = s.life?.tone;
    if (t === 'green') return 'good';
    if (t === 'red') return 'bad';
    return 'average';
  };
  const tierCounts = (rows) => {
    const c = { good: 0, average: 0, bad: 0 };
    rows.forEach((s) => { c[tierOf(s)] += 1; });
    return `good ${c.good} · average ${c.average} · bad ${c.bad}`;
  };
  if (active.length) {
    L.push('');
    L.push('PERFORMANCE TIER COUNTS (active/experimental — good/average/bad, per slice):');
    L.push(`  Whole product: ${tierCounts(active)}`);
    langs.forEach((lang) => L.push(`  ${LANG_NAMES[lang] || lang}: ${tierCounts(active.filter((s) => s.language === lang))}`));
    ['Awareness', 'Income', 'Skill'].forEach((bu) => {
      const r = active.filter((s) => s.language === 'hi' && s.bu === bu);
      if (r.length) L.push(`  Hindi·${bu}: ${tierCounts(r)}`);
    });
  }

  // Per-slice TOP 3 / BOTTOM 3 by contribution % (active/experimental), with the
  // three report metrics — so a scoped weekly report has exact numbers for any slice.
  const fmtMini = (s) => `"${s.title}" (contrib ${fmtPct(contribOf(s))} · HDC ${hdcRateOf(s) != null ? hdcRateOf(s) + '%' : '—'} · success ${srOf(s) != null ? srOf(s) + '%' : '—'})`;
  const sliceLine = (label, rows) => {
    const ranked = rows.filter((s) => contribOf(s) != null).sort((a, b) => contribOf(b) - contribOf(a));
    if (!ranked.length) return null;
    const top = ranked.slice(0, 3).map(fmtMini).join(' | ');
    let line = `  ${label} (${ranked.length} shows) — TOP3: ${top}`;
    if (ranked.length > 3) line += ` ;; BOTTOM3: ${ranked.slice(-3).reverse().map(fmtMini).join(' | ')}`;
    return line;
  };
  L.push('');
  L.push('SLICE TOP3 / BOTTOM3 (active/experimental; ranked by contribution %; metrics = contribution% · HDC rate · success rate):');
  { const w = sliceLine('Whole product', active); if (w) L.push(w); }
  langs.forEach((lang) => { const ln = sliceLine(LANG_NAMES[lang] || lang, active.filter((s) => s.language === lang)); if (ln) L.push(ln); });
  ['Awareness', 'Income', 'Skill'].forEach((bu) => {
    const ln = sliceLine(`Hindi·${bu}`, active.filter((s) => s.language === 'hi' && s.bu === bu));
    if (ln) L.push(ln);
  });

  // inactive = already stopped/off-air; never list them as needing a stop.
  const problems = model
    .filter((s) => s.status !== 'inactive' && ['CONFIRMED_STOP', 'STOP_REVIEW', 'OVERPUBLISHING', 'FIXABLE_DECLINE', 'WATCH_AND_FIX'].includes(s.rec.key))
    .sort((a, b) => a.rec.priority - b.rec.priority)
    .slice(0, 25);
  if (problems.length) {
    L.push('');
    L.push('SHOWS NEEDING ACTION (most urgent first; inactive/stopped shows excluded):');
    problems.forEach((s) => L.push(showLine(s)));
  }

  // top healthy / scale shows (active only — you can't scale a stopped show)
  const healthy = model
    .filter((s) => s.status !== 'inactive' && ['SCALE', 'PROMOTE', 'PROMOTE_WITH_FIX', 'HOLD_HEALTHY'].includes(s.rec.key))
    .sort((a, b) => (num(b.eval?.cur?.show_users) || 0) - (num(a.eval?.cur?.show_users) || 0))
    .slice(0, 15);
  if (healthy.length) {
    L.push('');
    L.push('STRONG / SCALE-READY SHOWS (biggest first):');
    healthy.forEach((s) => L.push(showLine(s)));
  }

  // relaunch candidates: inactive (already stopped) shows whose numbers are strong.
  const relaunch = model
    .filter((s) => s.status === 'inactive' && (num(fatIdx.get(s.id)?.show?.show_fatigue_score) >= 0.5 || s.life?.tone === 'green'))
    .sort((a, b) => (num(fatIdx.get(b.id)?.show?.show_fatigue_score) || 0) - (num(fatIdx.get(a.id)?.show?.show_fatigue_score) || 0))
    .slice(0, 10);
  if (relaunch.length) {
    L.push('');
    L.push('RELAUNCH CANDIDATES (inactive/already stopped, but metrics still strong — worth reconsidering, NOT stopping):');
    relaunch.forEach((s) => L.push(showLine(s)));
  }

  // reference definitions
  L.push('');
  L.push('=== REFERENCE / DEFINITIONS ===');
  L.push('Two lenses joined on show_id:');
  L.push('• Lifecycle (New Show Evaluation): peer-relative contribution % (show users ÷ language users) vs percentile bars stop=P25/weak=P40/retain=P60/strong=P75; STOP/PROMOTE for experiments; recent-trajectory decay.');
  L.push('• Fatigue (Content Fatigue Monitor): episode Hook/Pace/Ending failure modes, saturation, 6-day return, category reach, fatigue score.');
  L.push('Unified call reconciles both — e.g. weak-vs-peers + fixable creative cause = "Fixable Decline" (fix before cutting); below-stop + sustained miss = "Confirmed Stop".');
  L.push('Agreement: Aligned (both same direction), Conflict (disagree — needs judgment), One lens (only one CSV).');
  L.push('BU (business unit): each show maps to Awareness / Income / Skill via its category. BU is a meaningful sub-division for HINDI only — for Telugu/Tamil/Malayalam/Kannada, treat the language as a whole.');
  L.push('Fatigue score: z-scored within language over the last 7 days, weighted comp-efficiency-Δ-H123 60% + category-reach-Δ 20% + 6-day-return 20%. Higher = healthier; ≥0.5 good, -0.5..0.5 watch, ≤-0.5 poor.');
  L.push('Success rate: % of successful videos among the last 7 with a settled success flag (approved 4–10 days ago). SR = status=1 ÷ (status=1 + status=0); content_performance.status NULL is excluded. Same definition as the Daily RCA.');
  L.push('6-day return: share of show-user-days where the user returned within 6 days.');
  L.push('Category reach %: show D0 viewers ÷ category paid DAU (4-week avg).');
  L.push('HDC labels (last 7 days, today-8..today-2): L0=HDC (top), L1=high reach/weak CR, L2=strong CR+scale, L3=above median, L4=p25–p50, L5=below p25, L6=edge. HDC rate = L0 ÷ total. D0/H123 views = CMS starts (content_metrics_run_log_v2).');

  let text = L.join('\n');
  // keep it bounded (~12 KB safety cap)
  if (text.length > 12000) text = text.slice(0, 12000) + '\n…(snapshot truncated)';
  return text;
}

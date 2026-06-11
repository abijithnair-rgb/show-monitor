// buildContext(data) — compact (~5-10 KB) text snapshot of the tool's current
// data, used as the chatbot's knowledge. Runs in the browser (the data lives in
// IndexedDB), and the snapshot is POSTed to /api/chat. Cached 5 min by signature.
import { buildModel, buildFatIndex } from './model';
import { buildHdcIndex } from './hdc';
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
  const L = [];

  L.push('=== SEEKHO SHOW INTELLIGENCE — DATA SNAPSHOT ===');
  L.push(`Total shows: ${model.length} · both-lens: ${model.filter((s) => s.source === 'both').length} · lifecycle-only: ${model.filter((s) => s.source === 'eval').length} · fatigue-only: ${model.filter((s) => s.source === 'fatigue').length}`);
  L.push(`Languages: ${[...new Set(model.map((s) => s.language).filter(Boolean))].map((l) => LANG_NAMES[l] || l).join(', ')}`);

  // counts by unified action
  const byAction = {};
  model.forEach((s) => { byAction[s.rec.key] = (byAction[s.rec.key] || 0) + 1; });
  L.push('');
  L.push('UNIFIED RECOMMENDATION COUNTS:');
  Object.keys(ACTION_META).forEach((k) => { if (byAction[k]) L.push(`  ${ACTION_META[k].label} (${k}): ${byAction[k]}`); });

  // per-language breakdown
  L.push('');
  L.push('BY LANGUAGE (shows · avg contribution% · avg fatigue score):');
  const langs = [...new Set(model.map((s) => s.language).filter(Boolean))].sort();
  langs.forEach((lang) => {
    const rows = model.filter((s) => s.language === lang);
    const contribs = rows.map((s) => num(s.eval?.cur?.l3w_current_contrib_pct)).filter((v) => v != null);
    const fscores = rows.map((s) => num(fatIdx.get(s.id)?.show?.show_fatigue_score)).filter((v) => v != null);
    const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : null);
    L.push(`  ${LANG_NAMES[lang] || lang}: ${rows.length} · ${fmtPct(avg(contribs))} · ${avg(fscores) != null ? avg(fscores).toFixed(2) : '—'}`);
  });

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
    bits.push(`#${s.id} "${s.title}" [${s.language}${s.category ? '/' + s.category : ''}] ${s.status}`);
    bits.push(`call=${ACTION_META[s.rec.key]?.label || s.rec.key}`);
    bits.push(`lifecycle=${s.life.label}`);
    bits.push(`fatigue=${s.fat.label}`);
    if (ev) bits.push(`contrib=${fmtPct(num(ev.l3w_current_contrib_pct))} users=${num(ev.show_users) ?? '—'}`);
    if (fs) bits.push(`fatScore=${num(fs.show_fatigue_score) != null ? num(fs.show_fatigue_score).toFixed(2) : '—'} 6dRet=${fmtPct(num(fs.show_6day_return_rate_pct), 0)} catReach=${fmtPct(num(fs.show_avg_category_reach_rate_pct))} dominant=${fs.show_dominant_failure_mode || '—'}`);
    if (hd) bits.push(`HDC7d=${hd.hdc}/${hd.supply} (${hd.hdcRatePct}%) modeLabel=${hd.modeLabel || '—'}`);
    return '  - ' + bits.join(' · ');
  };

  // problem shows (most urgent first), capped
  const PRIORITY = Object.keys(ACTION_META);
  const problems = model
    .filter((s) => ['CONFIRMED_STOP', 'STOP_REVIEW', 'OVERPUBLISHING', 'FIXABLE_DECLINE', 'WATCH_AND_FIX'].includes(s.rec.key))
    .sort((a, b) => a.rec.priority - b.rec.priority)
    .slice(0, 25);
  if (problems.length) {
    L.push('');
    L.push('SHOWS NEEDING ACTION (most urgent first):');
    problems.forEach((s) => L.push(showLine(s)));
  }

  // top healthy / scale shows
  const healthy = model
    .filter((s) => ['SCALE', 'PROMOTE', 'PROMOTE_WITH_FIX', 'HOLD_HEALTHY'].includes(s.rec.key))
    .sort((a, b) => (num(b.eval?.cur?.show_users) || 0) - (num(a.eval?.cur?.show_users) || 0))
    .slice(0, 15);
  if (healthy.length) {
    L.push('');
    L.push('STRONG / SCALE-READY SHOWS (biggest first):');
    healthy.forEach((s) => L.push(showLine(s)));
  }

  // reference definitions
  L.push('');
  L.push('=== REFERENCE / DEFINITIONS ===');
  L.push('Two lenses joined on show_id:');
  L.push('• Lifecycle (New Show Evaluation): peer-relative contribution % (show users ÷ language users) vs percentile bars stop=P25/weak=P40/retain=P60/strong=P75; STOP/PROMOTE for experiments; recent-trajectory decay.');
  L.push('• Fatigue (Content Fatigue Monitor): episode Hook/Pace/Ending failure modes, saturation, 6-day return, category reach, fatigue score.');
  L.push('Unified call reconciles both — e.g. weak-vs-peers + fixable creative cause = "Fixable Decline" (fix before cutting); below-stop + sustained miss = "Confirmed Stop".');
  L.push('Agreement: Aligned (both same direction), Conflict (disagree — needs judgment), One lens (only one CSV).');
  L.push('Fatigue score: z-scored within language over the last 7 days, weighted comp-efficiency-Δ-H123 60% + category-reach-Δ 20% + 6-day-return 20%. Higher = healthier; ≥0.5 good, -0.5..0.5 watch, ≤-0.5 poor.');
  L.push('Success rate: % of successful videos among the last 7 with settled H123 (approved 4–10 days ago). Success = content_performance.status=1 or H123 completion ≥ target.');
  L.push('6-day return: share of show-user-days where the user returned within 6 days.');
  L.push('Category reach %: show D0 viewers ÷ category paid DAU (4-week avg).');
  L.push('HDC labels (last 7 days, today-8..today-2): L0=HDC (top), L1=high reach/weak CR, L2=strong CR+scale, L3=above median, L4=p25–p50, L5=below p25, L6=edge. HDC rate = L0 ÷ total. D0/H123 views = CMS starts (content_metrics_run_log_v2).');

  let text = L.join('\n');
  // keep it bounded (~12 KB safety cap)
  if (text.length > 12000) text = text.slice(0, 12000) + '\n…(snapshot truncated)';
  return text;
}

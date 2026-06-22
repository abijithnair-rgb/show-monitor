// HTML-string builders (read-only markup rendered via dangerouslySetInnerHTML).
// Ported verbatim from the original view functions; data threaded via args.
import { esc, fmtNum, fmtPct, fmtDate, num, pickv, LANG_NAMES } from './format';
import { ACTION_META, retentionGuardrail } from './constants';
import { toneCls, buildTimeSpentIndex } from './model';
import { tip } from './tips';
import { buildHdcIndex, hdcNoContentMsg } from './hdc';
import { successRate, langAvgFat, globalBars, failureFromGuardrail } from './metrics';

const toneChip = { red: 'chip-red', amber: 'chip-amber', green: 'chip-green', grey: 'chip-grey', blue: 'chip-blue' };

export function actionChip(key) {
  const m = ACTION_META[key] || { tone: 'grey', label: key, icon: '' };
  return `<span class="chip ${toneChip[m.tone]}">${m.icon} ${esc(m.label)}</span>`;
}
export function agreeBadge(ag) {
  const map = { 'aligned-negative': ['#991b1b', 'Aligned'], 'aligned-positive': ['#065f46', 'Aligned'], conflict: ['#92400e', 'Conflict — judge'], partial: ['#64748b', 'Partial'], 'one-lens': ['#94a3b8', 'One lens'] };
  const [c, l] = map[ag] || map.partial;
  return `<span class="text-xs" style="color:${c}"><span class="agree-dot" style="background:${c}"></span> ${l}</span>`;
}
export function statusChip(st) {
  const m = { active: ['chip-green', '● active'], experiment: ['chip-amber', '● experiment'], inactive: ['chip-light', '● inactive'] };
  const [c, l] = m[st] || ['chip-grey', '● ' + (st || '?')];
  return `<span class="chip ${c}">${esc(l)}</span>`;
}
export function trajChip(t) {
  const m = { improving: ['chip-green', '↑ improving'], declining: ['chip-red', '↓ declining'], stable: ['chip-grey', '→ stable'], volatile: ['chip-amber', '~ volatile'], insufficient_data: ['chip-light', '· n/a'] };
  const [c, l] = m[t] || ['chip-light', '· ' + (t || 'n/a')];
  return `<span class="chip ${c}">${esc(l)}</span>`;
}
// Colour a retention %. With a data-backed `min` guardrail (exact floor for that
// video length & checkpoint): green at/above the floor, amber within 5pp below, red
// further below. Without a guardrail, falls back to the generic <50/<70 bands.
export function retClass(v, min) {
  if (v == null || isNaN(+v)) return '#94a3b8';
  v = +v;
  if (min != null && !isNaN(+min)) {
    min = +min;
    return v >= min ? '#2A9D8F' : v >= min - 5 ? '#D97706' : '#E63946';
  }
  return v < 50 ? '#E63946' : v < 70 ? '#D97706' : '#2A9D8F';
}
export function failChip(fm) {
  const m = { HOOK_FAIL: ['chip-amber', 'Hook'], PACE_FAIL: ['chip-amber', 'Pace'], ENDING_FAIL: ['chip-indigo', 'Ending'], OK: ['chip-green', 'OK'] };
  const x = m[fm];
  if (x) return `<span class="chip ${x[0]}">${x[1]}</span>`;
  return `<span class="chip chip-light">${esc(fm || '—')}</span>`;
}
export function outcomeChip(o, status, verdict) {
  // The CMS settled status (content_performance.status: 1=success, 0=failed) is
  // authoritative when present — it must NOT be overridden by a stale/derived
  // video_outcome or comp_verdict. Only fall back to those when status is unset.
  const st = num(status);
  if (st === 1) return `<span class="chip chip-green">✓ success</span>`;
  if (st === 0) return `<span class="chip chip-red">✗ failed</span>`;
  const v = String(verdict || '').toUpperCase();
  if (o === 'success' || v === 'PASS') return `<span class="chip chip-green">✓ success</span>`;
  if (o === 'failed' || v === 'FAIL') return `<span class="chip chip-red">✗ failed</span>`;
  return `<span class="text-xs text-slate-400 italic">pending</span>`;
}
export function labelChip(L) {
  if (!L) return '<span class="hint">—</span>';
  const m = { L0: 'chip-green', L1: 'chip-amber', L2: 'chip-blue', L3: 'chip-indigo', L4: 'chip-light', L5: 'chip-red', L6: 'chip-grey' };
  return `<span class="chip ${m[L] || 'chip-grey'}">${esc(L)}</span>`;
}

export function lifecycleCell(s) {
  if (!s.eval) return '<span class="chip chip-light">no lifecycle data</span>';
  const ev = s.eval.cur;
  const c = num(ev.l3w_current_contrib_pct),
    stop = num(ev.stop_below_users_contrib_pct),
    ret = num(ev.retain_above_users_contrib_pct);
  return `<div class="flex flex-col gap-1">
    <div class="flex gap-1 items-center flex-wrap">
      <span class="chip chip-${toneCls(s.life.tone)}">${esc(s.life.label)}</span>
      ${trajChip(ev.recent_trajectory)}
    </div>
    <div class="text-xs text-slate-600">${c != null ? `<b>${fmtPct(c)}</b> of ${esc(LANG_NAMES[s.language] || s.language)}` : '—'}${stop != null ? ` <span class="hint">· stop ${fmtPct(stop, 1)} · retain ${fmtPct(ret, 1)}</span>` : ''}</div>
  </div>`;
}

// Explorer "Show manager" cell. Read-only name unless `assign.enabled` (KV on +
// a name set), in which case it offers a self-assign / unassign control. Buttons
// carry data-assign-show + data-assign-action for the tab's click delegation.
function managerCell(s, assign) {
  const name = s.manager || '';
  if (!assign || !assign.enabled) {
    return name ? esc(name) : '<span class="hint">—</span>';
  }
  const me = assign.me;
  const isMe = name && name.toLowerCase() === String(me).toLowerCase();
  const btn = (action, label, cls) =>
    `<button type="button" class="text-xs underline ${cls}" data-assign-show="${esc(s.id)}" data-assign-action="${action}">${label}</button>`;
  if (isMe) {
    return `<div class="flex flex-col gap-0.5"><span class="chip chip-green">✓ You</span>${btn('unassign', 'unassign', 'text-slate-400 hover:text-slate-700')}</div>`;
  }
  return `<div class="flex flex-col gap-0.5">${name ? `<span class="text-slate-700">${esc(name)}</span>` : '<span class="hint">—</span>'}${btn('assign', '＋ Assign me', 'text-blue-600 hover:text-blue-800')}</div>`;
}

// `assign` = { enabled, me } — when enabled, the manager cell offers a click-
// delegated self-assign control (data-assign-show / data-assign-action).
export function explorerRow(s, hdcRows, assign) {
  const users = s.eval ? num(s.eval.cur.show_users) : null;
  let hdcCells = '';
  if (hdcRows) {
    const hd = buildHdcIndex(hdcRows).get(s.id);
    const why = hd ? '' : ` data-tip="${esc(hdcNoContentMsg(s, hdcRows))}"`;
    const rate = hd && hd.hdcRatePct != null ? `${hd.hdcRatePct}%<div class="hint">${hd.hdc}/${hd.supply}</div>` : `<span class="hint"${why}>—</span>`;
    const mode = hd && hd.modeLabel ? `${labelChip(hd.modeLabel)}<div class="hint">${hd.modeCnt}/${hd.supply} days</div>` : `<span class="hint"${why}>—</span>`;
    hdcCells = `<td>${rate}</td><td>${mode}</td>`;
  }
  return `<tr class="row-clickable" data-show="${esc(s.id)}">
    <td><div class="font-medium">${esc(s.title || '—')}</div>
      <div class="mt-1 flex gap-1 flex-wrap"><span class="chip chip-blue">${esc(LANG_NAMES[s.language] || s.language || '?')}</span>${s.category ? `<span class="chip chip-purple">${esc(s.category)}</span>` : ''}</div></td>
    <td>${managerCell(s, assign)}</td>
    <td>${statusChip(s.status)}</td>
    <td>${lifecycleCell(s)}</td>
    <td>${users != null ? fmtNum(users) : '—'}</td>
    ${hdcCells}
    <td><span class="chip chip-${toneCls(s.fat.tone)}">${esc(s.fat.label)}</span>${s.fat.mode && s.fat.mode !== 'OK' && s.fat.mode !== 'INSUFFICIENT_DATA' ? `<div class="hint mt-1">${esc(s.fat.mode)}</div>` : ''}</td>
    <td>${actionChip(s.rec.key)}<div class="hint mt-1">${esc(s.rec.headline)}</div></td>
  </tr>`;
}

export function queueCard(s) {
  const contrib = s.eval ? num(s.eval.cur.l3w_current_contrib_pct) : null;
  // saturation was attached to the fat classification (s.fat._sat) during buildModel
  const sat = s.fat ? num(s.fat._sat) : null;
  return `<div class="card p-3 row-clickable" data-show="${esc(s.id)}">
    <div class="flex items-start justify-between gap-2">
      <div class="font-medium">${esc(s.title)}</div>
      <span class="chip chip-blue">${esc(LANG_NAMES[s.language] || s.language)}</span>
    </div>
    <p class="text-sm text-slate-600 mt-1">${esc(s.rec.detail)}</p>
    <div class="flex gap-3 mt-2 text-xs text-slate-500">
      <span>Lifecycle: <b>${esc(s.life.label)}</b></span>
      <span>Fatigue: <b>${esc(s.fat.label)}</b></span>
      ${contrib != null ? `<span>Contrib ${fmtPct(contrib)}</span>` : ''}
      ${sat != null ? `<span>Sat ${fmtPct(sat, 0)}</span>` : ''}
    </div>
    <div class="mt-2">${agreeBadge(s.rec.agreement)}</div>
  </div>`;
}

export function contribBar(ev, evalRows) {
  const cur = num(ev.l3w_current_contrib_pct) ?? num(ev.show_users_contrib_pct_of_language) ?? 0;
  const g = globalBars(ev.language, evalRows);
  const stop = g ? g.stop : num(ev.stop_below_users_contrib_pct) || 0;
  const weak = g ? g.weak : num(ev.weak_below_users_contrib_pct) || 0;
  const ret = g ? g.retain : num(ev.retain_above_users_contrib_pct) || 0;
  const strong = g ? g.strong : num(ev.strong_above_users_contrib_pct) || 0;
  const maxv = Math.max(strong * 1.2, cur * 1.1, ret * 1.3, 0.01);
  const pct = (v) => Math.max(0, Math.min(100, (v / maxv) * 100));
  const z = (a, b, c) => `<div style="width:${pct(b) - pct(a)}%;background:${c}"></div>`;
  return `<div class="thr-bar">
      ${z(0, stop, '#fecaca')}${z(stop, weak, '#fde68a')}${z(weak, ret, '#bbf7d0')}${z(ret, maxv, '#34d399')}
      <div class="thr-marker" style="left:${pct(cur)}%"></div>
    </div>
    <div class="flex justify-between mt-2 text-xs text-center">
      <div><b>STOP</b><br>${fmtPct(stop)}</div><div><b>WEAK</b><br>${fmtPct(weak)}</div>
      <div><b>RETAIN</b><br>${fmtPct(ret)}</div><div><b>STRONG</b><br>${fmtPct(strong)}</div>
    </div>
    <div class="text-sm mt-2">Now: <b>${fmtPct(cur)}</b> of ${LANG_NAMES[ev.language] || ev.language} users · vs <b>global ${LANG_NAMES[ev.language] || ev.language}</b> bars${g ? ` (${g.n} shows)` : ''}</div>`;
}

// fobj = the fat index entry {show, eps} for this show (or null); passed in by the component.
export function kpiGrid(s, data, fobj) {
  const { fatRows, hdcRows, tsRows } = data;
  const ev = s.eval ? s.eval.cur : null;
  const fs = fobj ? fobj.show : null;
  const hdc = hdcRows ? buildHdcIndex(hdcRows).get(s.id) : null;
  const ts = tsRows ? buildTimeSpentIndex(tsRows).get(s.id) : null;
  const tspp = ts ? num(ts.avg_min_per_play) : null;
  const plays = ts ? num(ts.video_plays) : null;
  const wh = ts ? num(ts.watch_hours) : null;
  const tsUsers = ts ? num(ts.unique_users) : null;
  const watchHoursKpi = ['Watch hours (7d)', wh != null
    ? `${fmtNum(Math.round(wh))} hrs${tsUsers != null ? `<div class="hint">${fmtNum(tsUsers)} users</div>` : ''}`
    : `—<div class="hint">no plays in 7d</div>`, 'watch_hours'];
  const timePerPlayKpi = ['Avg time/play (7d)', tspp != null
    ? `${tspp.toFixed(2)} min${plays != null ? `<div class="hint">${fmtNum(plays)} plays</div>` : ''}`
    : `—<div class="hint">no plays in 7d</div>`, 'time_per_play'];
  const kpis = [];
  // Row 1: lifecycle/supply KPIs, capped with Watch hours so the fatigue group
  // starts a fresh line at the 5-per-row breakpoint.
  if (ev) {
    kpis.push(['Contribution %', fmtPct(num(ev.l3w_current_contrib_pct)) + `<div class="hint">of ${LANG_NAMES[s.language] || s.language}</div>`, 'contribution']);
    kpis.push(['Current users', fmtNum(num(ev.show_users)), 'users']);
    if (hdcRows) {
      kpis.push(['HDC rate (7d)', hdc && hdc.hdcRatePct != null ? `${hdc.hdcRatePct}%<div class="hint">${hdc.hdc}/${hdc.supply} HDC</div>` : `—<div class="hint">no content in 7d</div>`, 'hdc_rate']);
    } else {
      kpis.push(['HDC rate (7d)', `—<div class="hint">upload HDC CSV</div>`, 'hdc_rate']);
    }
    kpis.push(['Confidence', `<span class="chip chip-grey">${esc(ev.confidence || '—')}</span>`, 'confidence']);
  }
  if (tsRows) kpis.push(watchHoursKpi);
  // Row 2: the fatigue group, fatigue first.
  if (fs) {
    const fScore = num(fs.show_fatigue_score) ?? 0;
    const fZone = fs.show_fatigue_zone || '';
    kpis.push(['Fatigue score', `${fScore.toFixed(2)} <span class="chip chip-${fZone === 'green' ? 'green' : fZone === 'red' ? 'red' : 'amber'}">${esc(fZone)}</span>` + `<div class="hint" style="margin-top:3px">scale: <span style="color:#E63946">≤ -0.5 poor</span> · <span style="color:#D97706">-0.5–0.5 watch</span> · <span style="color:#2A9D8F">≥ 0.5 good</span></div>`, 'fatigue_score']);
    const sr = successRate(fobj.eps, fatRows);
    kpis.push(['Success rate (last 7, settled H123)', sr.n ? `${sr.pct}%<div class="hint">${sr.pass}/${sr.n} settled videos</div>` : `—<div class="hint">no settled videos in window</div>`, 'success_rate']);
    const cr = num(fs.show_avg_category_reach_rate_pct),
      cravg = langAvgFat(s.language, 'show_avg_category_reach_rate_pct', fatRows);
    kpis.push(['Category reach %', cr != null ? `${fmtPct(cr, 2)}${cravg != null ? `<div class="hint">${LANG_NAMES[s.language] || s.language} avg ${fmtPct(cravg, 2)}</div>` : ''}` : '—', 'cat_reach']);
    const r6 = num(fs.show_6day_return_rate_pct),
      r6avg = langAvgFat(s.language, 'show_6day_return_rate_pct', fatRows);
    kpis.push(['6-day return', `${fmtPct(r6, 0)}${r6avg != null ? `<div class="hint">${LANG_NAMES[s.language] || s.language} avg ${fmtPct(r6avg, 0)}</div>` : ''}`, 'return6']);
  }
  if (tsRows) kpis.push(timePerPlayKpi);
  return kpis.map((k) => `<div class="kpi"${tip(k[2])}><div class="lbl">${k[0]}</div><div class="val text-base">${k[1]}</div></div>`).join('');
}

export function hdcCard(hdc, show, hdcRows) {
  const LBL_DESC = { L0: 'HDC (view+CR)', L1: 'High reach, weak CR', L2: 'Strong CR + scale', L3: 'Above median', L4: 'p25–p50', L5: 'Below p25', L6: 'Uncategorised' };
  if (!hdc) {
    return `<div class="card p-4 mb-4"><div class="font-semibold mb-1"${tip('hdc_block')}>HDC supply &amp; labels (last 7 days)</div>
      <div class="text-sm text-slate-500">${esc(show ? hdcNoContentMsg(show, hdcRows) : 'No content in the last-7-day window.')}</div></div>`;
  }
  const cells = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']
    .map((L) => `
    <div class="kpi text-center"${tip('label_' + L)}>
      <div class="lbl">${L}</div>
      <div class="val text-base">${hdc.labels[L] || 0}</div>
      <div class="hint">${LBL_DESC[L]}</div>
    </div>`)
    .join('');
  const win = buildHdcIndex(hdcRows).window;
  return `<div class="card p-4 mb-4">
    <div class="font-semibold mb-2"${tip('hdc_block')}>HDC supply &amp; labels — last 7 days</div>
    <div class="flex flex-wrap gap-4 mb-3 text-sm">
      <div${tip('hdc_supply')}>Supply: <b>${hdc.supply}</b></div>
      <div${tip('hdc_count')}>HDC (L0): <b>${hdc.hdc}</b></div>
      <div${tip('hdc_rate')}>HDC rate: <b>${hdc.hdcRatePct != null ? hdc.hdcRatePct + '%' : '—'}</b></div>
      <div${tip('hdc_avglevel')}>Avg label level: <b>${hdc.avgLevel != null ? 'L' + hdc.avgLevel.toFixed(2) : '—'}</b></div>
    </div>
    <div class="grid grid-cols-4 sm:grid-cols-7 gap-2">${cells}</div>
    <div class="hint mt-2">Window: ${fmtDate(win?.lower)} → ${fmtDate(win?.upper)} (today excluded). L0 = HDC; lower is better, L0→L5 worsening, L6 edge-case.</div>
  </div>`;
}

export function last10Table(eps) {
  const sorted = [...eps]
    .sort((a, b) => {
      const da = new Date(pickv(a, 'approved_dt', 'publish_date')),
        db = new Date(pickv(b, 'approved_dt', 'publish_date'));
      if (db - da) return db - da;
      return (num(b.ep_num) || 0) - (num(a.ep_num) || 0);
    })
    .slice(0, 10);
  const rows = sorted
    .map((e) => {
      // Raw retention columns are STEP-WISE RELATIVE (each checkpoint as a % of the
      // previous: mid = % of 30s-viewers who reached 50%, end = % of those who reached
      // 70%). The guardrails are CUMULATIVE (% of original starters), so convert by
      // multiplying through: cum_mid = hook×mid, cum_end = hook×mid×end.
      const hookR = num(e.hook_retention_pct) ?? num(e.hook_retention_h123_pct);
      const midR = num(e.mid_retention_pct) ?? num(e.mid_retention_h123_pct);
      const endR = num(e.end_retention_pct) ?? num(e.end_retention_h123_pct);
      const hook = hookR;
      const mid = hookR != null && midR != null ? (hookR * midR) / 100 : midR;
      const end = hookR != null && midR != null && endR != null ? (hookR * midR * endR) / 10000 : endR;
      const d0 = num(e.d0_views) ?? num(e.d0_unique_viewers);
      // H123 views = latest CMS `starts`. The Fatigue query now sources h123_unique_viewers
      // from content_metrics_run_log_v2; `views`/`starts` are accepted if named that instead.
      const h123 = num(pickv(e, 'views', 'starts', 'h123_unique_viewers'));
      // Completion efficiency H123 = completion ÷ target × 100. Use comp_eff_h123_pct if
      // present, else derive from completion ÷ target (CMS completion_rate preferred).
      let ce = num(e.comp_eff_h123_pct);
      if (ce == null) {
        const compRate = num(e.completion_rate) ?? num(e.h123_completion_rate_pct);
        const tc = num(e.targ_comp);
        if (compRate != null && tc) ce = Math.round((compRate / tc) * 100 * 100) / 100;
      }
      // Data-backed guardrail for this episode's length: exact min retention each
      // checkpoint must hold. Colour each cell against its own floor; show the floor.
      const g = retentionGuardrail(num(e.video_duration_sec) ?? num(e.duration_s));
      const cell = (v, min) =>
        `<td style="color:${retClass(v, min)};font-weight:600">${v != null ? fmtPct(v, 0) : '—'}${min != null ? `<div class="hint" style="font-weight:400">min ${min}%</div>` : ''}</td>`;
      const title = e.series_title || e.title || '—';
      // H123 views = the latest CMS snapshot's `starts` (views), used as-is regardless
      // of snapshot_tag (D1/D12/D123 etc.) — the freshest available reading is the H123 number.
      const h123Cell = h123 != null ? fmtNum(h123) : '—';
      return `<tr>
      <td>${fmtDate(pickv(e, 'approved_dt', 'publish_date'))}</td>
      <td title="${esc(title)}">${esc(title)}</td>
      <td>${d0 != null ? fmtNum(d0) : '—'}</td>
      <td>${h123Cell}</td>
      <td>${outcomeChip(e.video_outcome, e.video_status, e.comp_verdict)}</td>
      <td>${ce != null ? fmtPct(ce, 0) : '—'}</td>
      ${cell(hook, g?.hook)}${cell(mid, g?.mid)}${cell(end, g?.end)}
      <td>${failChip(failureFromGuardrail(hook, mid, end, g) ?? e.failure_mode)}</td>
    </tr>`;
    })
    .join('');
  return `<div class="card p-4">
    <div class="font-semibold mb-2">Last 10 episodes</div>
    <div class="overflow-x-auto"><table class="data-table">
      <thead><tr>
        <th${tip('approved')}>Approved</th>
        <th${tip('series_title')}>Series title</th>
        <th${tip('d0views')}>D0 views</th>
        <th${tip('h123views')}>H123 views</th>
        <th${tip('outcome')}>Outcome</th>
        <th${tip('comp_eff')}>Comp eff H123</th>
        <th${tip('hook_ret')}>Hook ret</th>
        <th${tip('mid_ret')}>Mid ret</th>
        <th${tip('end_ret')}>End ret</th>
        <th${tip('failure')}>Failure</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="hint mt-1">Retention vs the data-backed minimum for each video's length (Hook @30s · Mid @50% · End @70%): <span style="color:#2A9D8F">≥ min (on track to beat target)</span> · <span style="color:#D97706">within 5pp</span> · <span style="color:#E63946">below min</span>. "min %" under each value is that floor.</div>
  </div>`;
}

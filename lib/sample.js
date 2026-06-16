// Built-in sample data — ported verbatim from the original tool.
import { hdcRefToday } from './hdc';
import { addDays } from './format';

export function sampleData() {
  function evRow(o) {
    return Object.assign(
      {
        language: 'hi', category_id: 1, category_name: 'Mythology', show_type: 'main', state: 'active',
        period_type: 'LAST_3_CALENDAR_WEEK', period_name: 'CURRENT_WEEK', period_number: 3, threshold_used: 'category_x_language', peer_count: 18,
        language_users: 50000, show_watch_hours: 1200, language_watch_hours: 90000, show_wh_contrib_pct_of_language: 1.2,
        weak_below_users_contrib_pct: 0.9, launch_trajectory: 'stable', recent_trajectory: 'stable', confidence: 'high',
        stop_below_users_contrib_pct: 0.6, retain_above_users_contrib_pct: 1.5, strong_above_users_contrib_pct: 2.2,
        stop_below_show_users: 200, weak_below_show_users: 350, retain_above_show_users: 700, strong_above_show_users: 1100,
        period_contrib_status: 'continue_observing', period_user_status: 'continue_observing',
        lw1_contrib_pct: null, lw2_contrib_pct: null, lw3_contrib_pct: null, lw4_contrib_pct: null,
        l3w_minus_3_contrib_pct: 1.3, l3w_minus_2_contrib_pct: 1.2, l3w_minus_1_contrib_pct: 1.1, experimental_decision: 'INSUFFICIENT_DATA',
        latest_relaunch_date: null, is_relaunch_run: false, decision_reason: '',
      },
      o
    );
  }
  function fatRow(o) {
    return Object.assign(
      {
        series_id: 1, show_state: 'active', language: 'hi', category_title: 'Mythology', approved_dt: '2026-06-01', ep_num: 10, week_num: 4,
        d0_views: 500, d0_unique_viewers: 500, h123_unique_viewers: 700, d0_completion_rate_pct: 55, h123_completion_rate_pct: 62, targ_comp: 60,
        failure_mode: 'OK', video_status: 1, video_outcome: 'success', category_reach_rate_pct: 3.1,
        show_n_videos_4w: 10, show_avg_d0_views: 480, show_avg_h123_views: 660, show_avg_hook_retention_pct: 72, show_avg_mid_retention_pct: 64, show_avg_end_retention_pct: 70,
        show_hook_fail_cnt_10eps: 0, show_pace_fail_cnt_10eps: 0, show_ending_fail_cnt_10eps: 0, ok_cnt: 10, show_failure_evaluable_eps_cnt: 10,
        category_demand_density_sec_per_ep: 4200, show_d0_viewers_pct_change_4w: 2,
        show_avg_category_reach_rate_pct: 3.1, show_avg_category_reach_delta_pct: -2.5,
      },
      o
    );
  }

  const evals = [
    evRow({ show_id: 101, show_title: 'Mahabharata Tales', show_verdict: 'below_stop_threshold', recent_trajectory: 'declining', l3w_current_contrib_pct: 0.45, show_users: 180, period_contrib_status: 'below_stop_threshold' }),
    evRow({ show_id: 102, show_title: 'Ramayana Nightly', show_verdict: 'below_stop_threshold', recent_trajectory: 'declining', l3w_current_contrib_pct: 0.5, show_users: 210, period_contrib_status: 'below_stop_threshold' }),
    evRow({ show_id: 103, show_title: 'Astro Daily', category_id: 2, category_name: 'Astrology', show_verdict: 'retain_or_scale', recent_trajectory: 'improving', l3w_current_contrib_pct: 1.8, show_users: 820, period_contrib_status: 'meets_retain_threshold' }),
    evRow({ show_id: 104, show_title: 'Startup Diaries', category_id: 73, category_name: 'Business', show_type: 'experimental', experimental_decision: 'PROMOTE', lw1_contrib_pct: 1.6, lw2_contrib_pct: 1.8, lw3_contrib_pct: 2.0, lw4_contrib_pct: 2.1, l3w_current_contrib_pct: 2.0, show_users: 900, show_verdict: 'very_strong', period_contrib_status: 'very_strong' }),
    evRow({ show_id: 105, show_title: 'Comedy Hour', category_name: 'Comedy', show_verdict: 'very_strong', recent_trajectory: 'stable', l3w_current_contrib_pct: 2.4, show_users: 1300, period_contrib_status: 'very_strong' }),
    evRow({ show_id: 106, show_title: 'History Untold', category_name: 'History', state: 'inactive', show_verdict: 'continue_observing', recent_trajectory: 'declining', l3w_current_contrib_pct: 1.0, show_users: 430, period_contrib_status: 'continue_observing' }),
    evRow({ show_id: 107, show_title: 'Lifestyle Lite (eval-only)', category_name: 'Lifestyle', show_verdict: 'continue_observing', l3w_current_contrib_pct: 1.1, show_users: 460 }),
    evRow({ show_id: 109, show_title: 'Video Editing Pro', category_id: 88, category_name: 'Editing', show_type: 'experimental', experimental_decision: 'LOW_CONFIDENCE', recent_trajectory: 'insufficient_data', confidence: 'low', peer_count: 6, l3w_current_contrib_pct: 0.38, show_users: 120, show_verdict: 'below_stop_threshold', period_contrib_status: 'below_stop_threshold', decision_reason: 'In the bottom 25% of hi shows. Pulls only 0.38% of language users on a thin peer set.' }),
    evRow({ show_id: 110, show_title: 'Yoga Basics (exp)', language: 'ml', category_id: 2, category_name: 'Devotion', show_type: 'experimental', experimental_decision: 'CONTINUE', recent_trajectory: 'stable', confidence: 'medium', peer_count: 12, l3w_current_contrib_pct: 0.9, show_users: 300, show_verdict: 'continue_observing', period_contrib_status: 'continue_observing', decision_reason: 'Holding mid-pack among Malayalam shows — keep observing another week.' }),
    evRow({ show_id: 636, show_title: 'Bhagavad Gita', language: 'ml', category_id: 2, category_name: 'Devotion', state: 'active', recent_trajectory: 'declining', confidence: 'low', l3w_current_contrib_pct: 0.53, show_users: 44, show_verdict: 'below_stop_threshold', period_contrib_status: 'below_stop_threshold', decision_reason: 'Below the peer stop bar with no fixable creative pattern — review for stop or hiatus.' }),
    evRow({ show_id: 112, show_title: 'Draft Show (should be hidden)', category_name: 'Misc', recent_trajectory: 'declining', l3w_current_contrib_pct: 0.3, show_users: 50, show_verdict: 'below_stop_threshold', period_contrib_status: 'below_stop_threshold' }),
  ];
  const fats = [
    fatRow({ show_id: 101, show_title: 'Mahabharata Tales', show_dominant_failure_mode: 'OK', show_action_recommendation: 'SHUTDOWN_CANDIDATE', show_6day_return_rate_pct: 22, show_avg_saturation_pct: 38, comp_pass_rate_7eps_pct: 30, show_fatigue_score: -1.4, show_fatigue_zone: 'red', show_remarks: 'Comp pass 2/7 | 6d return 22% | demand thin.', show_avg_hook_retention_pct: 60, show_avg_mid_retention_pct: 55, show_avg_end_retention_pct: 58, ok_cnt: 10 }),
    fatRow({ show_id: 102, show_title: 'Ramayana Nightly', show_dominant_failure_mode: 'HOOK', show_action_recommendation: 'HOOK_FIX', show_6day_return_rate_pct: 34, show_avg_saturation_pct: 55, comp_pass_rate_7eps_pct: 48, show_fatigue_score: -0.6, show_fatigue_zone: 'yellow', show_remarks: 'Hook failing on 6/10 eps — cold opens weak.', show_avg_hook_retention_pct: 41, show_avg_mid_retention_pct: 66, show_avg_end_retention_pct: 72, show_hook_fail_cnt_10eps: 6, ok_cnt: 4, show_failure_evaluable_eps_cnt: 10 }),
    fatRow({ show_id: 103, show_title: 'Astro Daily', category_title: 'Astrology', show_dominant_failure_mode: 'OK', show_action_recommendation: 'CADENCE_UP', show_6day_return_rate_pct: 58, show_avg_saturation_pct: 92, comp_pass_rate_7eps_pct: 74, show_fatigue_score: 1.1, show_fatigue_zone: 'green', show_remarks: 'Saturated at 92% — audience wants more.', show_avg_hook_retention_pct: 78, show_avg_mid_retention_pct: 70, show_avg_end_retention_pct: 74, ok_cnt: 10 }),
    fatRow({ show_id: 104, show_title: 'Startup Diaries', show_state: 'experimental', category_title: 'Business', show_dominant_failure_mode: 'PACE', show_action_recommendation: 'PACE_FIX', show_6day_return_rate_pct: 46, show_avg_saturation_pct: 60, comp_pass_rate_7eps_pct: 62, show_fatigue_score: 0.2, show_fatigue_zone: 'green', show_remarks: 'Promotable but mid drop-off on 5/10.', show_avg_hook_retention_pct: 70, show_avg_mid_retention_pct: 48, show_avg_end_retention_pct: 69, show_pace_fail_cnt_10eps: 5, ok_cnt: 5, show_failure_evaluable_eps_cnt: 10 }),
    fatRow({ show_id: 105, show_title: 'Comedy Hour', category_title: 'Comedy', show_dominant_failure_mode: 'OK', show_action_recommendation: 'HOLD', show_6day_return_rate_pct: 61, show_avg_saturation_pct: 70, comp_pass_rate_7eps_pct: 80, show_fatigue_score: 1.3, show_fatigue_zone: 'green', show_remarks: 'Healthy on every axis.', show_avg_hook_retention_pct: 80, show_avg_mid_retention_pct: 74, show_avg_end_retention_pct: 78, ok_cnt: 10 }),
    fatRow({ show_id: 106, show_title: 'History Untold', category_title: 'History', show_state: 'inactive', show_dominant_failure_mode: 'OK', show_action_recommendation: 'CADENCE_DOWN', show_6day_return_rate_pct: 40, show_avg_saturation_pct: 35, comp_pass_rate_7eps_pct: 55, show_fatigue_score: -0.3, show_fatigue_zone: 'yellow', show_remarks: 'Over-publishing — saturation only 35%.', show_avg_hook_retention_pct: 66, show_avg_mid_retention_pct: 60, show_avg_end_retention_pct: 64, ok_cnt: 9, show_failure_evaluable_eps_cnt: 9 }),
    fatRow({ show_id: 108, show_title: 'Quick Bites (fatigue-only)', category_title: 'Self-help', show_dominant_failure_mode: 'ENDING', show_action_recommendation: 'ENDING_FIX', show_6day_return_rate_pct: 44, show_avg_saturation_pct: 58, comp_pass_rate_7eps_pct: 57, show_fatigue_score: -0.2, show_fatigue_zone: 'yellow', show_remarks: 'Ending drop-off on 5/10 — no peer data.', show_avg_hook_retention_pct: 71, show_avg_mid_retention_pct: 67, show_avg_end_retention_pct: 45, show_ending_fail_cnt_10eps: 5, ok_cnt: 5, show_failure_evaluable_eps_cnt: 10 }),
  ];

  function epExpand(base) {
    const dom = base.show_dominant_failure_mode;
    const failTag = dom === 'HOOK' ? 'HOOK_FAIL' : dom === 'PACE' ? 'PACE_FAIL' : dom === 'ENDING' ? 'ENDING_FAIL' : null;
    const j = (b, d) => Math.max(5, Math.min(99, Math.round(b + d))); // retention %
    const v = (b, d) => Math.max(1, Math.round((b || 0) + d)); // view counts (uncapped)
    const out = [];
    for (let i = 0; i < 10; i++) {
      const ep = 10 - i,
        dt = new Date('2026-06-08');
      dt.setDate(dt.getDate() - i * 3);
      const fail = failTag && i % 2 === 0;
      const fm = fail ? failTag : 'OK';
      out.push(
        Object.assign({}, base, {
          ep_num: ep,
          approved_dt: dt.toISOString().slice(0, 10),
          series_title: `${base.show_title || 'Episode'} — Ep ${ep}`,
          d0_views: v(base.show_avg_d0_views || 400, (2 - i) * 15),
          d0_unique_viewers: v(base.show_avg_d0_views || 400, (2 - i) * 15),
          h123_unique_viewers: v(base.show_avg_h123_views || (base.show_avg_d0_views || 400) * 1.4, (2 - i) * 22),
          hook_retention_pct: fm === 'HOOK_FAIL' ? j(base.show_avg_hook_retention_pct, -22) : j(base.show_avg_hook_retention_pct, (i % 3 - 1) * 3),
          mid_retention_pct: fm === 'PACE_FAIL' ? j(base.show_avg_mid_retention_pct, -20) : j(base.show_avg_mid_retention_pct, (i % 3 - 1) * 3),
          end_retention_pct: fm === 'ENDING_FAIL' ? j(base.show_avg_end_retention_pct, -24) : j(base.show_avg_end_retention_pct, (i % 3 - 1) * 3),
          comp_eff_h123_pct: fail ? j(80, (i % 3 - 1) * 4) : j(102, (i % 3 - 1) * 4),
          failure_mode: fm,
          video_status: fail ? 0 : 1,
          video_outcome: fail ? 'failed' : 'success',
          // CMS snapshot fields (content_metrics_run_log_v2): latest `starts` = H123 views.
          views: v(base.show_avg_h123_views || (base.show_avg_d0_views || 400) * 1.4, (2 - i) * 22),
          completion_rate: fail ? j(base.show_avg_end_retention_pct, -10) : j(base.show_avg_end_retention_pct, 4),
          comp_verdict: fail ? 'FAIL' : 'PASS',
          snapshot_tag: 'D123',
          // ~2–2.5 min videos (guardrail bucket: hook 70 / mid 55 / end 47)
          video_duration_sec: 140,
        })
      );
    }
    return out;
  }
  const fatExpanded = [];
  fats.forEach((b) => epExpand(b).forEach((r) => fatExpanded.push(r)));

  // HDC label sample: per-series rows in the last-7-day window for a few shows.
  const today = hdcRefToday();
  const d = (off) => addDays(today, -off);
  const hdcPlan = {
    101: ['L3', 'L4', 'L5', 'L5'], 103: ['L0', 'L0', 'L1', 'L2', 'L3'], 104: ['L0', 'L1', 'L4'],
    105: ['L0', 'L0', 'L0', 'L2'], 106: ['L5', 'L5', 'L4'], 102: ['L2', 'L3', 'L4', 'L1', 'L5'],
  };
  const titles = { 101: 'Mahabharata Tales', 102: 'Ramayana Nightly', 103: 'Astro Daily', 104: 'Startup Diaries', 105: 'Comedy Hour', 106: 'History Untold' };
  const hdc = [];
  let sid = 9000;
  Object.entries(hdcPlan).forEach(([show, labels]) => {
    labels.forEach((L, i) => {
      hdc.push({
        publish_date: d(2 + (i % 7)), language: 'hi', bu_name: 'Skill', series_id: ++sid,
        series_title: titles[show] + ' ep', show_id: +show, show_name: titles[show],
        views_24h: 300, watch_hours: 20, p90_views_24h: 280, threshold_value: 280,
        target_completion_rate: 40, achieved_completion_rate: 45,
        view_threshold: L === 'L0' || L === 'L1' ? 1 : 0, cr_threshold: L === 'L0' || L === 'L2' ? 1 : 0,
        HDC_threshold: L === 'L0' ? 1 : 0, Label: L,
      });
    });
  });

  const ts = [
    { show_id: 101, show_title: 'Mahabharata Tales', language: 'hi', category_title: 'Mythology', unique_users: 140, video_plays: 320, watch_hours: 21.4, avg_min_per_play: 4.01 },
    { show_id: 102, show_title: 'Ramayana Nightly', language: 'hi', category_title: 'Mythology', unique_users: 180, video_plays: 410, watch_hours: 33.2, avg_min_per_play: 4.86 },
    { show_id: 103, show_title: 'Astro Daily', language: 'hi', category_title: 'Astrology', unique_users: 760, video_plays: 2100, watch_hours: 196.0, avg_min_per_play: 5.6 },
    { show_id: 104, show_title: 'Startup Diaries', language: 'hi', category_title: 'Business', unique_users: 880, video_plays: 1980, watch_hours: 171.6, avg_min_per_play: 5.2 },
    { show_id: 105, show_title: 'Comedy Hour', language: 'hi', category_title: 'Comedy', unique_users: 1250, video_plays: 3400, watch_hours: 357.0, avg_min_per_play: 6.3 },
    { show_id: 106, show_title: 'History Untold', language: 'hi', category_title: 'History', unique_users: 400, video_plays: 700, watch_hours: 39.7, avg_min_per_play: 3.4 },
  ];

  // Daily audience by in-app launch surface — 30 days for a few shows, so the
  // Deep Dive "Daily audience by surface" chart has something to draw.
  const aud = [];
  const audPlan = {
    103: { home: 540, player_autoplay: 300, search: 120, category: 90, push: 70 },   // Astro Daily — home-led
    104: { home: 260, player_autoplay: 180, push: 320, search: 80, new_n_hot: 60 },  // Startup Diaries — push-heavy
    105: { home: 980, player_autoplay: 520, search: 160, category: 130, library: 90 }, // Comedy Hour — big, balanced
    102: { home: 220, player_autoplay: 140, search: 60, push: 50, shared: 25 },       // Ramayana Nightly
  };
  Object.entries(audPlan).forEach(([show, base]) => {
    for (let i = 29; i >= 1; i--) {
      const date_ = addDays(today, -i);
      const wobble = 0.75 + ((i * 7 + (+show % 5)) % 11) / 20; // deterministic 0.75–1.25
      const trend = 1 + (15 - i) / 80; // gentle rise toward recent days
      Object.entries(base).forEach(([surface, b]) => {
        const views = Math.max(0, Math.round(b * wobble * trend));
        if (views === 0) return;
        aud.push({ show_id: +show, date_, surface, views, users: Math.max(1, Math.round(views * 0.62)) });
      });
    }
  });

  // Next-day return rates by viewer recency (NURR/CURR/RURR/SURR), one row per show.
  const ret = [
    { show_id: 103, nurr_base: 1200, nurr_pct: 18.4, curr_base: 640, curr_pct: 61.2, rurr_base: 210, rurr_pct: 34.8, surr_base: 95, surr_pct: 22.1, total_active_on_ref: 2145 },
    { show_id: 104, nurr_base: 980, nurr_pct: 15.1, curr_base: 520, curr_pct: 55.7, rurr_base: 160, rurr_pct: 29.4, surr_base: 70, surr_pct: 18.6, total_active_on_ref: 1730 },
    { show_id: 105, nurr_base: 1500, nurr_pct: 21.0, curr_base: 900, curr_pct: 66.3, rurr_base: 300, rurr_pct: 38.0, surr_base: 140, surr_pct: 25.4, total_active_on_ref: 2840 },
    { show_id: 102, nurr_base: 320, nurr_pct: 12.5, curr_base: 180, curr_pct: 48.9, rurr_base: 60, rurr_pct: 23.3, surr_base: 25, surr_pct: 16.0, total_active_on_ref: 585 },
  ];

  const meta = [
    { show_id: 104, language: 'hi', show_name: 'Startup Diaries', show_type: 'experimental', state: 'active', category_id: 73, category_name: 'Business', bu_name: 'Income', show_manager: 'Priya', designer_name: 'Arjun K', freq: 'WEEKLY', specific_freq: 'Mon | Thu' },
    { show_id: 636, language: 'ml', show_name: 'Bhagavad Gita', show_type: 'main', state: 'active', category_id: 2, category_name: 'Devotion', bu_name: 'Awareness', show_manager: 'Nisha', designer_name: 'Ravi M', freq: 'DAILY', specific_freq: 'Mon | Tue | Wed | Thu | Fri' },
    { show_id: 112, language: 'hi', show_name: 'Draft Show (should be hidden)', show_type: 'main', state: 'draft', category_id: 1, category_name: 'Misc', bu_name: 'Skill', show_manager: 'Test', designer_name: 'Test', freq: null, specific_freq: '' },
  ];

  // Daily RCA sample (v2 label-led): one segment row per level × segment, plus SHOW rows.
  const rcaRow = (o) => Object.assign({
    report_date: '2026-06-15', hdc_report_date: '2026-06-13', level: 'TOTAL', segment: 'overall_httmk',
    show_name: null, show_manager: null,
    // labels (settled day)
    supply: 20, l0: 5, l1: 4, l2: 2, l3: 2, l4: 4, l5: 3, l6: 0, l0_pct: 25, l4l5_pct: 35,
    hdc_count_7davg: 6, supply_7davg: 20, l0_pct_7davg: 30, label_is_settled: true,
    hdc_7d: 35, supply_7d_seg: 140, l4l5_7d: 49, hdc_contribution_pct_7d: 25, l4l5_pct_7d: 35,
    hdc_verdict: 'normal', hdc_attribution: null, comovement_pattern: 'aligned/normal',
    // DAU
    dau: 50000, dau_7davg: 51000, dau_7davg_pct: -2.0, dau_verdict: 'normal', mins_per_dau: 18.4,
    // SR
    sr_pct: 62, sr_7davg: 60, sr_verdict: 'normal', avg_cr: 58, avg_targ_cr: 60,
    corr_hdc_dau: 0.42, corr_sr_dau: 0.18, corr_hdc_sr: 0.55,
    // show-only (null on segment rows)
    show_supply_7d: null, show_freq: null, show_supply_vs_freq_pct: null, show_active_status: null,
    bu_l0_pct: null, bu_l4l5_pct: null, poor_l0_flag: null, high_l45_flag: null, needs_supply_fix_flag: null,
    show_recommendation: null, auto_rca: '',
  }, o);
  const rca = [
    // 2026-06-13 (latest settled)
    rcaRow({ level: 'TOTAL', segment: 'overall_httmk', supply: 110, l0: 2, l1: 8, l2: 6, l3: 14, l4: 45, l5: 35, l0_pct: 1.8, l4l5_pct: 72.7,
      hdc_count: 2, hdc_count_7davg: 6.1, supply_7davg: 89, l0_pct_7davg: 12.9, hdc_7d: 28, supply_7d_seg: 760, hdc_contribution_pct_7d: 3.7, l4l5_pct_7d: 64,
      hdc_verdict: 'HDC_DROP', hdc_attribution: 'HDC down mainly DISTRIBUTION/REACH (L3–L5 heavy — recommendations/thumbnails/topics)',
      dau: 198000, dau_dod: 210000, dau_sdlw: 209000, dau_7davg: 207000, dau_dod_pct: -5.7, dau_sdlw_pct: -5.3, dau_7davg_pct: -4.3, dau_verdict: 'REAL_DROP',
      dau_organic: 120000, dau_organic_dod: 122000, dau_push: 40000, dau_push_dod: 52000, dau_moe: 30000, dau_moe_dod: 28000, dau_whatsapp: 8000, dau_whatsapp_dod: 8000,
      dau_new: 18000, dau_new_dod: 27000, dau_retained: 150000, dau_retained_dod: 151000, dau_resurrected: 30000, dau_resurrected_dod: 32000,
      dau_d0: 9000, dau_d0_dod: 9500, dau_d1_d3: 22000, dau_d1_d3_dod: 31000, dau_d4_d7: 26000, dau_d4_d7_dod: 27000, dau_d8_d14: 31000, dau_d8_d14_dod: 31500, dau_d15_d30: 40000, dau_d15_d30_dod: 41000, dau_d30_plus: 70000, dau_d30_plus_dod: 70000,
      top_surface_drops: 'home>for_you (-9000) | search>results (-2200)', peak_drop_hour: '20:00 (-3100 vs 7dAvg)',
      sr_pct: 87.8, sr_7davg: 80, comovement_pattern: 'CONTENT-LED DECLINE: HDC+SR+DAU all down — fresh content weak AND it is pulling DAU down' }),
    rcaRow({ level: 'LANGUAGE', segment: 'hi', supply: 54, l0: 3, l1: 12, l2: 8, l3: 15, l4: 8, l5: 8, l0_pct: 5.6, l4l5_pct: 30,
      hdc_count: 3, hdc_count_7davg: 6.7, supply_7davg: 49.6, l0_pct_7davg: 13.9, hdc_7d: 110, supply_7d_seg: 480, hdc_contribution_pct_7d: 22.9, l4l5_pct_7d: 38,
      top_surface_drops: 'notification>title_image (-292) | online_earning>home_rail (-199) | youtube>home_rail (-165)', peak_drop_hour: '22:00 (-124 vs 7dAvg)',
      hdc_verdict: 'HDC_DROP', hdc_attribution: 'HDC down mainly CONTENT (L1 reach-but-no-completion — hook/pacing/target CR)',
      dau: 150000, dau_7davg: 149000, dau_7davg_pct: 0.7, dau_verdict: 'normal', sr_pct: 54, sr_7davg: 60,
      comovement_pattern: 'LEADING RISK: HDC down but DAU still holding on catalog — expect DAU softness if it persists' }),
    rcaRow({ level: 'BU', segment: 'Awareness', supply: 22, l0: 0, l1: 3, l2: 2, l3: 4, l4: 9, l5: 8, l0_pct: 0, l4l5_pct: 77,
      hdc_count: 0, hdc_count_7davg: 2, supply_7davg: 20, l0_pct_7davg: 10, hdc_7d: 14, supply_7d_seg: 154, hdc_contribution_pct_7d: 9, l4l5_pct_7d: 60,
      hdc_verdict: 'HDC_DROP', hdc_attribution: 'HDC down mainly DISTRIBUTION/REACH (L3–L5 heavy — recommendations/thumbnails/topics)', dau: 90000, dau_7davg: 92000, dau_7davg_pct: -2.2, dau_verdict: 'soft_drop', sr_pct: 52, sr_7davg: 59 }),
    rcaRow({ level: 'BU', segment: 'Income', supply: 20, l0: 2, l1: 4, l2: 3, l3: 5, l4: 3, l5: 3, l0_pct: 10, l4l5_pct: 30,
      hdc_count: 2, hdc_count_7davg: 2, supply_7davg: 18, l0_pct_7davg: 11, hdc_7d: 14, supply_7d_seg: 130, hdc_contribution_pct_7d: 11, l4l5_pct_7d: 28,
      hdc_verdict: 'normal', dau: 30000, dau_7davg: 28000, dau_7davg_pct: 7.1, dau_verdict: 'soft_rise', sr_pct: 64, sr_7davg: 58 }),
    rcaRow({ level: 'BU', segment: 'Skill', supply: 12, l0: 1, l1: 2, l2: 1, l3: 5, l4: 2, l5: 1, l0_pct: 8.3, l4l5_pct: 25,
      hdc_count: 1, hdc_count_7davg: 3.3, supply_7davg: 12, l0_pct_7davg: 26.5, hdc_7d: 14, supply_7d_seg: 84, hdc_contribution_pct_7d: 17, l4l5_pct_7d: 30,
      hdc_verdict: 'HDC_DROP', hdc_attribution: 'HDC down mainly DISTRIBUTION/REACH (L3–L5 heavy — recommendations/thumbnails/topics)', dau: 30000, dau_7davg: 29000, dau_7davg_pct: 3.4, dau_verdict: 'soft_rise', sr_pct: 60, sr_7davg: 60,
      top_surface_drops: 'notification>title_image (-265) | youtube>home_rail (-164) | video_player>top_series (-100)' }),
    rcaRow({ level: 'LANGUAGE', segment: 'te', supply: 15, l0: 4, l1: 2, l2: 2, l3: 2, l4: 3, l5: 2, l0_pct: 27, l4l5_pct: 33, hdc_count: 4, hdc_count_7davg: 5, hdc_contribution_pct_7d: 27, l4l5_pct_7d: 33, hdc_verdict: 'normal', dau: 24000, dau_7davg: 24500, dau_7davg_pct: -2.0 }),
    rcaRow({ level: 'LANGUAGE', segment: 'ta', supply: 12, l0: 2, l1: 2, l2: 1, l3: 2, l4: 3, l5: 2, l0_pct: 17, l4l5_pct: 42, hdc_count: 2, hdc_count_7davg: 4, hdc_contribution_pct_7d: 17, l4l5_pct_7d: 42, hdc_verdict: 'HDC_DROP', hdc_attribution: 'HDC down mainly SUPPLY (fewer launches)', dau: 18000, dau_7davg: 18200, dau_7davg_pct: -1.1 }),
    rcaRow({ level: 'LANGUAGE', segment: 'ml', supply: 10, l0: 3, l1: 1, l2: 1, l3: 2, l4: 2, l5: 1, l0_pct: 30, l4l5_pct: 30, hdc_count: 3, hdc_count_7davg: 3, hdc_contribution_pct_7d: 30, l4l5_pct_7d: 30, hdc_verdict: 'normal', dau: 9000, dau_7davg: 9100, dau_7davg_pct: -1.1 }),
    rcaRow({ level: 'LANGUAGE', segment: 'kn', supply: 8, l0: 2, l1: 1, l2: 1, l3: 1, l4: 2, l5: 1, l0_pct: 25, l4l5_pct: 38, hdc_count: 2, hdc_count_7davg: 2, hdc_contribution_pct_7d: 25, l4l5_pct_7d: 38, hdc_verdict: 'normal', dau: 9000, dau_7davg: 9000, dau_7davg_pct: 0 }),
    // report run 2026-06-14 (previous settled day — second dropdown option; HDC for D-2 = 06-12)
    rcaRow({ report_date: '2026-06-14', hdc_report_date: '2026-06-12', level: 'TOTAL', segment: 'overall_httmk', supply: 108, l0: 30, l1: 10, l2: 8, l3: 15, l4: 25, l5: 20, l0_pct: 27.8, l4l5_pct: 41.7, hdc_count: 30, hdc_count_7davg: 30, hdc_contribution_pct_7d: 27, l4l5_pct_7d: 42, hdc_verdict: 'normal', dau: 205000, dau_7davg: 204000, dau_7davg_pct: 0.5, sr_pct: 61, sr_7davg: 60 }),
    rcaRow({ report_date: '2026-06-14', hdc_report_date: '2026-06-12', level: 'LANGUAGE', segment: 'hi', supply: 68, l0: 20, l1: 8, l2: 6, l3: 10, l4: 14, l5: 10, l0_pct: 29, l4l5_pct: 35, hdc_count: 20, hdc_count_7davg: 20, hdc_contribution_pct_7d: 29, l4l5_pct_7d: 35, hdc_verdict: 'normal', dau: 149000, dau_7davg: 148000, dau_7davg_pct: 0.7 }),
    // report run 2026-06-16 (latest — labels still settling; HDC for D-2 = 06-14)
    rcaRow({ report_date: '2026-06-16', hdc_report_date: '2026-06-14', level: 'TOTAL', segment: 'overall_httmk', label_is_settled: false, supply: 95, l0: 0, l1: 0, l2: 0, l3: 0, l4: 0, l5: 0, l0_pct: 0, l4l5_pct: 0, hdc_count: 0, hdc_rate: 0, hdc_count_7davg: 29, hdc_verdict: 'still_settling', hdc_contribution_pct_7d: null, dau: 208000, dau_7davg: 206000, dau_7davg_pct: 1.0, sr_pct: null, sr_verdict: 'still_tracking_72h', comovement_pattern: 'insufficient_baseline', auto_rca: 'HDC still settling (95 launched).' }),
    rcaRow({ report_date: '2026-06-16', hdc_report_date: '2026-06-14', level: 'LANGUAGE', segment: 'hi', label_is_settled: false, supply: 60, l0: 0, l1: 0, l2: 0, l3: 0, l4: 0, l5: 0, l0_pct: 0, l4l5_pct: 0, hdc_count: 0, hdc_rate: 0, hdc_count_7davg: 19, hdc_verdict: 'still_settling', hdc_contribution_pct_7d: null, dau: 150000, dau_7davg: 149000, dau_7davg_pct: 0.7 }),
    // SHOW rows (level='SHOW', Hindi, trailing 7d) — triage flags
    rcaRow({ level: 'SHOW', report_date: '2026-06-15', hdc_report_date: '2026-06-13', segment: 'Awareness', show_name: 'Vishnu Puran', show_manager: 'Nancy (2)', supply: 6, l0: 0, l1: 1, l2: 0, l3: 1, l4: 2, l5: 2, l0_pct: 0, l4l5_pct: 66.7, show_supply_7d: 6, show_freq: 7, show_supply_vs_freq_pct: 86, show_active_status: 'Active', bu_l0_pct: 15, bu_l4l5_pct: 45, poor_l0_flag: 1, high_l45_flag: 1, needs_supply_fix_flag: 0, hdc_verdict: 'POOR_L0', show_recommendation: 'HIT-RATE: L0 0% vs BU 15% — rework formats/hooks. TAIL: L4+L5 66.7% vs BU 45% — review topics/thumbnails/discovery.' }),
    rcaRow({ level: 'SHOW', report_date: '2026-06-15', hdc_report_date: '2026-06-13', segment: 'Skill', show_name: 'Editing Mastery', show_manager: 'Kartikey (2)', supply: 4, l0: 0, l1: 0, l2: 1, l3: 1, l4: 1, l5: 1, l0_pct: 0, l4l5_pct: 50, show_supply_7d: 4, show_freq: 7, show_supply_vs_freq_pct: 57, show_active_status: 'Inactive', bu_l0_pct: 20, bu_l4l5_pct: 33, poor_l0_flag: 1, high_l45_flag: 0, needs_supply_fix_flag: 1, hdc_verdict: 'POOR_L0', show_recommendation: 'SUPPLY: 4/7 wk (57% of target) — raise output. HIT-RATE: L0 0% vs BU 20% — rework formats/hooks.' }),
    rcaRow({ level: 'SHOW', report_date: '2026-06-15', hdc_report_date: '2026-06-13', segment: 'Income', show_name: 'Stock Market Daily', show_manager: 'Dhananjay (4)', supply: 5, l0: 2, l1: 1, l2: 1, l3: 0, l4: 1, l5: 0, l0_pct: 40, l4l5_pct: 20, show_supply_7d: 5, show_freq: 7, show_supply_vs_freq_pct: 71, show_active_status: 'Inactive', bu_l0_pct: 30, bu_l4l5_pct: 22, poor_l0_flag: 0, high_l45_flag: 0, needs_supply_fix_flag: 1, hdc_verdict: 'ok', show_recommendation: 'SUPPLY: 5/7 wk (71% of target) — raise output.' }),
  ];

  return { eval: evals, fat: fatExpanded, hdc, ts, meta, rca, aud, ret };
}

-- ============================================================
-- CONTENT FATIGUE MONITOR — v6 (failure-mode diagnostic)
-- D0 = calendar D0 (watched on approval day, IST), ALL paid users
-- 5-sec viewer definition is preserved as the company-wide base.
--
-- Changes vs v5:
--   1. Per-video checkpoint counts at 5s / 30s / 50% / 90% and three
--      retention ratios (hook / mid / end).
--   2. Per-video failure_mode classifier (HOOK_FAIL / PACE_FAIL /
--      ENDING_FAIL / OK), with language-adaptive p25 thresholds.
--   3. Show-level dominant_failure_mode over last 10 eps.
--   4. category_reach_rate (viewers_5s / category_paid_dau) replaces
--      raw view counts as the z-score viewer input — fixes DAU gap.
--   5. show_6day_return_rate (Duolingo model) replaces 1-step D0 next-ep.
--   6. comp_pass_rate_7eps surfaced — the team's de facto heuristic.
--   7. Saturation per show, demand density per category.
--   8. Fatigue score reweighted: comp 0.60 / cat-reach 0.20 /
--      6d-return 0.20. (FER removed from the score.) All three components
--      are computed over the LAST 7 DAYS (approved_dt today-8..today-2),
--      then z-scored within language. Other show columns stay on 28 days.
--   9. Diagnostic remarks specify WHERE the show is failing and what to do.
-- Convention: HIGHER fatigue_score = HEALTHIER show.
-- ============================================================
WITH params AS (
  SELECT
    DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 28 DAY) AS window_start,
    DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1  DAY) AS window_end,
    DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 35 DAY) AS lookback_start
),
-- H123 VIEWS — source of truth is the CMS view-count table. `starts` is a
-- cumulative counter, so we take the row with the MAX starts per series (the
-- most-complete reading = what the CMS UI shows). A later-computed snapshot can
-- hold a lower starts, so ordering by computed_at would undercount.
cms_latest AS (
  SELECT series_id, starts AS cms_h123_views
  FROM `seekho-c084b.analytics_content.content_metrics_run_log_v2`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY series_id ORDER BY starts DESC, computed_at DESC) = 1
),
-- D0 VIEWS ≈ H1. Take the LAST H1 snapshot per series (the largest H1 `starts`,
-- i.e. the reading just before it rolls into H12) as the D0 view count.
cms_d0 AS (
  SELECT series_id, starts AS cms_d0_views
  FROM `seekho-c084b.analytics_content.content_metrics_run_log_v2`
  WHERE snapshot_tag = 'H1'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY series_id ORDER BY starts DESC, computed_at DESC) = 1
),
all_series AS (
  SELECT cs.id AS series_id, cs.title AS series_title, cs.show_id, cs.category_id, cs.language,
         DATE(cs.approved_on,'Asia/Kolkata')  AS approved_dt,
         DATE(cs.published_on,'Asia/Kolkata') AS published_dt,
         cs.duration_s, cs.is_premium
  FROM `seekho-c084b.seekho.courses_series` cs, params p
  WHERE cs.state IN ('live','expired')
    AND cs.language IN ('hi','te','ta','ml','kn')
    AND DATE(cs.approved_on,'Asia/Kolkata') BETWEEN p.lookback_start AND p.window_end
),
sv_window AS (
  SELECT profile_id,
         DATE(start_date,'Asia/Kolkata') AS sub_start,
         DATE(end_date,'Asia/Kolkata')   AS sub_end
  FROM `seekho-c084b.seekho.payments_subscriptionvalidity`, params
  WHERE COALESCE(is_deleted, FALSE) = FALSE
    AND DATE(start_date,'Asia/Kolkata') <= params.window_end
    AND DATE(end_date,'Asia/Kolkata')   >= params.lookback_start
),
-- PERFORMANCE: materialize the paid-user date intervals ONCE as a small
-- intermediate. Both watching scans below use this as a hash-joinable set
-- rather than a correlated subquery against sv_window.
paid_user_intervals AS (
  SELECT DISTINCT up.firebase_uid, sv.sub_start, sv.sub_end
  FROM `seekho-c084b.seekho.users_userprofile` up
  JOIN sv_window sv ON sv.profile_id = up.user_ptr_id
),
-- H123 window per in-window video — the FIRST 72 HOURS after approval,
-- i.e. D0 + D1 + D2 (days_since_approval ∈ {0, 1, 2}). D0 is still computed
-- separately because first-impression behavior matters on its own.
cal_window_raw AS (
  SELECT w.series_id, w.user_id AS firebase_uid, w.date_tz,
         v.approved_dt,
         DATE_DIFF(w.date_tz, v.approved_dt, DAY) AS days_since_approval,
         w.seconds_logic, w.video_duration_sec
  FROM `seekho-c084b.analytics_content.s_raw_watching_five_second` w
  JOIN all_series v
    ON v.series_id = w.series_id
   AND w.date_tz BETWEEN v.approved_dt AND DATE_ADD(v.approved_dt, INTERVAL 2 DAY)
  JOIN paid_user_intervals pui
    ON pui.firebase_uid = w.user_id
   AND w.date_tz BETWEEN pui.sub_start AND pui.sub_end
  WHERE w.date_tz BETWEEN (SELECT lookback_start FROM params)
                      AND DATE_ADD((SELECT window_end FROM params), INTERVAL 2 DAY)
),
per_user_video AS (
  SELECT series_id, firebase_uid,
         -- D0 only (approval day)
         SUM(IF(days_since_approval = 0, seconds_logic, 0))               AS user_watchtime_d0,
         -- H123 = first 72 hours after approval, includes D0 + D1 + D2
         SUM(IF(days_since_approval BETWEEN 0 AND 2, seconds_logic, 0))   AS user_watchtime_h123,
         ANY_VALUE(video_duration_sec)                                     AS video_duration_sec
  FROM cal_window_raw GROUP BY series_id, firebase_uid
),
video_d0_metrics AS (
  SELECT
    series_id,
    ANY_VALUE(video_duration_sec) AS video_duration_sec,
    COUNTIF(user_watchtime_d0 > 0) AS viewers_5s,
    SUM(user_watchtime_d0)         AS d0_total_watchtime_sec,
    ROUND(SAFE_DIVIDE(SUM(user_watchtime_d0), NULLIF(COUNTIF(user_watchtime_d0 > 0), 0)), 1) AS d0_avg_watchtime_per_user_sec,
    -- D0 completion: % of D0 viewers whose D0 watchtime cleared 70% of
    -- the video's duration. 70% is Seekho's accepted "completed" bar.
    ROUND(SAFE_DIVIDE(
      COUNTIF(video_duration_sec IS NOT NULL AND user_watchtime_d0 >= 0.70 * video_duration_sec),
      NULLIF(COUNTIF(user_watchtime_d0 > 0), 0)
    ) * 100, 2) AS d0_completion_rate_pct
  FROM per_user_video
  GROUP BY series_id
),
-- H123 (first 72 hours after approval = D0 + D1 + D2) metrics. D0 is
-- captured separately above. H123 feeds the failure-mode classifier,
-- comp-pass test, and the fatigue score's comp-Δ component.
video_h123_metrics AS (
  SELECT
    series_id,
    ANY_VALUE(video_duration_sec) AS video_duration_sec,
    COUNTIF(user_watchtime_h123 > 0)                                                              AS viewers_h123,
    SUM(user_watchtime_h123)                                                                      AS h123_total_watchtime_sec,
    -- H123 completion: % of H123 viewers whose H123 watchtime cleared 70%
    -- of the video's duration (Seekho's "completed" bar).
    ROUND(SAFE_DIVIDE(
      COUNTIF(video_duration_sec IS NOT NULL AND user_watchtime_h123 >= 0.70 * video_duration_sec),
      NULLIF(COUNTIF(user_watchtime_h123 > 0), 0)
    ) * 100, 2) AS h123_completion_rate_pct,
    -- Retention checkpoints: 30s (hook), 50% (mid), 70% (end). End uses
    -- the same 70% bar as the completion definition.
    ROUND(SAFE_DIVIDE(COUNTIF(user_watchtime_h123 >= 30), NULLIF(COUNTIF(user_watchtime_h123 > 0), 0)) * 100, 2) AS hook_retention_h123_pct,
    ROUND(SAFE_DIVIDE(
      COUNTIF(video_duration_sec IS NOT NULL AND user_watchtime_h123 >= 0.50 * video_duration_sec),
      NULLIF(COUNTIF(user_watchtime_h123 >= 30), 0)
    ) * 100, 2) AS mid_retention_h123_pct,
    ROUND(SAFE_DIVIDE(
      COUNTIF(video_duration_sec IS NOT NULL AND user_watchtime_h123 >= 0.70 * video_duration_sec),
      NULLIF(COUNTIF(video_duration_sec IS NOT NULL AND user_watchtime_h123 >= 0.50 * video_duration_sec), 0)
    ) * 100, 2) AS end_retention_h123_pct
  FROM per_user_video
  GROUP BY series_id
),
language_retention_thresholds AS (
  SELECT s.language,
    APPROX_QUANTILES(vm.hook_retention_h123_pct, 100)[OFFSET(25)] AS p25_hook_retention_pct,
    APPROX_QUANTILES(vm.mid_retention_h123_pct,  100)[OFFSET(25)] AS p25_mid_retention_pct,
    APPROX_QUANTILES(vm.end_retention_h123_pct,  100)[OFFSET(25)] AS p25_end_retention_pct
  FROM video_h123_metrics vm
  JOIN all_series s ON s.series_id = vm.series_id
  WHERE vm.hook_retention_h123_pct IS NOT NULL
  GROUP BY s.language
),
video_failure_mode AS (
  SELECT vm.series_id, s.language,
    CASE
      WHEN vm.viewers_h123 < 10               THEN 'INSUFFICIENT_VIEWS'
      WHEN vm.video_duration_sec < 60         THEN 'SHORT_VIDEO'
      WHEN vm.hook_retention_h123_pct IS NULL THEN 'NO_VIEWERS'
      WHEN vm.hook_retention_h123_pct <= LEAST(COALESCE(vm.mid_retention_h123_pct, 100), COALESCE(vm.end_retention_h123_pct, 100))
           AND vm.hook_retention_h123_pct < lt.p25_hook_retention_pct
        THEN 'HOOK_FAIL'
      WHEN vm.mid_retention_h123_pct <= LEAST(COALESCE(vm.hook_retention_h123_pct, 100), COALESCE(vm.end_retention_h123_pct, 100))
           AND vm.mid_retention_h123_pct < lt.p25_mid_retention_pct
        THEN 'PACE_FAIL'
      WHEN vm.end_retention_h123_pct <= LEAST(COALESCE(vm.hook_retention_h123_pct, 100), COALESCE(vm.mid_retention_h123_pct, 100))
           AND vm.end_retention_h123_pct < lt.p25_end_retention_pct
        THEN 'ENDING_FAIL'
      ELSE 'OK'
    END AS failure_mode
  FROM video_h123_metrics vm
  JOIN all_series s ON s.series_id = vm.series_id
  LEFT JOIN language_retention_thresholds lt ON lt.language = s.language
),
-- Authoritative completion data from analytics_content.content_performance.
-- IMPORTANT: replace `<COMP_RATE_COL>` below with the actual completion-rate
-- column name in your content_performance table (the table has `targ_comp`
-- for target — the achieved rate column lives alongside it). Common names
-- to check in the schema:
--   comp_rate, completion_rate, completion_rate_pct, achieved_comp,
--   d0_comp_rate, completion, comp_pct
-- Run `SELECT column_name FROM `seekho-c084b.analytics_content.INFORMATION_SCHEMA.COLUMNS`
--      WHERE table_name = 'content_performance'`
-- to list them, then swap the alias on the two lines marked below.
-- analytics_content.content_performance: source for per-video TARGET
-- completion (`targ_comp`) and the canonical success/failure flag (`status`).
-- Completion itself is computed from raw watching at the 70% bar — the
-- completion-rate column on content_performance is not read here.
--
-- IMPORTANT: We do NOT filter by snapshot_tag. The team's current
-- content_performance pipeline does not consistently use the 'D1'/'D12'/
-- 'D123' tag values that earlier versions of this monitor relied on, so
-- a snapshot_tag filter would return zero rows and leave targ_comp blank
-- everywhere. Instead we aggregate per series_id:
--   • targ_comp is a per-video property (depends on duration); it doesn't
--     vary across snapshot rows for the same video, so MAX returns the
--     value (NULL-aware: MAX ignores NULLs).
--   • status: MAX(1, 0, NULL) = 1 — picks the most positive flag.
cp AS (
  SELECT
    series_id,
    MAX(targ_comp) AS targ_comp,
    MAX(status)    AS video_status
  FROM `seekho-c084b.analytics_content.content_performance`
  GROUP BY series_id
),
ep_seq AS (
  SELECT s.*,
    ROW_NUMBER() OVER (PARTITION BY s.show_id ORDER BY s.approved_dt, s.series_id) AS ep_num,
    LAG(s.series_id)  OVER (PARTITION BY s.show_id ORDER BY s.approved_dt, s.series_id) AS prev_series_id,
    LEAD(s.series_id) OVER (PARTITION BY s.show_id ORDER BY s.approved_dt, s.series_id) AS next_series_id
  FROM all_series s
),
-- 28-day window scan for saturation / 6d return / category demand density.
-- Joins paid_user_intervals (small hash-joinable set) and the in-window
-- show set so the watching scan is pruned by (a) date and (b) the show
-- catalog of interest.
paid_watching_28d AS (
  SELECT cs.show_id, cs.category_id, cs.language,
    w.series_id, w.user_id AS firebase_uid, w.date_tz, w.seconds_logic
  FROM `seekho-c084b.analytics_content.s_raw_watching_five_second` w
  JOIN `seekho-c084b.seekho.courses_series` cs
    ON cs.id = w.series_id
   AND cs.language IN ('hi','te','ta','ml','kn')
  JOIN paid_user_intervals pui
    ON pui.firebase_uid = w.user_id
   AND w.date_tz BETWEEN pui.sub_start AND pui.sub_end
  WHERE w.date_tz BETWEEN (SELECT window_start FROM params) AND (SELECT window_end FROM params)
),
category_paid_dau AS (
  SELECT category_id, language, date_tz, COUNT(DISTINCT firebase_uid) AS category_paid_dau
  FROM paid_watching_28d
  GROUP BY category_id, language, date_tz
),
video_with_deltas AS (
  SELECT es.series_id, es.series_title, es.show_id, es.category_id, es.language,
    es.approved_dt, es.published_dt, es.duration_s, es.is_premium,
    es.ep_num, es.prev_series_id, es.next_series_id,
    COALESCE(vm.viewers_5s, 0)             AS d0_unique_viewers,
    COALESCE(vm.d0_total_watchtime_sec, 0) AS d0_total_watchtime_sec,
    vm.d0_avg_watchtime_per_user_sec,
    -- D0 (approval day) and H123 (first 72h after approval = D0+D1+D2)
    -- completion, both from raw watching with the 70% bar.
    vm.d0_completion_rate_pct,
    vmh123.h123_completion_rate_pct,
    -- H123 raw-watching viewer count and watchtime (also used for
    -- saturation/FER/retention denominators)
    COALESCE(vmh123.viewers_h123, 0)             AS h123_unique_viewers,
    COALESCE(vmh123.h123_total_watchtime_sec, 0) AS h123_total_watchtime_sec,
    -- Per-video TARGET completion straight from content_performance.targ_comp.
    -- Each video has its own target (it varies with duration / content type),
    -- so we read the actual per-video number and never substitute a constant.
    cp_curr.targ_comp,
    prev_vm.viewers_5s             AS prev_d0_unique_viewers,
    prev_vm.d0_completion_rate_pct AS prev_d0_completion_rate_pct,
    ROUND(SAFE_DIVIDE(vm.viewers_5s - prev_vm.viewers_5s, prev_vm.viewers_5s) * 100, 2) AS unique_viewer_delta_pct,
    ROUND(vm.d0_completion_rate_pct - prev_vm.d0_completion_rate_pct, 2) AS completion_rate_delta_ppt,
    -- Comp efficiency: completion ÷ per-video target × 100.
    ROUND(SAFE_DIVIDE(vm.d0_completion_rate_pct, NULLIF(cp_curr.targ_comp, 0)) * 100, 2) AS comp_eff_pct,
    ROUND(SAFE_DIVIDE(prev_vm.d0_completion_rate_pct, NULLIF(prev_cp.targ_comp, 0)) * 100, 2) AS prev_comp_eff_pct,
    ROUND(SAFE_DIVIDE(vm.d0_completion_rate_pct, NULLIF(cp_curr.targ_comp, 0)) * 100
        - SAFE_DIVIDE(prev_vm.d0_completion_rate_pct, NULLIF(prev_cp.targ_comp, 0)) * 100, 2) AS comp_eff_delta,
    -- H123 comp efficiency = watching-derived H123 completion ÷ per-video
    -- target. Feeds the show-level fatigue score and comp-pass test.
    ROUND(SAFE_DIVIDE(vmh123.h123_completion_rate_pct, NULLIF(cp_curr.targ_comp, 0)) * 100, 2) AS comp_eff_h123_pct,
    ROUND(SAFE_DIVIDE(prev_vmh123.h123_completion_rate_pct, NULLIF(prev_cp.targ_comp, 0)) * 100, 2) AS prev_comp_eff_h123_pct,
    ROUND(SAFE_DIVIDE(vmh123.h123_completion_rate_pct, NULLIF(cp_curr.targ_comp, 0)) * 100
        - SAFE_DIVIDE(prev_vmh123.h123_completion_rate_pct, NULLIF(prev_cp.targ_comp, 0)) * 100, 2) AS comp_eff_h123_delta,
    prev_cp.targ_comp AS prev_targ_comp,
    -- Canonical per-video success flag from content_performance.status.
    -- 1 = successful, 0 = failed, NULL = not yet evaluated.
    cp_curr.video_status AS video_status,
    vmh123.hook_retention_h123_pct, vmh123.mid_retention_h123_pct, vmh123.end_retention_h123_pct,
    vfm.failure_mode,
    cpd.category_paid_dau      AS approval_day_category_paid_dau,
    prev_cpd.category_paid_dau AS prev_approval_day_category_paid_dau,
    ROUND(SAFE_DIVIDE(vm.viewers_5s, cpd.category_paid_dau) * 100, 3)            AS category_reach_rate_pct,
    ROUND(SAFE_DIVIDE(prev_vm.viewers_5s, prev_cpd.category_paid_dau) * 100, 3)  AS prev_category_reach_rate_pct,
    ROUND(SAFE_DIVIDE(
      SAFE_DIVIDE(vm.viewers_5s, cpd.category_paid_dau) * 100
    - SAFE_DIVIDE(prev_vm.viewers_5s, prev_cpd.category_paid_dau) * 100,
      NULLIF(SAFE_DIVIDE(prev_vm.viewers_5s, prev_cpd.category_paid_dau) * 100, 0)
    ) * 100, 2) AS category_reach_rate_delta_pct
  FROM ep_seq es
  LEFT JOIN video_d0_metrics vm      ON vm.series_id      = es.series_id
  LEFT JOIN video_d0_metrics prev_vm ON prev_vm.series_id = es.prev_series_id
  LEFT JOIN video_h123_metrics vmh123      ON vmh123.series_id      = es.series_id
  LEFT JOIN video_h123_metrics prev_vmh123 ON prev_vmh123.series_id = es.prev_series_id
  LEFT JOIN cp cp_curr ON cp_curr.series_id = es.series_id
  LEFT JOIN cp prev_cp ON prev_cp.series_id = es.prev_series_id
  LEFT JOIN video_failure_mode vfm ON vfm.series_id = es.series_id
  LEFT JOIN category_paid_dau cpd
    ON cpd.category_id = es.category_id AND cpd.language = es.language AND cpd.date_tz = es.approved_dt
  LEFT JOIN all_series prev_s ON prev_s.series_id = es.prev_series_id
  LEFT JOIN category_paid_dau prev_cpd
    ON prev_cpd.category_id = prev_s.category_id AND prev_cpd.language = prev_s.language AND prev_cpd.date_tz = prev_s.approved_dt
),
in_window_videos AS (
  SELECT vd.*,
    1 + DIV(DATE_DIFF(vd.approved_dt, (SELECT window_start FROM params), DAY), 7) AS week_num
  FROM video_with_deltas vd
  WHERE vd.approved_dt BETWEEN (SELECT window_start FROM params) AND (SELECT window_end FROM params)
),
show_user_days AS (
  SELECT DISTINCT show_id, firebase_uid, date_tz FROM paid_watching_28d
),
show_user_days_with_next AS (
  SELECT show_id, firebase_uid, date_tz,
    LEAD(date_tz) OVER (PARTITION BY show_id, firebase_uid ORDER BY date_tz) AS next_date_tz
  FROM show_user_days
),
show_6day_return AS (
  SELECT show_id,
    ROUND(SAFE_DIVIDE(
      COUNTIF(next_date_tz IS NOT NULL AND DATE_DIFF(next_date_tz, date_tz, DAY) <= 6),
      COUNT(*)
    ) * 100, 2) AS show_6day_return_rate_pct
  FROM show_user_days_with_next
  WHERE date_tz <= DATE_SUB((SELECT window_end FROM params), INTERVAL 6 DAY)
  GROUP BY show_id
),
show_weekly_user_eps AS (
  SELECT show_id,
    1 + DIV(DATE_DIFF(date_tz, (SELECT window_start FROM params), DAY), 7) AS week_num,
    firebase_uid, COUNT(DISTINCT series_id) AS user_eps_in_week
  FROM paid_watching_28d
  GROUP BY show_id, week_num, firebase_uid
),
show_weekly_eps_published AS (
  SELECT show_id,
    1 + DIV(DATE_DIFF(approved_dt, (SELECT window_start FROM params), DAY), 7) AS week_num,
    COUNT(*) AS eps_published_in_week
  FROM all_series
  WHERE approved_dt BETWEEN (SELECT window_start FROM params) AND (SELECT window_end FROM params)
  GROUP BY show_id, week_num
),
show_weekly_saturation AS (
  SELECT swu.show_id, swu.week_num,
    ROUND(SAFE_DIVIDE(AVG(swu.user_eps_in_week), ANY_VALUE(swp.eps_published_in_week)) * 100, 2) AS week_saturation_pct
  FROM show_weekly_user_eps swu
  JOIN show_weekly_eps_published swp USING (show_id, week_num)
  WHERE swp.eps_published_in_week > 0 AND swu.week_num BETWEEN 1 AND 4
  GROUP BY swu.show_id, swu.week_num
),
show_saturation AS (
  SELECT show_id, ROUND(AVG(week_saturation_pct), 2) AS avg_saturation_pct
  FROM show_weekly_saturation GROUP BY show_id
),
last_10_eps_per_show AS (
  SELECT show_id, series_id, failure_mode
  FROM (
    SELECT show_id, series_id, failure_mode,
      ROW_NUMBER() OVER (PARTITION BY show_id ORDER BY approved_dt DESC, series_id DESC) AS rn
    FROM in_window_videos
    WHERE failure_mode IN ('HOOK_FAIL','PACE_FAIL','ENDING_FAIL','OK')
  ) t WHERE rn <= 10
),
show_failure_summary AS (
  SELECT show_id,
    COUNTIF(failure_mode = 'HOOK_FAIL')   AS hook_fail_cnt,
    COUNTIF(failure_mode = 'PACE_FAIL')   AS pace_fail_cnt,
    COUNTIF(failure_mode = 'ENDING_FAIL') AS ending_fail_cnt,
    COUNTIF(failure_mode = 'OK')          AS ok_cnt,
    COUNT(*) AS evaluable_eps_cnt
  FROM last_10_eps_per_show GROUP BY show_id
),
show_failure_diagnosis AS (
  SELECT *,
    CASE
      WHEN evaluable_eps_cnt < 3 THEN 'INSUFFICIENT_DATA'
      WHEN hook_fail_cnt   >= GREATEST(pace_fail_cnt, ending_fail_cnt)
           AND hook_fail_cnt   >= 0.40 * evaluable_eps_cnt THEN 'HOOK'
      WHEN pace_fail_cnt   >= GREATEST(hook_fail_cnt, ending_fail_cnt)
           AND pace_fail_cnt   >= 0.40 * evaluable_eps_cnt THEN 'PACE'
      WHEN ending_fail_cnt >= GREATEST(hook_fail_cnt, pace_fail_cnt)
           AND ending_fail_cnt >= 0.40 * evaluable_eps_cnt THEN 'ENDING'
      ELSE 'OK'
    END AS dominant_failure_mode,
    GREATEST(hook_fail_cnt, pace_fail_cnt, ending_fail_cnt) AS dominant_fail_count
  FROM show_failure_summary
),
-- Success rate = % of SUCCESSFUL videos among videos whose H123 window has
-- FULLY SETTLED. We exclude anything still being tracked:
--   • H123 = the first 72h, so a video must be older than 72h (3 days), AND
--   • we add a 1-day buffer for late-landing data → the NEWEST countable
--     video is approved >= 4 days ago (an in-flight day gives no fixed rate).
--   • we then look back a 7-day window → OLDEST countable is 10 days ago.
-- Example: run on the 9th → count videos approved 30th .. 5th; 6th-9th are
-- still settling and are excluded. Denominator is additionally hard-capped
-- at 7. SUCCESS = status = 1, or (status NULL) H123 completion >= target.
last_7_outcome_eps AS (
  SELECT show_id, outcome
  FROM (
    SELECT show_id,
      CASE
        WHEN video_status = 1 THEN 1
        WHEN video_status = 0 THEN 0
        WHEN targ_comp IS NOT NULL AND h123_completion_rate_pct >= targ_comp THEN 1
        ELSE 0
      END AS outcome,
      ROW_NUMBER() OVER (PARTITION BY show_id ORDER BY approved_dt DESC, series_id DESC) AS rn
    FROM in_window_videos
    -- settled-H123 window: approved between 10 and 4 days ago (a 7-day window
    -- ending 72h + 1 buffer day before today), and H123 data present.
    WHERE h123_completion_rate_pct IS NOT NULL
      AND approved_dt <= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 4 DAY)
      AND approved_dt >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 10 DAY)
  ) t WHERE rn <= 7   -- hard cap: at most 7 videos in the denominator
),
show_comp_pass AS (
  SELECT show_id,
    COUNTIF(outcome = 1) AS comp_pass_cnt_7eps,
    COUNT(*)             AS comp_evaluable_eps_cnt,   -- H123-available videos <=7 days old (<= 7)
    ROUND(SAFE_DIVIDE(COUNTIF(outcome = 1), NULLIF(COUNT(*), 0)) * 100, 2) AS comp_pass_rate_7eps_pct
  FROM last_7_outcome_eps GROUP BY show_id
),
weekly_show AS (
  SELECT show_id, ANY_VALUE(language) AS language, week_num,
    COUNT(*) AS episodes_posted,
    SUM(d0_unique_viewers)       AS week_d0_viewers,
    SUM(d0_total_watchtime_sec)  AS week_d0_watchtime,
    AVG(d0_completion_rate_pct)  AS week_avg_completion,
    AVG(unique_viewer_delta_pct) AS week_avg_delta_pct
  FROM in_window_videos WHERE week_num BETWEEN 1 AND 4 GROUP BY show_id, week_num
),
weekly_show_with_fer AS (
  SELECT *,
    SAFE_DIVIDE(week_d0_watchtime, GREATEST(week_d0_viewers,1) * GREATEST(episodes_posted,1)) AS week_fer
  FROM weekly_show
),
show_fer_acc AS (
  SELECT show_id, AVG(week_fer) AS avg_fer,
    MAX(IF(week_num = 4, week_avg_delta_pct, NULL))
      - MAX(IF(week_num = 1, week_avg_delta_pct, NULL))  AS delta_trend_4w,
    MAX(IF(week_num = 1, week_d0_viewers, NULL)) AS w1_d0_viewers,
    MAX(IF(week_num = 4, week_d0_viewers, NULL)) AS w4_d0_viewers,
    SUM(episodes_posted)                         AS show_total_episodes_4w
  FROM weekly_show_with_fer GROUP BY show_id
),
show_components AS (
  SELECT iw.show_id, ANY_VALUE(iw.language) AS language, ANY_VALUE(iw.category_id) AS category_id,
    COUNT(*) AS show_n_videos_4w,
    MAX(iw.approved_dt)                   AS last_approved_dt,
    AVG(iw.unique_viewer_delta_pct)       AS avg_unique_viewer_delta_pct,
    AVG(iw.comp_eff_h123_delta)           AS avg_comp_eff_delta,
    AVG(iw.d0_unique_viewers)             AS avg_d0_unique_viewers,
    AVG(iw.h123_unique_viewers)           AS avg_h123_unique_viewers,
    AVG(iw.d0_total_watchtime_sec)        AS avg_d0_watchtime_sec,
    AVG(iw.h123_total_watchtime_sec)      AS avg_h123_watchtime_sec,
    AVG(iw.d0_avg_watchtime_per_user_sec) AS avg_d0_watchtime_per_user,
    AVG(iw.d0_completion_rate_pct)        AS avg_d0_completion_rate,
    AVG(iw.h123_completion_rate_pct)      AS avg_h123_completion_rate,
    AVG(iw.targ_comp)                     AS avg_targ_comp,
    AVG(iw.category_reach_rate_pct)       AS avg_category_reach_rate_pct,
    AVG(iw.category_reach_rate_delta_pct) AS avg_category_reach_delta_pct,
    AVG(iw.hook_retention_h123_pct)       AS avg_hook_retention_pct,
    AVG(iw.mid_retention_h123_pct)        AS avg_mid_retention_pct,
    AVG(iw.end_retention_h123_pct)        AS avg_end_retention_pct
  FROM in_window_videos iw GROUP BY iw.show_id
),
-- FATIGUE-SCORE WINDOW = last 7 days (approved_dt today-8 .. today-2, today
-- excluded; "7 days till the 8th" when today is the 10th). The fatigue score
-- and ONLY the fatigue score is computed on this window. Other show columns
-- stay on the 28-day window.
fatigue_window_components AS (
  SELECT show_id,
    AVG(comp_eff_h123_delta)           AS fw_avg_comp_eff_delta,
    AVG(category_reach_rate_delta_pct) AS fw_avg_category_reach_delta_pct,
    COUNT(*)                            AS fw_n_videos_7d
  FROM in_window_videos
  WHERE approved_dt BETWEEN DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 8 DAY)
                       AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 2 DAY)
  GROUP BY show_id
),
fatigue_window_6day_return AS (
  SELECT show_id,
    ROUND(SAFE_DIVIDE(
      COUNTIF(next_date_tz IS NOT NULL AND DATE_DIFF(next_date_tz, date_tz, DAY) <= 6),
      COUNT(*)
    ) * 100, 2) AS fw_6day_return_rate_pct
  FROM show_user_days_with_next
  WHERE date_tz BETWEEN DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 8 DAY)
                    AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 2 DAY)
  GROUP BY show_id
),
show_with_components AS (
  SELECT sc.*,
    sf.avg_fer, sf.delta_trend_4w, sf.w1_d0_viewers, sf.w4_d0_viewers, sf.show_total_episodes_4w,
    ROUND(SAFE_DIVIDE(sf.w4_d0_viewers - sf.w1_d0_viewers, sf.w1_d0_viewers) * 100, 2) AS show_d0_viewers_pct_change_4w,
    sat.avg_saturation_pct,
    r6.show_6day_return_rate_pct,
    fwc.fw_avg_comp_eff_delta, fwc.fw_avg_category_reach_delta_pct, fwc.fw_n_videos_7d,
    fw6.fw_6day_return_rate_pct,
    sfd.dominant_failure_mode, sfd.evaluable_eps_cnt AS failure_evaluable_eps,
    sfd.hook_fail_cnt, sfd.pace_fail_cnt, sfd.ending_fail_cnt, sfd.ok_cnt,
    scp.comp_pass_rate_7eps_pct, scp.comp_pass_cnt_7eps, scp.comp_evaluable_eps_cnt
  FROM show_components sc
  LEFT JOIN show_fer_acc                sf   USING (show_id)
  LEFT JOIN show_saturation             sat  USING (show_id)
  LEFT JOIN show_6day_return            r6   USING (show_id)
  LEFT JOIN fatigue_window_components   fwc  USING (show_id)
  LEFT JOIN fatigue_window_6day_return  fw6  USING (show_id)
  LEFT JOIN show_failure_diagnosis      sfd  USING (show_id)
  LEFT JOIN show_comp_pass              scp  USING (show_id)
),
show_zscored AS (
  SELECT *,
    -- z-scored within language over the LAST-7-DAY fatigue-window metrics
    SAFE_DIVIDE(fw_avg_comp_eff_delta - AVG(fw_avg_comp_eff_delta) OVER (PARTITION BY language),
                NULLIF(STDDEV(fw_avg_comp_eff_delta) OVER (PARTITION BY language), 0))            AS z_comp_eff,
    SAFE_DIVIDE(fw_6day_return_rate_pct - AVG(fw_6day_return_rate_pct) OVER (PARTITION BY language),
                NULLIF(STDDEV(fw_6day_return_rate_pct) OVER (PARTITION BY language), 0))          AS z_6day_return,
    SAFE_DIVIDE(fw_avg_category_reach_delta_pct - AVG(fw_avg_category_reach_delta_pct) OVER (PARTITION BY language),
                NULLIF(STDDEV(fw_avg_category_reach_delta_pct) OVER (PARTITION BY language), 0))  AS z_cat_reach_delta,
    SAFE_DIVIDE(avg_fer - AVG(avg_fer) OVER (PARTITION BY language),
                NULLIF(STDDEV(avg_fer) OVER (PARTITION BY language), 0))                          AS z_fer
  FROM show_with_components
),
show_fatigue AS (
  SELECT *,
    ROUND(
      (0.60 * COALESCE(z_comp_eff,        0))
    + (0.20 * COALESCE(z_cat_reach_delta, 0))
    + (0.20 * COALESCE(z_6day_return,     0)),
    4) AS fatigue_score
  FROM show_zscored
),
show_fatigue_with_pct AS (
  SELECT *,
    PERCENTILE_CONT(fatigue_score, 0.15) OVER (PARTITION BY language) AS p15_score,
    PERCENTILE_CONT(fatigue_score, 0.35) OVER (PARTITION BY language) AS p35_score
  FROM show_fatigue WHERE show_n_videos_4w >= 2
),
show_with_zone AS (
  SELECT * EXCEPT(p15_score, p35_score),
    CASE
      WHEN fatigue_score <= p15_score THEN 'red'
      WHEN fatigue_score <= p35_score THEN 'yellow'
      ELSE 'green'
    END AS fatigue_zone
  FROM show_fatigue_with_pct
),
show_with_action AS (
  SELECT *,
    CASE
      -- SHUTDOWN: require sustained miss across BOTH comp + retention AND
      -- enough volume (≥4 of the last 7 videos have a result out). Avoids
      -- flagging low-volume shows on noisy denominators.
      WHEN comp_pass_rate_7eps_pct < 40
           AND show_6day_return_rate_pct < 30
           AND comp_evaluable_eps_cnt >= 4                                                 THEN 'SHUTDOWN_CANDIDATE'
      -- CADENCE_DOWN: low saturation alone isn't enough — we also need
      -- evidence of audience fatigue (negative reach delta). Otherwise
      -- a small new show with low saturation gets mislabeled.
      WHEN avg_saturation_pct < 45
           AND COALESCE(avg_category_reach_delta_pct, 0) < 0
           AND show_n_videos_4w >= 3                                                       THEN 'CADENCE_DOWN'
      -- CADENCE_UP: high saturation + comp consistently passing target.
      WHEN avg_saturation_pct > 85
           AND comp_pass_rate_7eps_pct >= 60                                               THEN 'CADENCE_UP'
      WHEN dominant_failure_mode = 'HOOK'                                                  THEN 'HOOK_FIX'
      WHEN dominant_failure_mode = 'PACE'                                                  THEN 'PACE_FIX'
      WHEN dominant_failure_mode = 'ENDING'                                                THEN 'ENDING_FIX'
      ELSE 'HOLD'
    END AS action_recommendation
  FROM show_with_zone
),
show_with_remarks AS (
  SELECT *,
    CONCAT(
      'Comp pass: ',   COALESCE(CAST(comp_pass_cnt_7eps AS STRING), '?'), '/',
                       COALESCE(CAST(comp_evaluable_eps_cnt AS STRING), '?'), ' eps | ',
      '6d return: ',   COALESCE(CAST(ROUND(show_6day_return_rate_pct, 1) AS STRING), '?'), '% | ',
      'Cat reach: ',   COALESCE(CAST(ROUND(avg_category_reach_rate_pct, 2) AS STRING), '?'), '%',
                       ' (Δ ', COALESCE(CAST(ROUND(avg_category_reach_delta_pct, 1) AS STRING), '?'), '%) | ',
      'Saturation: ',  COALESCE(CAST(ROUND(avg_saturation_pct, 1) AS STRING), '?'), '% | ',
      CASE dominant_failure_mode
        WHEN 'HOOK'              THEN CONCAT('Hook failing on ',   CAST(hook_fail_cnt   AS STRING), '/', CAST(failure_evaluable_eps AS STRING), ' eps')
        WHEN 'PACE'              THEN CONCAT('Mid drop-off on ',   CAST(pace_fail_cnt   AS STRING), '/', CAST(failure_evaluable_eps AS STRING), ' eps')
        WHEN 'ENDING'            THEN CONCAT('End drop-off on ',   CAST(ending_fail_cnt AS STRING), '/', CAST(failure_evaluable_eps AS STRING), ' eps')
        WHEN 'OK'                THEN 'Drop-off pattern healthy'
        WHEN 'INSUFFICIENT_DATA' THEN 'Not enough recent eps to diagnose'
        ELSE 'Diagnosis unavailable'
      END,
      ' | Action: ',
      CASE action_recommendation
        WHEN 'SHUTDOWN_CANDIDATE' THEN 'SHUTDOWN CANDIDATE — sustained comp + retention miss'
        WHEN 'CADENCE_DOWN'       THEN 'Consider cadence cut'
        WHEN 'CADENCE_UP'         THEN 'Cadence headroom — consider increasing'
        WHEN 'HOOK_FIX'           THEN 'Review thumbnails / cold opens'
        WHEN 'PACE_FIX'           THEN 'Script / edit review on pacing'
        WHEN 'ENDING_FIX'         THEN 'Final-third pacing review'
        ELSE 'Hold — monitor next 2 eps'
      END
    ) AS remarks
  FROM show_with_action
),
category_weekly AS (
  SELECT category_id, language, week_num, SUM(d0_unique_viewers) AS cat_week_viewers
  FROM in_window_videos WHERE week_num BETWEEN 1 AND 4
  GROUP BY category_id, language, week_num
),
category_change AS (
  SELECT category_id, language,
    ROUND(SAFE_DIVIDE(MAX(IF(week_num=4, cat_week_viewers, NULL)) - MAX(IF(week_num=1, cat_week_viewers, NULL)),
                      MAX(IF(week_num=1, cat_week_viewers, NULL))) * 100, 2) AS category_d0_viewers_pct_change_4w
  FROM category_weekly GROUP BY category_id, language
),
category_metrics AS (
  SELECT iw.category_id, iw.language,
    COUNT(*) AS category_n_videos_4w,
    AVG(iw.d0_unique_viewers)             AS category_avg_d0_views,
    AVG(iw.d0_total_watchtime_sec)        AS category_avg_d0_watchtime_sec,
    AVG(iw.d0_completion_rate_pct)        AS category_avg_d0_completion_rate,
    AVG(iw.targ_comp)                     AS category_avg_targ_comp,
    AVG(iw.unique_viewer_delta_pct)       AS category_avg_unique_viewer_delta_pct,
    AVG(iw.category_reach_rate_pct)       AS category_avg_reach_rate_pct,
    AVG(iw.category_reach_rate_delta_pct) AS category_avg_reach_delta_pct
  FROM in_window_videos iw GROUP BY iw.category_id, iw.language
),
eps_published_per_category AS (
  SELECT category_id, language, COUNT(*) AS category_eps_published_28d
  FROM all_series
  WHERE approved_dt BETWEEN (SELECT window_start FROM params) AND (SELECT window_end FROM params)
  GROUP BY category_id, language
),
category_watchtime AS (
  SELECT category_id, language, SUM(seconds_logic) AS category_paid_watchtime_28d
  FROM paid_watching_28d
  GROUP BY category_id, language
),
category_demand_density AS (
  SELECT cw.category_id, cw.language,
    cw.category_paid_watchtime_28d, epc.category_eps_published_28d,
    ROUND(SAFE_DIVIDE(cw.category_paid_watchtime_28d, epc.category_eps_published_28d), 1) AS category_demand_density_sec_per_ep
  FROM category_watchtime cw
  LEFT JOIN eps_published_per_category epc USING (category_id, language)
)
SELECT
  iw.series_id, iw.series_title, iw.show_id, sh.title AS show_title,
  -- show_state: read from courses_show.show_type (canonical source).
  -- Values include 'active', 'experimental', 'inactive', plus others
  -- like 'gtm', 'ai'. Map 'experimental' → 'experiment' for UI
  -- consistency. Unknown values pass through verbatim so they're
  -- visible in the dashboard.
  CASE
    WHEN LOWER(sh.show_type) = 'experimental' THEN 'experiment'
    WHEN sh.show_type IS NULL                 THEN 'inactive'
    ELSE LOWER(sh.show_type)
  END AS show_state,
  iw.category_id, cat.title AS category_title, iw.language,
  iw.approved_dt, iw.published_dt, iw.duration_s AS video_duration_sec, iw.is_premium,
  iw.ep_num, iw.week_num,
  -- D0 views = CMS final-H1 `starts` (D0 ≈ H1); fall back to raw-watching only if absent.
  COALESCE(cms0.cms_d0_views, iw.d0_unique_viewers) AS d0_views,
  COALESCE(cms0.cms_d0_views, iw.d0_unique_viewers) AS d0_unique_viewers,
  -- H123 views = CMS latest `starts` (source of truth); fall back to raw-watching only if absent.
  COALESCE(cms.cms_h123_views, iw.h123_unique_viewers) AS h123_unique_viewers,
  iw.d0_total_watchtime_sec, iw.h123_total_watchtime_sec, iw.d0_avg_watchtime_per_user_sec,
  iw.d0_completion_rate_pct, iw.h123_completion_rate_pct, iw.targ_comp,
  iw.prev_d0_unique_viewers, iw.unique_viewer_delta_pct,
  iw.prev_d0_completion_rate_pct, iw.completion_rate_delta_ppt,
  iw.comp_eff_pct, iw.prev_comp_eff_pct, iw.comp_eff_delta, iw.prev_targ_comp,
  iw.comp_eff_h123_pct, iw.prev_comp_eff_h123_pct, iw.comp_eff_h123_delta,
  iw.hook_retention_h123_pct AS hook_retention_pct,
  iw.mid_retention_h123_pct  AS mid_retention_pct,
  iw.end_retention_h123_pct  AS end_retention_pct,
  iw.failure_mode,
  iw.video_status,
  -- Effective outcome: cp.status when present, else completion-vs-target.
  -- 1 = success, 0 = failed, NULL = neither status nor completion available.
  CASE
    WHEN iw.video_status = 1 THEN 1
    WHEN iw.video_status = 0 THEN 0
    WHEN iw.h123_completion_rate_pct IS NOT NULL AND iw.targ_comp IS NOT NULL
         AND iw.h123_completion_rate_pct >= iw.targ_comp THEN 1
    WHEN iw.h123_completion_rate_pct IS NOT NULL AND iw.targ_comp IS NOT NULL
         AND iw.h123_completion_rate_pct <  iw.targ_comp THEN 0
    ELSE NULL
  END AS video_outcome_effective,
  CASE iw.video_status WHEN 1 THEN 'success' WHEN 0 THEN 'failed' ELSE NULL END AS video_outcome,
  iw.approval_day_category_paid_dau, iw.category_reach_rate_pct,
  iw.prev_approval_day_category_paid_dau, iw.prev_category_reach_rate_pct,
  iw.category_reach_rate_delta_pct,
  swr.show_n_videos_4w, swr.show_total_episodes_4w,
  swr.avg_d0_unique_viewers       AS show_avg_d0_views,
  swr.avg_h123_unique_viewers     AS show_avg_h123_views,
  swr.avg_d0_watchtime_sec        AS show_avg_d0_watchtime_sec,
  swr.avg_d0_watchtime_per_user   AS show_avg_d0_watchtime_per_user_sec,
  swr.avg_d0_completion_rate      AS show_avg_d0_completion_rate,
  swr.avg_targ_comp               AS show_avg_targ_comp,
  swr.avg_unique_viewer_delta_pct AS show_avg_unique_viewer_delta_pct,
  swr.avg_comp_eff_delta          AS show_avg_comp_eff_delta,
  swr.show_d0_viewers_pct_change_4w,
  swr.avg_fer                     AS show_avg_fer,
  swr.delta_trend_4w              AS show_delta_trend_4w,
  swr.avg_hook_retention_pct      AS show_avg_hook_retention_pct,
  swr.avg_mid_retention_pct       AS show_avg_mid_retention_pct,
  swr.avg_end_retention_pct       AS show_avg_end_retention_pct,
  swr.avg_category_reach_rate_pct AS show_avg_category_reach_rate_pct,
  swr.avg_category_reach_delta_pct AS show_avg_category_reach_delta_pct,
  swr.show_6day_return_rate_pct,
  swr.avg_saturation_pct          AS show_avg_saturation_pct,
  swr.comp_pass_cnt_7eps, swr.comp_evaluable_eps_cnt, swr.comp_pass_rate_7eps_pct,
  swr.dominant_failure_mode       AS show_dominant_failure_mode,
  swr.hook_fail_cnt   AS show_hook_fail_cnt_10eps,
  swr.pace_fail_cnt   AS show_pace_fail_cnt_10eps,
  swr.ending_fail_cnt AS show_ending_fail_cnt_10eps,
  swr.failure_evaluable_eps AS show_failure_evaluable_eps_cnt,
  swr.fatigue_score               AS show_fatigue_score,
  swr.fatigue_zone                AS show_fatigue_zone,
  swr.action_recommendation       AS show_action_recommendation,
  swr.remarks                     AS show_remarks,
  cm.category_n_videos_4w, cm.category_avg_d0_views, cm.category_avg_d0_watchtime_sec,
  cm.category_avg_d0_completion_rate, cm.category_avg_targ_comp,
  cm.category_avg_unique_viewer_delta_pct,
  cm.category_avg_reach_rate_pct, cm.category_avg_reach_delta_pct,
  cc.category_d0_viewers_pct_change_4w,
  cdd.category_paid_watchtime_28d, cdd.category_eps_published_28d,
  cdd.category_demand_density_sec_per_ep
FROM in_window_videos iw
LEFT JOIN cms_latest                             cms  ON cms.series_id  = iw.series_id
LEFT JOIN cms_d0                                 cms0 ON cms0.series_id = iw.series_id
LEFT JOIN `seekho-c084b.seekho.courses_show`     sh  ON sh.id  = iw.show_id
LEFT JOIN `seekho-c084b.seekho.courses_category` cat ON cat.id = iw.category_id
LEFT JOIN show_with_remarks       swr ON swr.show_id    = iw.show_id
LEFT JOIN category_metrics        cm  ON cm.category_id = iw.category_id AND cm.language = iw.language
LEFT JOIN category_change         cc  ON cc.category_id = iw.category_id AND cc.language = iw.language
LEFT JOIN category_demand_density cdd ON cdd.category_id = iw.category_id AND cdd.language = iw.language
ORDER BY iw.language, iw.show_id, iw.approved_dt DESC, iw.ep_num DESC

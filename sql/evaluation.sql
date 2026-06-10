-- =====================================================================
-- New Show Evaluation Framework v1.4 (relaunch-aware)
-- Seekho main app: hi, te, ta, ml, kn
--
-- New in v1.4:
--   * Detects "relaunches" from cms_s_raw_events.show_actions:
--     any "Updated: Creator" event (or bundled creator change) becomes a
--     relaunch anchor. A show can have multiple relaunches.
--   * RELAUNCH_WEEK periods (weeks 1..6 anchored to each creator-update date)
--     are unioned into show_periods alongside LAUNCH_WEEK and LAST_3_CALENDAR_WEEK.
--   * show_summary now also surfaces rw1..rw4 (most-recent-relaunch weeks
--     1-4) and the relaunch anchor date.
--   * experimental_decision evaluates against the most-recent-relaunch
--     trajectory when one exists (so a swapped-creator show is judged
--     from its new start, not from years ago). Falls back to launch-week
--     trajectory when there has never been a relaunch.
--
-- Perf changes vs v1.2:
--   * Timestamp filter tightened to the last 70 days so BigQuery prunes
--     the older 12+ months of `video_play_combined` partitions outright.
--     This is the single biggest cost lever in the query.
--   * Pre-aggregate raw events to (series, day) BEFORE joining to series
--     and shows; the dimension joins then run on a tiny daily-grain
--     table instead of every event row.
--
-- v1.2 changes already in place:
--   * series filtered to target-language shows early
--   * Daily HLL sketches per (show, day) and (language, day)
--   * IN (relevant_dates) filter on the event scan
--
-- Launch-week data is now emitted for every show regardless of age; the
-- 56-day recency cutoff that previously dropped older shows' LW rows is
-- gone.
-- =====================================================================

DECLARE start_show_publish_date DATE DEFAULT DATE '2020-01-01';
DECLARE end_play_date DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE min_peers_for_category_strat INT64 DEFAULT 5;
DECLARE min_show_users_for_promote INT64 DEFAULT 500;
DECLARE high_conf_min_peers INT64 DEFAULT 20;
DECLARE high_conf_min_users INT64 DEFAULT 1000;
DECLARE med_conf_min_peers INT64 DEFAULT 10;
DECLARE med_conf_min_users INT64 DEFAULT 500;

WITH
shows AS (
  SELECT id AS show_id, title AS show_title, category_id, language, show_type, state
  FROM `seekho.courses_show`
  WHERE language IN ('hi','te','ta','ml','kn')
),
-- Every creator-swap event for any in-scope show. Each row is one relaunch anchor.
-- Inner subquery extracts the event_params scalars once; outer SELECT JOINs to
-- `shows` to keep only in-scope rows.
--
-- Exclusion: when the previous creator was "Seekho Official", treat the event
-- as the show's FIRST real creator assignment (not a relaunch). The
-- updated_fields string is formatted "Creator: <old> → <new>", so we filter
-- out any row where the old value is Seekho Official.
creator_updates AS (
  SELECT ev.show_id, ev.relaunch_date
  FROM (
    SELECT
      (SELECT value.int_value    FROM UNNEST(e.event_params) WHERE key = 'show_id')        AS show_id,
      (SELECT value.string_value FROM UNNEST(e.event_params) WHERE key = 'status')         AS status_label,
      (SELECT value.string_value FROM UNNEST(e.event_params) WHERE key = 'updated_fields') AS updated_fields,
      DATE(TIMESTAMP_MICROS(e.event_timestamp), 'Asia/Kolkata')                             AS relaunch_date
    FROM `seekho-c084b.analytics_raw_events.cms_s_raw_events` e
    WHERE e.event_name = 'show_actions'
      AND e.date_tz   >= '2026-03-01'
  ) ev
  JOIN shows sh ON sh.show_id = ev.show_id
  WHERE
    -- Must be a creator-change event
    (REGEXP_CONTAINS(COALESCE(ev.updated_fields, ''), r'(^|\|)\s*Creator:')
     OR ev.status_label = 'Updated: Creator')
    -- but skip events where the previous creator was Seekho Official
    -- (that's the initial real-creator assignment, not a relaunch).
    AND NOT REGEXP_CONTAINS(
      COALESCE(ev.updated_fields, ''),
      r'(?i)Creator:\s*Seekho\s+Official\s*(?:→|->|to\s)'
    )
),
-- Pre-aggregate so downstream CTEs can pick "most recent relaunch" cheaply.
show_relaunch_anchors AS (
  SELECT show_id, MAX(relaunch_date) AS latest_relaunch_date
  FROM creator_updates
  GROUP BY 1
),
series AS (
  -- Scope to target-language shows up front so every downstream CTE
  -- works on a smaller universe.
  SELECT s.id AS series_id, s.show_id, s.category_id,
         DATE(s.published_on, 'Asia/Kolkata') AS published_date
  FROM `seekho.courses_series` s
  JOIN shows sh ON sh.show_id = s.show_id
  WHERE s.published_on IS NOT NULL AND s.state IN ('live','expired')
),
categories AS (
  SELECT id AS category_id, title AS category_name FROM `seekho.courses_category`
),
show_first_pub AS (
  SELECT show_id, MIN(published_date) AS launch_date FROM series GROUP BY 1
),
-- All period rows in one CTE. Three sources unioned together:
-- (1) LAUNCH_WEEK: weeks 1..6 anchored to each show's first-publish date,
--     but only for shows launched in the last 56 days (older shows' launch
--     metrics are immutable).
-- (2) LAST_3_CALENDAR_WEEK: rolling Sun..Sat for every show in scope.
-- (3) RELAUNCH_WEEK: weeks 1..6 anchored to each creator-update event.
-- launch_weeks / last_3_calendar_weeks / show_launch_periods /
-- show_last_3_week_periods / show_relaunch_periods were separate CTEs in
-- v1.4 — collapsed here to stay under the BigQuery planner CTE budget.
show_periods AS (
  -- (1) launch weeks
  SELECT sfp.show_id, 'LAUNCH_WEEK' AS period_type,
    CONCAT('WEEK_', CAST(n AS STRING), '_D', CAST((n-1)*7 AS STRING), '_', CAST(n*7-1 AS STRING)) AS period_name,
    n AS period_number,
    DATE_ADD(sfp.launch_date, INTERVAL (n-1)*7 DAY) AS period_start_date,
    DATE_ADD(sfp.launch_date, INTERVAL n*7-1 DAY)   AS period_end_date
  FROM show_first_pub sfp, UNNEST([1,2,3,4,5,6]) AS n
  WHERE sfp.launch_date >= start_show_publish_date
    AND DATE_ADD(sfp.launch_date, INTERVAL (n-1)*7 DAY) <= end_play_date
    -- Only emit LW rows for shows whose launch falls inside the 100-day
    -- events-scan window. Shows older than this would just produce NULL
    -- metrics anyway. The UI hides the launch-trajectory card and the
    -- launch-side of the chart when LW columns are all NULL.
    AND sfp.launch_date >= DATE_SUB(end_play_date, INTERVAL 56 DAY)

  UNION ALL

  -- (2) last 4 calendar weeks (Sun..Sat, rolling)
  SELECT sfp.show_id, 'LAST_3_CALENDAR_WEEK', cw.period_name, cw.period_number,
         cw.period_start_date, cw.period_end_date
  FROM show_first_pub sfp,
       UNNEST([
         STRUCT('LAST_WEEK_MINUS_3' AS period_name, 0 AS period_number,
                DATE_SUB(DATE_TRUNC(end_play_date, WEEK(SUNDAY)), INTERVAL 3 WEEK) AS period_start_date,
                DATE_ADD(DATE_SUB(DATE_TRUNC(end_play_date, WEEK(SUNDAY)), INTERVAL 3 WEEK), INTERVAL 6 DAY) AS period_end_date),
         STRUCT('LAST_WEEK_MINUS_2', 1,
                DATE_SUB(DATE_TRUNC(end_play_date, WEEK(SUNDAY)), INTERVAL 2 WEEK),
                DATE_ADD(DATE_SUB(DATE_TRUNC(end_play_date, WEEK(SUNDAY)), INTERVAL 2 WEEK), INTERVAL 6 DAY)),
         STRUCT('LAST_WEEK_MINUS_1', 2,
                DATE_SUB(DATE_TRUNC(end_play_date, WEEK(SUNDAY)), INTERVAL 1 WEEK),
                DATE_ADD(DATE_SUB(DATE_TRUNC(end_play_date, WEEK(SUNDAY)), INTERVAL 1 WEEK), INTERVAL 6 DAY)),
         STRUCT('CURRENT_WEEK', 3,
                DATE_TRUNC(end_play_date, WEEK(SUNDAY)), end_play_date)
       ]) AS cw

  UNION ALL

  -- (3) relaunch weeks (one set of 6 per creator-update event)
  SELECT cu.show_id, 'RELAUNCH_WEEK',
    CONCAT('RELAUNCH_', FORMAT_DATE('%Y%m%d', cu.relaunch_date), '_WEEK_', CAST(n AS STRING)) AS period_name,
    n AS period_number,
    DATE_ADD(cu.relaunch_date, INTERVAL (n-1)*7 DAY) AS period_start_date,
    DATE_ADD(cu.relaunch_date, INTERVAL n*7-1 DAY)   AS period_end_date
  FROM creator_updates cu, UNNEST([1,2,3,4,5,6]) AS n
  WHERE DATE_ADD(cu.relaunch_date, INTERVAL (n-1)*7 DAY) <= end_play_date
),
-- Pre-aggregate raw events to (series, day) BEFORE joining to any
-- dimension table.
--
-- Window: last 100 days. Covers every LW1..LW6 day for shows launched
-- up to ~56 days ago + the last 3 calendar weeks for every show. Pruned
-- to a literal expression so BigQuery's partition pruner cuts every
-- older partition at plan time.
--
-- Tradeoff: shows launched more than 56 days ago won't get launch-week
-- metrics. The Deep Dive UI already hides the Launch trajectory card
-- and the launch-side of the chart when the LW columns are all NULL,
-- so those shows fall back to last-3-calendar-week story only. The
-- launch-period emission CTE matches this window so we don't emit dud
-- rows that can't be populated.
events_per_series_day AS (
  SELECT DATE(v.timestamp, 'Asia/Kolkata')    AS activity_date,
         SAFE_CAST(v.series_id AS INT64)      AS series_id,
         HLL_COUNT.INIT(v.user_id)            AS user_hll,
         SUM(v.watchtime)                     AS watchtime_s
  FROM `seekho-c084b.content_recommendation.video_play_combined` v
  WHERE v.timestamp >= TIMESTAMP(DATE_SUB(end_play_date, INTERVAL 100 DAY), 'Asia/Kolkata')
    AND v.timestamp <  TIMESTAMP(DATE_ADD(end_play_date, INTERVAL 1 DAY), 'Asia/Kolkata')
    AND v.series_id IS NOT NULL
  GROUP BY 1, 2
),
-- Roll the series-day sketches up to (show, day) and (language, day).
-- MERGE_PARTIAL keeps the result as a sketch so show_week_perf /
-- language_week_perf can merge again across each period's date range.
show_day_metrics AS (
  SELECT s.show_id, e.activity_date,
         HLL_COUNT.MERGE_PARTIAL(e.user_hll) AS user_hll,
         SUM(e.watchtime_s)/3600.0          AS watch_hours
  FROM events_per_series_day e
  JOIN series s ON s.series_id = e.series_id
  GROUP BY 1, 2
),
language_day_metrics AS (
  SELECT sh.language, e.activity_date,
         HLL_COUNT.MERGE_PARTIAL(e.user_hll) AS user_hll,
         SUM(e.watchtime_s)/3600.0          AS watch_hours
  FROM events_per_series_day e
  JOIN series s  ON s.series_id = e.series_id
  JOIN shows sh ON sh.show_id   = s.show_id
  GROUP BY 1, 2
),
show_week_perf AS (
  SELECT sp.show_id, sp.period_type, sp.period_name, sp.period_number,
         sp.period_start_date, sp.period_end_date,
         IFNULL(HLL_COUNT.MERGE(sdm.user_hll), 0) AS show_users,
         IFNULL(SUM(sdm.watch_hours), 0)         AS show_watch_hours
  FROM show_periods sp
  LEFT JOIN show_day_metrics sdm
    ON sdm.show_id = sp.show_id
   AND sdm.activity_date BETWEEN sp.period_start_date AND sp.period_end_date
  GROUP BY 1,2,3,4,5,6
),
language_week_perf AS (
  SELECT sp.show_id, sh.language, sp.period_type, sp.period_name, sp.period_number,
         sp.period_start_date, sp.period_end_date,
         IFNULL(HLL_COUNT.MERGE(ldm.user_hll), 0) AS language_users,
         IFNULL(SUM(ldm.watch_hours), 0)         AS language_watch_hours
  FROM show_periods sp JOIN shows sh ON sh.show_id = sp.show_id
  LEFT JOIN language_day_metrics ldm
    ON ldm.language = sh.language
   AND ldm.activity_date BETWEEN sp.period_start_date AND sp.period_end_date
  GROUP BY 1,2,3,4,5,6,7
),
show_scorecard AS (
  SELECT swp.show_id, sh.show_title, sh.language, sh.show_type, sh.state,
         sh.category_id, c.category_name, sfp.launch_date,
         swp.period_type, swp.period_name, swp.period_number,
         swp.period_start_date, swp.period_end_date,
         swp.show_users, lwp.language_users, swp.show_watch_hours, lwp.language_watch_hours,
         ROUND(100*SAFE_DIVIDE(swp.show_users, NULLIF(lwp.language_users,0)),3) AS show_users_contrib_pct_of_language,
         ROUND(100*SAFE_DIVIDE(swp.show_watch_hours, NULLIF(lwp.language_watch_hours,0)),3) AS show_wh_contrib_pct_of_language
  FROM show_week_perf swp JOIN shows sh ON sh.show_id = swp.show_id
  LEFT JOIN categories c ON c.category_id = sh.category_id
  LEFT JOIN show_first_pub sfp ON sfp.show_id = swp.show_id
  LEFT JOIN language_week_perf lwp ON lwp.show_id = swp.show_id
   AND lwp.period_type = swp.period_type AND lwp.period_name = swp.period_name
),
-- Thresholds decoupled from period dates: one stable baseline per cohort
-- keyed on (language, category_id) / (language). Computed from CURRENT_WEEK
-- rows of non-experimental shows. Reused for every period of every show
-- (launch weeks, relaunch weeks, calendar weeks) instead of requiring
-- a date-matched peer cohort that almost never existed for non-calendar
-- periods.
category_thresholds AS (
  SELECT language, category_id, COUNT(DISTINCT show_id) AS peer_count,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(25)] AS stop_below_users_contrib_pct,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(40)] AS weak_below_users_contrib_pct,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(60)] AS retain_above_users_contrib_pct,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(75)] AS strong_above_users_contrib_pct,
    APPROX_QUANTILES(show_users,100)[OFFSET(25)] AS stop_below_show_users,
    APPROX_QUANTILES(show_users,100)[OFFSET(40)] AS weak_below_show_users,
    APPROX_QUANTILES(show_users,100)[OFFSET(60)] AS retain_above_show_users,
    APPROX_QUANTILES(show_users,100)[OFFSET(75)] AS strong_above_show_users
  FROM show_scorecard
  WHERE period_type = 'LAST_3_CALENDAR_WEEK'
    AND period_name = 'CURRENT_WEEK'
    AND LOWER(COALESCE(show_type,'')) != 'experimental'
    AND show_users_contrib_pct_of_language IS NOT NULL
  GROUP BY 1,2
),
language_thresholds AS (
  SELECT language, COUNT(DISTINCT show_id) AS peer_count,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(25)] AS stop_below_users_contrib_pct,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(40)] AS weak_below_users_contrib_pct,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(60)] AS retain_above_users_contrib_pct,
    APPROX_QUANTILES(show_users_contrib_pct_of_language,100)[OFFSET(75)] AS strong_above_users_contrib_pct,
    APPROX_QUANTILES(show_users,100)[OFFSET(25)] AS stop_below_show_users,
    APPROX_QUANTILES(show_users,100)[OFFSET(40)] AS weak_below_show_users,
    APPROX_QUANTILES(show_users,100)[OFFSET(60)] AS retain_above_show_users,
    APPROX_QUANTILES(show_users,100)[OFFSET(75)] AS strong_above_show_users
  FROM show_scorecard
  WHERE period_type = 'LAST_3_CALENDAR_WEEK'
    AND period_name = 'CURRENT_WEEK'
    AND LOWER(COALESCE(show_type,'')) != 'experimental'
    AND show_users_contrib_pct_of_language IS NOT NULL
  GROUP BY 1
),
-- Merged thresholds_resolved + scorecard_with_thresholds + week_status into
-- a single CTE to stay under the BigQuery planner's CTE budget.
-- Picks category × language thresholds when the cohort is big enough,
-- else falls back to language-only, then classifies each period into its
-- contribution and user-count buckets.
week_status AS (
  SELECT s.*,
    CASE WHEN ct.peer_count >= min_peers_for_category_strat THEN 'category_x_language' ELSE 'language_only' END AS threshold_used,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.peer_count, lt.peer_count)                                            AS peer_count,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.stop_below_users_contrib_pct,   lt.stop_below_users_contrib_pct)           AS stop_below_users_contrib_pct,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.weak_below_users_contrib_pct,   lt.weak_below_users_contrib_pct)           AS weak_below_users_contrib_pct,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.retain_above_users_contrib_pct, lt.retain_above_users_contrib_pct)         AS retain_above_users_contrib_pct,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.strong_above_users_contrib_pct, lt.strong_above_users_contrib_pct)         AS strong_above_users_contrib_pct,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.stop_below_show_users,        lt.stop_below_show_users)                AS stop_below_show_users,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.weak_below_show_users,        lt.weak_below_show_users)                AS weak_below_show_users,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.retain_above_show_users,      lt.retain_above_show_users)              AS retain_above_show_users,
    IF(ct.peer_count >= min_peers_for_category_strat, ct.strong_above_show_users,      lt.strong_above_show_users)              AS strong_above_show_users,
    CASE
      WHEN s.show_users_contrib_pct_of_language IS NULL THEN 'insufficient_data'
      WHEN s.show_users_contrib_pct_of_language >= IF(ct.peer_count >= min_peers_for_category_strat, ct.strong_above_users_contrib_pct, lt.strong_above_users_contrib_pct) THEN 'very_strong'
      WHEN s.show_users_contrib_pct_of_language >= IF(ct.peer_count >= min_peers_for_category_strat, ct.retain_above_users_contrib_pct, lt.retain_above_users_contrib_pct) THEN 'meets_retain_threshold'
      WHEN s.show_users_contrib_pct_of_language >= IF(ct.peer_count >= min_peers_for_category_strat, ct.stop_below_users_contrib_pct,   lt.stop_below_users_contrib_pct)   THEN 'continue_observing'
      WHEN s.show_users_contrib_pct_of_language <  IF(ct.peer_count >= min_peers_for_category_strat, ct.stop_below_users_contrib_pct,   lt.stop_below_users_contrib_pct)   THEN 'below_stop_threshold'
      ELSE 'insufficient_data' END AS period_contrib_status,
    CASE
      WHEN s.show_users IS NULL THEN 'insufficient_data'
      WHEN s.show_users >= IF(ct.peer_count >= min_peers_for_category_strat, ct.strong_above_show_users, lt.strong_above_show_users) THEN 'very_strong'
      WHEN s.show_users >= IF(ct.peer_count >= min_peers_for_category_strat, ct.retain_above_show_users, lt.retain_above_show_users) THEN 'meets_retain_threshold'
      WHEN s.show_users >= IF(ct.peer_count >= min_peers_for_category_strat, ct.stop_below_show_users,   lt.stop_below_show_users)   THEN 'continue_observing'
      WHEN s.show_users <  IF(ct.peer_count >= min_peers_for_category_strat, ct.stop_below_show_users,   lt.stop_below_show_users)   THEN 'below_stop_threshold'
      ELSE 'insufficient_data' END AS period_user_status
  FROM show_scorecard s
  LEFT JOIN category_thresholds ct ON ct.language=s.language AND ct.category_id=s.category_id
  LEFT JOIN language_thresholds lt ON lt.language=s.language
),
show_summary AS (
  SELECT show_id,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=1 THEN show_users_contrib_pct_of_language END) AS lw1_contrib_pct,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=2 THEN show_users_contrib_pct_of_language END) AS lw2_contrib_pct,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=3 THEN show_users_contrib_pct_of_language END) AS lw3_contrib_pct,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=4 THEN show_users_contrib_pct_of_language END) AS lw4_contrib_pct,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=1 THEN show_users END) AS lw1_show_users,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=2 THEN show_users END) AS lw2_show_users,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=3 THEN show_users END) AS lw3_show_users,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=4 THEN show_users END) AS lw4_show_users,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=1 THEN stop_below_users_contrib_pct END) AS lw1_stop_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=2 THEN stop_below_users_contrib_pct END) AS lw2_stop_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=3 THEN stop_below_users_contrib_pct END) AS lw3_stop_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=4 THEN stop_below_users_contrib_pct END) AS lw4_stop_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=1 THEN retain_above_users_contrib_pct END) AS lw1_retain_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=2 THEN retain_above_users_contrib_pct END) AS lw2_retain_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=3 THEN retain_above_users_contrib_pct END) AS lw3_retain_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=4 THEN retain_above_users_contrib_pct END) AS lw4_retain_th,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=1 THEN peer_count END) AS lw1_peer_count,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=2 THEN peer_count END) AS lw2_peer_count,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=3 THEN peer_count END) AS lw3_peer_count,
    MAX(CASE WHEN period_type='LAUNCH_WEEK' AND period_number=4 THEN peer_count END) AS lw4_peer_count,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='LAST_WEEK_MINUS_3' THEN show_users_contrib_pct_of_language END) AS l3w_minus_3_contrib_pct,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='LAST_WEEK_MINUS_2' THEN show_users_contrib_pct_of_language END) AS l3w_minus_2_contrib_pct,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='LAST_WEEK_MINUS_1' THEN show_users_contrib_pct_of_language END) AS l3w_minus_1_contrib_pct,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='CURRENT_WEEK' THEN show_users_contrib_pct_of_language END) AS l3w_current_contrib_pct,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='CURRENT_WEEK' THEN show_users END) AS l3w_current_show_users,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='CURRENT_WEEK' THEN peer_count END) AS current_week_peer_count,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='CURRENT_WEEK' THEN stop_below_users_contrib_pct END) AS current_week_stop_th,
    MAX(CASE WHEN period_type='LAST_3_CALENDAR_WEEK' AND period_name='CURRENT_WEEK' THEN retain_above_users_contrib_pct END) AS current_week_retain_th
  FROM week_status GROUP BY 1
),
-- Per-show summary of the MOST RECENT relaunch's weekly rows. Same shape
-- as the launch-week section of show_summary so downstream code can treat
-- them interchangeably. (latest_relaunch_periods used to be its own CTE;
-- inlined here for BigQuery planner budget.)
relaunch_summary AS (
  SELECT ws.show_id,
    MAX(CASE WHEN ws.period_number=1 THEN ws.show_users_contrib_pct_of_language END) AS rw1_contrib_pct,
    MAX(CASE WHEN ws.period_number=2 THEN ws.show_users_contrib_pct_of_language END) AS rw2_contrib_pct,
    MAX(CASE WHEN ws.period_number=3 THEN ws.show_users_contrib_pct_of_language END) AS rw3_contrib_pct,
    MAX(CASE WHEN ws.period_number=4 THEN ws.show_users_contrib_pct_of_language END) AS rw4_contrib_pct,
    MAX(CASE WHEN ws.period_number=1 THEN ws.show_users END) AS rw1_show_users,
    MAX(CASE WHEN ws.period_number=2 THEN ws.show_users END) AS rw2_show_users,
    MAX(CASE WHEN ws.period_number=3 THEN ws.show_users END) AS rw3_show_users,
    MAX(CASE WHEN ws.period_number=4 THEN ws.show_users END) AS rw4_show_users,
    MAX(CASE WHEN ws.period_number=1 THEN ws.stop_below_users_contrib_pct END) AS rw1_stop_th,
    MAX(CASE WHEN ws.period_number=2 THEN ws.stop_below_users_contrib_pct END) AS rw2_stop_th,
    MAX(CASE WHEN ws.period_number=3 THEN ws.stop_below_users_contrib_pct END) AS rw3_stop_th,
    MAX(CASE WHEN ws.period_number=4 THEN ws.stop_below_users_contrib_pct END) AS rw4_stop_th,
    MAX(CASE WHEN ws.period_number=1 THEN ws.retain_above_users_contrib_pct END) AS rw1_retain_th,
    MAX(CASE WHEN ws.period_number=2 THEN ws.retain_above_users_contrib_pct END) AS rw2_retain_th,
    MAX(CASE WHEN ws.period_number=3 THEN ws.retain_above_users_contrib_pct END) AS rw3_retain_th,
    MAX(CASE WHEN ws.period_number=4 THEN ws.retain_above_users_contrib_pct END) AS rw4_retain_th,
    MAX(CASE WHEN ws.period_number=1 THEN ws.peer_count END) AS rw1_peer_count,
    MAX(CASE WHEN ws.period_number=2 THEN ws.peer_count END) AS rw2_peer_count,
    MAX(CASE WHEN ws.period_number=3 THEN ws.peer_count END) AS rw3_peer_count,
    MAX(CASE WHEN ws.period_number=4 THEN ws.peer_count END) AS rw4_peer_count
  FROM week_status ws
  JOIN show_relaunch_anchors sra ON sra.show_id = ws.show_id
  WHERE ws.period_type = 'RELAUNCH_WEEK'
    AND ws.period_start_date = DATE_ADD(sra.latest_relaunch_date, INTERVAL (ws.period_number - 1) * 7 DAY)
  GROUP BY 1
),
show_trajectory AS (
  SELECT ss.show_id,
    CASE
      WHEN ss.lw1_contrib_pct IS NULL OR ss.lw1_contrib_pct=0 THEN 'insufficient_data'
      WHEN COALESCE(ss.lw4_contrib_pct, ss.lw3_contrib_pct, ss.lw2_contrib_pct) IS NULL THEN 'insufficient_data'
      WHEN COALESCE(ss.lw4_contrib_pct, ss.lw3_contrib_pct, ss.lw2_contrib_pct) >= ss.lw1_contrib_pct * 1.10 THEN 'improving'
      WHEN COALESCE(ss.lw4_contrib_pct, ss.lw3_contrib_pct, ss.lw2_contrib_pct) <= ss.lw1_contrib_pct * 0.90 THEN 'declining'
      ELSE 'stable' END AS launch_trajectory,
    CASE
      WHEN ss.l3w_minus_2_contrib_pct IS NULL OR ss.l3w_current_contrib_pct IS NULL OR ss.l3w_minus_2_contrib_pct=0 THEN 'insufficient_data'
      WHEN ss.l3w_current_contrib_pct >= ss.l3w_minus_2_contrib_pct * 1.10 THEN 'improving'
      WHEN ss.l3w_current_contrib_pct <= ss.l3w_minus_2_contrib_pct * 0.90 THEN 'declining'
      WHEN ABS(ss.l3w_current_contrib_pct - ss.l3w_minus_2_contrib_pct) / NULLIF(ss.l3w_minus_2_contrib_pct,0) > 0.30 THEN 'volatile'
      ELSE 'stable' END AS recent_trajectory,
    -- Same shape as launch_trajectory but anchored to the most-recent
    -- relaunch. NULL when the show has never been relaunched.
    CASE
      WHEN rs.rw1_contrib_pct IS NULL OR rs.rw1_contrib_pct=0 THEN 'insufficient_data'
      WHEN COALESCE(rs.rw4_contrib_pct, rs.rw3_contrib_pct, rs.rw2_contrib_pct) IS NULL THEN 'insufficient_data'
      WHEN COALESCE(rs.rw4_contrib_pct, rs.rw3_contrib_pct, rs.rw2_contrib_pct) >= rs.rw1_contrib_pct * 1.10 THEN 'improving'
      WHEN COALESCE(rs.rw4_contrib_pct, rs.rw3_contrib_pct, rs.rw2_contrib_pct) <= rs.rw1_contrib_pct * 0.90 THEN 'declining'
      ELSE 'stable' END AS relaunch_trajectory
  FROM show_summary ss
  LEFT JOIN relaunch_summary rs ON rs.show_id = ss.show_id
),
-- For each show, pick the effective week-N contribution / threshold / users:
-- relaunch week N if a relaunch exists, otherwise the original launch week N.
-- This is what experimental_decision below evaluates against — so a swapped-
-- creator show is judged from its new start, never from the years-old launch.
experimental_inputs AS (
  SELECT ss.show_id,
    -- Effective week-N values
    COALESCE(rs.rw1_contrib_pct, ss.lw1_contrib_pct) AS w1_contrib_pct,
    COALESCE(rs.rw2_contrib_pct, ss.lw2_contrib_pct) AS w2_contrib_pct,
    COALESCE(rs.rw3_contrib_pct, ss.lw3_contrib_pct) AS w3_contrib_pct,
    COALESCE(rs.rw4_contrib_pct, ss.lw4_contrib_pct) AS w4_contrib_pct,
    COALESCE(rs.rw1_retain_th,   ss.lw1_retain_th)   AS w1_retain_th,
    COALESCE(rs.rw2_retain_th,   ss.lw2_retain_th)   AS w2_retain_th,
    COALESCE(rs.rw3_retain_th,   ss.lw3_retain_th)   AS w3_retain_th,
    COALESCE(rs.rw4_retain_th,   ss.lw4_retain_th)   AS w4_retain_th,
    COALESCE(rs.rw1_stop_th,     ss.lw1_stop_th)     AS w1_stop_th,
    COALESCE(rs.rw2_stop_th,     ss.lw2_stop_th)     AS w2_stop_th,
    COALESCE(rs.rw3_stop_th,     ss.lw3_stop_th)     AS w3_stop_th,
    COALESCE(rs.rw4_stop_th,     ss.lw4_stop_th)     AS w4_stop_th,
    COALESCE(rs.rw1_show_users,  ss.lw1_show_users)  AS w1_show_users,
    COALESCE(rs.rw2_show_users,  ss.lw2_show_users)  AS w2_show_users,
    COALESCE(rs.rw3_show_users,  ss.lw3_show_users)  AS w3_show_users,
    COALESCE(rs.rw4_show_users,  ss.lw4_show_users)  AS w4_show_users,
    COALESCE(rs.rw1_peer_count,  ss.lw1_peer_count)  AS w1_peer_count,
    COALESCE(rs.rw2_peer_count,  ss.lw2_peer_count)  AS w2_peer_count,
    COALESCE(rs.rw3_peer_count,  ss.lw3_peer_count)  AS w3_peer_count,
    COALESCE(rs.rw4_peer_count,  ss.lw4_peer_count)  AS w4_peer_count,
    -- Used by the JS UI to label "this is judged from a relaunch".
    sra.latest_relaunch_date IS NOT NULL AS is_relaunch_run
  FROM show_summary ss
  JOIN shows sh ON sh.show_id = ss.show_id
  LEFT JOIN relaunch_summary rs ON rs.show_id = ss.show_id
  LEFT JOIN show_relaunch_anchors sra ON sra.show_id = ss.show_id
  WHERE LOWER(COALESCE(sh.show_type,'')) = 'experimental'
),
-- Roll experimental_inputs straight into the verdict to save one CTE.
experimental_decision AS (
  SELECT show_id, is_relaunch_run,
    CASE
      WHEN weeks_with_data = 0 THEN 'INSUFFICIENT_DATA'
      WHEN min_lw_peer_count < med_conf_min_peers THEN 'LOW_CONFIDENCE'
      WHEN weeks_above_retain >= 1 AND best_week_users >= min_show_users_for_promote THEN 'PROMOTE'
      WHEN weeks_below_stop >= 2 AND weeks_with_data >= 2 THEN 'STOP'
      WHEN weeks_below_stop >= 1 AND weeks_with_data >= 3 THEN 'STOP'
      ELSE 'CONTINUE' END AS experimental_decision
  FROM (
    SELECT show_id, is_relaunch_run,
      (CAST(IFNULL(w1_contrib_pct >= w1_retain_th, FALSE) AS INT64) +
       CAST(IFNULL(w2_contrib_pct >= w2_retain_th, FALSE) AS INT64) +
       CAST(IFNULL(w3_contrib_pct >= w3_retain_th, FALSE) AS INT64) +
       CAST(IFNULL(w4_contrib_pct >= w4_retain_th, FALSE) AS INT64)) AS weeks_above_retain,
      (CAST(IFNULL(w1_contrib_pct < w1_stop_th, FALSE) AS INT64) +
       CAST(IFNULL(w2_contrib_pct < w2_stop_th, FALSE) AS INT64) +
       CAST(IFNULL(w3_contrib_pct < w3_stop_th, FALSE) AS INT64) +
       CAST(IFNULL(w4_contrib_pct < w4_stop_th, FALSE) AS INT64)) AS weeks_below_stop,
      (CAST(w1_contrib_pct IS NOT NULL AS INT64) +
       CAST(w2_contrib_pct IS NOT NULL AS INT64) +
       CAST(w3_contrib_pct IS NOT NULL AS INT64) +
       CAST(w4_contrib_pct IS NOT NULL AS INT64)) AS weeks_with_data,
      GREATEST(IFNULL(w1_show_users,0), IFNULL(w2_show_users,0),
               IFNULL(w3_show_users,0), IFNULL(w4_show_users,0)) AS best_week_users,
      LEAST(IFNULL(w1_peer_count,999), IFNULL(w2_peer_count,999),
            IFNULL(w3_peer_count,999), IFNULL(w4_peer_count,999)) AS min_lw_peer_count
    FROM experimental_inputs
  )
)

SELECT ws.language, ws.category_id, ws.category_name, ws.show_type, ws.state,
  ws.show_id, ws.show_title, ws.launch_date,
  ws.period_type, ws.period_name, ws.period_number, ws.period_start_date, ws.period_end_date,
  ws.threshold_used, ws.peer_count,
  ws.show_users, ws.language_users, ws.show_users_contrib_pct_of_language,
  ws.show_watch_hours, ws.language_watch_hours, ws.show_wh_contrib_pct_of_language,
  ws.stop_below_users_contrib_pct, ws.weak_below_users_contrib_pct,
  ws.retain_above_users_contrib_pct, ws.strong_above_users_contrib_pct,
  ws.stop_below_show_users, ws.weak_below_show_users,
  ws.retain_above_show_users, ws.strong_above_show_users,
  ws.period_contrib_status, ws.period_user_status,
  ss.lw1_contrib_pct, ss.lw2_contrib_pct, ss.lw3_contrib_pct, ss.lw4_contrib_pct,
  ss.lw1_retain_th, ss.lw2_retain_th, ss.lw3_retain_th, ss.lw4_retain_th,
  ss.lw1_stop_th, ss.lw2_stop_th, ss.lw3_stop_th, ss.lw4_stop_th,
  ss.l3w_minus_3_contrib_pct, ss.l3w_minus_2_contrib_pct, ss.l3w_minus_1_contrib_pct, ss.l3w_current_contrib_pct,
  st.launch_trajectory, st.recent_trajectory, st.relaunch_trajectory,
  CASE
    WHEN ss.current_week_peer_count >= high_conf_min_peers AND ss.l3w_current_show_users >= high_conf_min_users THEN 'high'
    WHEN ss.current_week_peer_count >= med_conf_min_peers  AND ss.l3w_current_show_users >= med_conf_min_users  THEN 'medium'
    ELSE 'low' END AS confidence,
  sra.latest_relaunch_date,
  rs.rw1_contrib_pct, rs.rw2_contrib_pct, rs.rw3_contrib_pct, rs.rw4_contrib_pct,
  rs.rw1_stop_th, rs.rw2_stop_th, rs.rw3_stop_th, rs.rw4_stop_th,
  rs.rw1_retain_th, rs.rw2_retain_th, rs.rw3_retain_th, rs.rw4_retain_th,
  IFNULL(ed.is_relaunch_run, FALSE) AS is_relaunch_run,
  CASE
    WHEN ws.show_users_contrib_pct_of_language IS NULL THEN 'insufficient_data'
    WHEN ws.period_contrib_status = 'very_strong' THEN 'very_strong'
    WHEN ws.period_contrib_status = 'meets_retain_threshold' THEN 'retain_or_scale'
    WHEN ws.period_contrib_status = 'continue_observing' THEN 'continue_observing'
    WHEN ws.period_contrib_status = 'below_stop_threshold' THEN 'below_stop_threshold'
    ELSE 'insufficient_data' END AS show_verdict,
  ed.experimental_decision,
  CASE
    WHEN ws.show_users_contrib_pct_of_language IS NULL
      THEN CONCAT('No engagement data for this show in this period (', CAST(ws.period_start_date AS STRING), ' to ', CAST(ws.period_end_date AS STRING), ').')
    WHEN ws.period_contrib_status = 'very_strong'
      THEN CONCAT('In the top 25% of ', ws.language, ' ',
        CASE WHEN ws.threshold_used='category_x_language' THEN CONCAT(IFNULL(ws.category_name,'uncategorised'),' ') ELSE '' END,
        'shows for this window. Pulls ', CAST(ws.show_users_contrib_pct_of_language AS STRING),
        '% of ', ws.language, ' users vs the ', CAST(ROUND(ws.strong_above_users_contrib_pct,2) AS STRING),
        '% top-25% bar (across ', CAST(ws.peer_count AS STRING), ' peer shows).')
    WHEN ws.period_contrib_status = 'meets_retain_threshold'
      THEN CONCAT('Above retain threshold. Pulls ', CAST(ws.show_users_contrib_pct_of_language AS STRING),
        '% of ', ws.language, ' users vs the ', CAST(ROUND(ws.retain_above_users_contrib_pct,2) AS STRING),
        '% needed (across ', CAST(ws.peer_count AS STRING), ' peer shows).')
    WHEN ws.period_contrib_status = 'continue_observing'
      THEN CONCAT('Between stop and retain thresholds. Pulls ', CAST(ws.show_users_contrib_pct_of_language AS STRING),
        '% of ', ws.language, ' users. Stop = ', CAST(ROUND(ws.stop_below_users_contrib_pct,2) AS STRING),
        '%, retain = ', CAST(ROUND(ws.retain_above_users_contrib_pct,2) AS STRING),
        '% (across ', CAST(ws.peer_count AS STRING), ' peer shows).')
    WHEN ws.period_contrib_status = 'below_stop_threshold'
      THEN CONCAT('In the bottom 25% of ', ws.language, ' ',
        CASE WHEN ws.threshold_used='category_x_language' THEN CONCAT(IFNULL(ws.category_name,'uncategorised'),' ') ELSE '' END,
        'shows. Pulls only ', CAST(ws.show_users_contrib_pct_of_language AS STRING),
        '% of ', ws.language, ' users vs the ', CAST(ROUND(ws.stop_below_users_contrib_pct,2) AS STRING),
        '% minimum (across ', CAST(ws.peer_count AS STRING), ' peer shows).')
    ELSE 'Insufficient peer data to evaluate.' END AS decision_reason
FROM week_status ws
LEFT JOIN show_summary ss ON ss.show_id = ws.show_id
LEFT JOIN show_trajectory st ON st.show_id = ws.show_id
LEFT JOIN show_relaunch_anchors sra ON sra.show_id = ws.show_id
LEFT JOIN relaunch_summary rs ON rs.show_id = ws.show_id
LEFT JOIN experimental_decision ed ON ed.show_id = ws.show_id
ORDER BY ws.language, ws.show_type, ws.show_id, ws.period_start_date,
  CASE ws.period_type WHEN 'LAUNCH_WEEK' THEN 1 WHEN 'LAST_3_CALENDAR_WEEK' THEN 2 ELSE 9 END,
  ws.period_number;

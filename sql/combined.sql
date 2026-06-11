-- =====================================================================
-- COMBINED EXPORT — all three datasets in ONE query / ONE CSV.
-- Each source query is wrapped as a self-contained subquery and serialized
-- row-by-row with TO_JSON_STRING, tagged by `dataset` (eval | fatigue | hdc).
-- Output columns: dataset, row_json. The dashboard splits this back into the
-- three datasets (parsing row_json) and runs the identical pipeline — so the
-- data is byte-for-byte the same as uploading the three CSVs separately.
-- (DECLARE variables from the original queries are inlined here, since a
-- subquery cannot contain DECLARE statements.)
-- =====================================================================
SELECT 'eval' AS dataset, TO_JSON_STRING(t) AS row_json FROM (
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
  WHERE sfp.launch_date >= DATE '2020-01-01'
    AND DATE_ADD(sfp.launch_date, INTERVAL (n-1)*7 DAY) <= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY)
    -- Only emit LW rows for shows whose launch falls inside the 100-day
    -- events-scan window. Shows older than this would just produce NULL
    -- metrics anyway. The UI hides the launch-trajectory card and the
    -- launch-side of the chart when LW columns are all NULL.
    AND sfp.launch_date >= DATE_SUB(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), INTERVAL 56 DAY)

  UNION ALL

  -- (2) last 4 calendar weeks (Sun..Sat, rolling)
  SELECT sfp.show_id, 'LAST_3_CALENDAR_WEEK', cw.period_name, cw.period_number,
         cw.period_start_date, cw.period_end_date
  FROM show_first_pub sfp,
       UNNEST([
         STRUCT('LAST_WEEK_MINUS_3' AS period_name, 0 AS period_number,
                DATE_SUB(DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), WEEK(SUNDAY)), INTERVAL 3 WEEK) AS period_start_date,
                DATE_ADD(DATE_SUB(DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), WEEK(SUNDAY)), INTERVAL 3 WEEK), INTERVAL 6 DAY) AS period_end_date),
         STRUCT('LAST_WEEK_MINUS_2', 1,
                DATE_SUB(DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), WEEK(SUNDAY)), INTERVAL 2 WEEK),
                DATE_ADD(DATE_SUB(DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), WEEK(SUNDAY)), INTERVAL 2 WEEK), INTERVAL 6 DAY)),
         STRUCT('LAST_WEEK_MINUS_1', 2,
                DATE_SUB(DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), WEEK(SUNDAY)), INTERVAL 1 WEEK),
                DATE_ADD(DATE_SUB(DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), WEEK(SUNDAY)), INTERVAL 1 WEEK), INTERVAL 6 DAY)),
         STRUCT('CURRENT_WEEK', 3,
                DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), WEEK(SUNDAY)), DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY))
       ]) AS cw

  UNION ALL

  -- (3) relaunch weeks (one set of 6 per creator-update event)
  SELECT cu.show_id, 'RELAUNCH_WEEK',
    CONCAT('RELAUNCH_', FORMAT_DATE('%Y%m%d', cu.relaunch_date), '_WEEK_', CAST(n AS STRING)) AS period_name,
    n AS period_number,
    DATE_ADD(cu.relaunch_date, INTERVAL (n-1)*7 DAY) AS period_start_date,
    DATE_ADD(cu.relaunch_date, INTERVAL n*7-1 DAY)   AS period_end_date
  FROM creator_updates cu, UNNEST([1,2,3,4,5,6]) AS n
  WHERE DATE_ADD(cu.relaunch_date, INTERVAL (n-1)*7 DAY) <= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY)
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
  WHERE v.timestamp >= TIMESTAMP(DATE_SUB(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), INTERVAL 100 DAY), 'Asia/Kolkata')
    AND v.timestamp <  TIMESTAMP(DATE_ADD(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), INTERVAL 1 DAY), 'Asia/Kolkata')
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
    CASE WHEN ct.peer_count >= 5 THEN 'category_x_language' ELSE 'language_only' END AS threshold_used,
    IF(ct.peer_count >= 5, ct.peer_count, lt.peer_count)                                            AS peer_count,
    IF(ct.peer_count >= 5, ct.stop_below_users_contrib_pct,   lt.stop_below_users_contrib_pct)           AS stop_below_users_contrib_pct,
    IF(ct.peer_count >= 5, ct.weak_below_users_contrib_pct,   lt.weak_below_users_contrib_pct)           AS weak_below_users_contrib_pct,
    IF(ct.peer_count >= 5, ct.retain_above_users_contrib_pct, lt.retain_above_users_contrib_pct)         AS retain_above_users_contrib_pct,
    IF(ct.peer_count >= 5, ct.strong_above_users_contrib_pct, lt.strong_above_users_contrib_pct)         AS strong_above_users_contrib_pct,
    IF(ct.peer_count >= 5, ct.stop_below_show_users,        lt.stop_below_show_users)                AS stop_below_show_users,
    IF(ct.peer_count >= 5, ct.weak_below_show_users,        lt.weak_below_show_users)                AS weak_below_show_users,
    IF(ct.peer_count >= 5, ct.retain_above_show_users,      lt.retain_above_show_users)              AS retain_above_show_users,
    IF(ct.peer_count >= 5, ct.strong_above_show_users,      lt.strong_above_show_users)              AS strong_above_show_users,
    CASE
      WHEN s.show_users_contrib_pct_of_language IS NULL THEN 'insufficient_data'
      WHEN s.show_users_contrib_pct_of_language >= IF(ct.peer_count >= 5, ct.strong_above_users_contrib_pct, lt.strong_above_users_contrib_pct) THEN 'very_strong'
      WHEN s.show_users_contrib_pct_of_language >= IF(ct.peer_count >= 5, ct.retain_above_users_contrib_pct, lt.retain_above_users_contrib_pct) THEN 'meets_retain_threshold'
      WHEN s.show_users_contrib_pct_of_language >= IF(ct.peer_count >= 5, ct.stop_below_users_contrib_pct,   lt.stop_below_users_contrib_pct)   THEN 'continue_observing'
      WHEN s.show_users_contrib_pct_of_language <  IF(ct.peer_count >= 5, ct.stop_below_users_contrib_pct,   lt.stop_below_users_contrib_pct)   THEN 'below_stop_threshold'
      ELSE 'insufficient_data' END AS period_contrib_status,
    CASE
      WHEN s.show_users IS NULL THEN 'insufficient_data'
      WHEN s.show_users >= IF(ct.peer_count >= 5, ct.strong_above_show_users, lt.strong_above_show_users) THEN 'very_strong'
      WHEN s.show_users >= IF(ct.peer_count >= 5, ct.retain_above_show_users, lt.retain_above_show_users) THEN 'meets_retain_threshold'
      WHEN s.show_users >= IF(ct.peer_count >= 5, ct.stop_below_show_users,   lt.stop_below_show_users)   THEN 'continue_observing'
      WHEN s.show_users <  IF(ct.peer_count >= 5, ct.stop_below_show_users,   lt.stop_below_show_users)   THEN 'below_stop_threshold'
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
      WHEN min_lw_peer_count < 10 THEN 'LOW_CONFIDENCE'
      WHEN weeks_above_retain >= 1 AND best_week_users >= 500 THEN 'PROMOTE'
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
    WHEN ss.current_week_peer_count >= 20 AND ss.l3w_current_show_users >= 1000 THEN 'high'
    WHEN ss.current_week_peer_count >= 10  AND ss.l3w_current_show_users >= 500  THEN 'medium'
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
  ws.period_number
) t
UNION ALL
SELECT 'fatigue' AS dataset, TO_JSON_STRING(t) AS row_json FROM (
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
) t
UNION ALL
SELECT 'hdc' AS dataset, TO_JSON_STRING(t) AS row_json FROM (
--High Demand Content - Any Content that crosses p90 views / language-specific cap in 24 hours and also meets the completion target
--L0 → Series achieved both the required view threshold and completion rate threshold (High Distribution Content / top-performing content).
--L1 → Series achieved the required view threshold but failed the completion rate threshold (high reach, weak retention).
--L2 → Series achieved the completion rate threshold and crossed 1000 views, but did not qualify for HDC (strong engagement with meaningful scale).
--L3 → Series did not meet view or CR thresholds, but views are above the median (p50) for that day/language cohort (above-average performance).
--L4 → Series views fall between p25 and p50 for that day/language cohort (average to below-average performance).
--L5 → Series views are below p25 for that day/language cohort (low-performing content).
--L6 → Fallback category for any uncategorized or edge-case series.
--
-- View cap by language:
--   te (Telugu)   : 500
--   ta (Tamil)    : 330
--   kn (Kannada)  : 200
--   ml (Malayalam): 200

-- Rolling 10-day window: covers the tool's last-7-day window (today-8..today-2)
-- with margin, and keeps the video_play scan + joins bounded so the query
-- doesn't time out. Widen the INTERVAL if you need more history.

WITH

-- Step 1: Dates already settled in video_play (overlap guard for intraday)
settled_dates AS (
  SELECT DISTINCT DATE(`timestamp`, 'Asia/Kolkata') AS settled_date
  FROM `seekho-c084b.content_recommendation.video_play`
  WHERE DATE(`timestamp`, 'Asia/Kolkata') BETWEEN DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL 10 DAY) AND CURRENT_DATE("Asia/Kolkata")
),

-- Step 2: Unified watch events — settled + intraday (no double-counting)
watch_raw AS (
  SELECT
    `timestamp`                       AS event_ts,
    firebase_uid                      AS user_id,
    CAST(series_id AS INT64)          AS series_id,
    CAST(watchtime AS FLOAT64)        AS seconds
  FROM `seekho-c084b.content_recommendation.video_play`
  WHERE DATE(`timestamp`, 'Asia/Kolkata') BETWEEN DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL 10 DAY) AND CURRENT_DATE("Asia/Kolkata")
    AND package_name NOT IN (
        'com.bolo.android',
        'com.seekho.ios',
        'com.seekhoai.android',
        'com.seekhoglobal.ios',
        'com.seekhoglobal.android'
    )
    AND (
      source_screen NOT IN ('from_notification', 'sharing', 'from_moe_notification')
      OR source_screen IS NULL
    )

  UNION ALL

  SELECT
    `timestamp`                       AS event_ts,
    firebase_uid                      AS user_id,
    CAST(series_id AS INT64)          AS series_id,
    CAST(MAX(watchtime) AS FLOAT64)   AS seconds
  FROM `seekho-c084b.content_recommendation.video_play_intraday`
  WHERE DATE(`timestamp`, 'Asia/Kolkata') BETWEEN DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL 10 DAY) AND CURRENT_DATE("Asia/Kolkata")
    AND DATE(`timestamp`, 'Asia/Kolkata') NOT IN (SELECT settled_date FROM settled_dates)
    AND package_name NOT IN (
        'com.bolo.android',
        'com.seekho.ios',
        'com.seekhoai.android',
        'com.seekhoglobal.ios',
        'com.seekhoglobal.android'
    )
    AND (
      source_screen NOT IN ('from_notification', 'sharing', 'from_moe_notification')
      OR source_screen IS NULL
    )
  GROUP BY `timestamp`, firebase_uid, series_id
),

-- Step 3: BU mapping
bu_mapping AS (
  SELECT category_id, 'Awareness' AS bu_name FROM UNNEST([71,80,64,67,94,68,6,79,66,2,89,5,52,69,38,17,82,62,92,18,13,54,58,61,55,59,8,57,35,25,29,40,14,43,60,21,27,19,51,53,32,33,91,109,65,97,9,106,78,111,83,75,34,105,76,95,10,108,114,115,116,117,121]) AS category_id
  UNION ALL
  SELECT category_id, 'Income' FROM UNNEST([73,63,16,70,56,11,50,85,72,84,39,37,30,45,81,98,96]) AS category_id
  UNION ALL
  SELECT category_id, 'Skill' FROM UNNEST([88,77,4,86,90,49,74,107,48,46,103,1,12,42,7,3,22,23,15,47,28,44,36,31,100,101,20,93,102,41,99,24,110,104,87,112,113,118,119,120]) AS category_id
),

-- Step 4: Eligible series published in window
series_eligible AS (
  SELECT
    cs.id AS series_id,
    cs.title AS series_title,
    cs.show_id,
    csh.title AS show_name,
    cs.language,
    cs.category_id,
    COALESCE(bu.bu_name, 'Other') AS bu_name,
    cs.creator_id,
    cs.duration_s,
    DATETIME(TIMESTAMP(cs.approved_on), 'Asia/Kolkata') AS publish_ts_ist,
    DATETIME(TIMESTAMP_ADD(TIMESTAMP(cs.approved_on), INTERVAL 24 HOUR), 'Asia/Kolkata') AS publish_24h_ts_ist,
    DATE(cs.approved_on, "Asia/Kolkata") AS publish_date
  FROM `seekho-c084b.seekho.courses_series` cs
  LEFT JOIN `seekho-c084b.seekho.courses_show` csh ON cs.show_id = csh.id
  LEFT JOIN seekho.users_creatorinfo ci ON cs.creator_id = ci.profile_id
  LEFT JOIN seekho.users_userprofile up ON ci.profile_id = up.user_ptr_id
  LEFT JOIN bu_mapping bu ON cs.category_id = bu.category_id
  WHERE DATE(cs.approved_on, "Asia/Kolkata") BETWEEN DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL 10 DAY) AND CURRENT_DATE("Asia/Kolkata")
    AND cs.language in ('hi','ta','te','ml','kn')
    AND cs.duration_s > 0
    AND cs.approved_on IS NOT NULL
    AND (cs.state = 'live' OR cs.state = 'expired')
    AND up.is_quality_approved = TRUE
),

-- Step 5: Views + watch hours per series in first 24h
views_24h AS (
  SELECT
    se.series_id,
    se.series_title,
    se.show_id,
    se.show_name,
    se.language,
    se.bu_name,
    se.publish_date,
    se.duration_s,
    CASE
      WHEN COUNT(DISTINCT w.user_id) >= 1000
        THEN ROUND(COUNT(DISTINCT w.user_id), -2)
      ELSE COUNT(DISTINCT w.user_id)
    END AS views_24h,
    ROUND(SUM(COALESCE(w.seconds, 0)) / 3600.0, 2) AS watch_hours
  FROM series_eligible se
  LEFT JOIN watch_raw w
    ON w.series_id = se.series_id
   AND w.user_id IS NOT NULL
   AND DATETIME(w.event_ts, 'Asia/Kolkata') >= se.publish_ts_ist
   AND DATETIME(w.event_ts, 'Asia/Kolkata') <  se.publish_24h_ts_ist
  GROUP BY 1,2,3,4,5,6,7,8
),

-- Step 6: Per-user watch time in first 24h (for completion rate)
watch_user_24h AS (
  SELECT
    se.series_id,
    w.user_id,
    SUM(COALESCE(w.seconds, 0)) AS watch_time
  FROM series_eligible se
  JOIN watch_raw w
    ON w.series_id = se.series_id
   AND w.user_id IS NOT NULL
   AND DATETIME(w.event_ts, 'Asia/Kolkata') >= se.publish_ts_ist
   AND DATETIME(w.event_ts, 'Asia/Kolkata') <  se.publish_24h_ts_ist
  GROUP BY 1, 2
),

-- Step 7: Combine views + completions
series_metrics AS (
  SELECT
    v.publish_date,
    v.language,
    v.bu_name,
    v.series_id,
    v.series_title,
    v.show_id,
    v.show_name,
    v.duration_s,
    v.views_24h,
    v.watch_hours,
    COUNT(DISTINCT CASE
      WHEN SAFE_DIVIDE(w.watch_time, v.duration_s) >= 0.7
      THEN w.user_id
    END) AS completes_24h
  FROM views_24h v
  LEFT JOIN watch_user_24h w ON w.series_id = v.series_id
  GROUP BY 1,2,3,4,5,6,7,8,9,10
),

-- Step 8: Compute percentiles for thresholding
series_with_p90 AS (
  SELECT
    *,
    PERCENTILE_CONT(views_24h, 0.90) OVER (PARTITION BY publish_date, language) AS p90_views_24h,
    PERCENTILE_CONT(views_24h, 0.50) OVER (PARTITION BY publish_date, language) AS p50_views_24h,
    PERCENTILE_CONT(views_24h, 0.25) OVER (PARTITION BY publish_date, language) AS p25_views_24h,
    PERCENTILE_CONT(views_24h, 0.75) OVER (PARTITION BY publish_date, language) AS p75_views_24h
  FROM series_metrics
),

-- Step 9: Apply HDC thresholds
-- Language-specific view caps:
--   te → 500 | ta → 330 | kn → 200 | ml → 200 | hi → 1500 (global default)
-- L2 scale gate also differs by language: hi uses an absolute 1000-view floor,
-- regional languages use the day×language p75.
series_with_thresholds AS (
  SELECT
    *,
    LEAST(p90_views_24h, CASE language
        WHEN 'te' THEN 500
        WHEN 'ta' THEN 330
        WHEN 'kn' THEN 200
        WHEN 'ml' THEN 200
        ELSE 1500
      END
    ) AS threshold_value,
    ROUND(10 + (141.12 / ((duration_s / 60.0) + 1.8)), 1) AS target_completion_rate,
    ROUND(100 * SAFE_DIVIDE(completes_24h, views_24h), 1) AS achieved_completion_rate,
    CASE WHEN views_24h >= LEAST(p90_views_24h, CASE language
        WHEN 'te' THEN 500
        WHEN 'ta' THEN 330
        WHEN 'kn' THEN 200
        WHEN 'ml' THEN 200
        ELSE 1500
      END
    ) THEN 1 ELSE 0 END AS view_threshold,
    CASE WHEN 100 * SAFE_DIVIDE(completes_24h, views_24h) >= 10 + (141.12 / ((duration_s / 60.0) + 1.8)) THEN 1 ELSE 0 END AS cr_threshold,
    CASE WHEN views_24h >= LEAST(p90_views_24h, CASE language
        WHEN 'te' THEN 500
        WHEN 'ta' THEN 330
        WHEN 'kn' THEN 200
        WHEN 'ml' THEN 200
        ELSE 1500
      END
    )
          AND 100 * SAFE_DIVIDE(completes_24h, views_24h) >= 10 + (141.12 / ((duration_s / 60.0) + 1.8))
         THEN 1 ELSE 0 END AS HDC_threshold
  FROM series_with_p90
)

SELECT
  publish_date,
  language,
  bu_name,
  series_id,
  series_title,
  show_id,
  show_name,
  views_24h,
  watch_hours,
  ROUND(p90_views_24h, 2) AS p90_views_24h,
  ROUND(threshold_value, 2) AS threshold_value,
  target_completion_rate,
  achieved_completion_rate,
  view_threshold,
  cr_threshold,
  HDC_threshold,
  CASE
    WHEN HDC_threshold = 1 THEN 'L0'
    WHEN view_threshold = 1 AND cr_threshold = 0 THEN 'L1'
    -- L2 scale gate: Hindi uses an absolute 1000-view floor; regional languages
    -- use the day×language p75 (their absolute volumes are far lower).
    WHEN cr_threshold = 1 AND views_24h > IF(language = 'hi', 1000, p75_views_24h) THEN 'L2'
    WHEN views_24h > p50_views_24h THEN 'L3'
    WHEN views_24h >= p25_views_24h AND views_24h <= p50_views_24h THEN 'L4'
    WHEN views_24h < p25_views_24h THEN 'L5'
    ELSE 'L6'
  END AS Label
FROM series_with_thresholds
ORDER BY publish_date DESC, views_24h DESC
) t

UNION ALL
SELECT 'timespent' AS dataset, TO_JSON_STRING(t) AS row_json FROM (
-- Per-show watch hours, unique users, and avg minutes per video play
-- Window: D-8 to D-2 IST (rolling 7d, excluding today and yesterday)
-- Source: content_recommendation.video_play_combined
-- Scope: Seekho main (Android + iOS) + Nerchuko (te) + Arivu (ta) + Kalike (kn) + Vidhya (ml)
WITH plays AS (
  SELECT
    SAFE_CAST(p.series_id AS INT64) AS series_id,
    p.firebase_uid,
    p.watchtime
  FROM `seekho-c084b.content_recommendation.video_play_combined` p
  WHERE DATE(p.timestamp, 'Asia/Kolkata')
        BETWEEN DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 8 DAY)
            AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 2 DAY)
    AND p.watchtime IS NOT NULL
    AND p.watchtime > 0
    -- Limit to the 6 in-scope apps; excludes Bolo, Seekho Jr, SeekhoAI
    AND p.package_name IN (
      'com.seekho.android', 'com.seekho.ios',
      'com.nerchuko.android', 'com.arivu.android',
      'com.kalike.android', 'com.vidhya.android'
    )
),
enriched AS (
  SELECT
    cs.show_id,
    csh.title  AS show_title,
    cs.language,
    cat.title  AS category_title,
    p.firebase_uid,
    p.watchtime
  FROM plays p
  -- video_play_combined.series_id is STRING; courses_series.id is INT64
  JOIN `seekho-c084b.seekho.courses_series` cs
    ON p.series_id = cs.id
  JOIN `seekho-c084b.seekho.courses_show` csh
    ON cs.show_id = csh.id
  LEFT JOIN `seekho-c084b.seekho.courses_category` cat
    ON csh.category_id = cat.id
  WHERE cs.language IN ('hi','ta','te','ml','kn')
    AND cs.state IN ('live','expired')
)
SELECT
  show_id,
  show_title,
  language,
  category_title,
  COUNT(DISTINCT firebase_uid)    AS unique_users,
  COUNT(*)                        AS video_plays,
  ROUND(SUM(watchtime) / 3600, 2) AS watch_hours,
  ROUND(AVG(watchtime) / 60, 2)   AS avg_min_per_play
FROM enriched
GROUP BY 1, 2, 3, 4
HAVING video_plays >= 20
ORDER BY avg_min_per_play DESC
) t

ORDER BY dataset

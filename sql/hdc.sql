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
DECLARE start_date DATE DEFAULT DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL 10 DAY);
DECLARE end_date DATE DEFAULT CURRENT_DATE("Asia/Kolkata");

WITH

-- Step 1: Dates already settled in video_play (overlap guard for intraday)
settled_dates AS (
  SELECT DISTINCT DATE(`timestamp`, 'Asia/Kolkata') AS settled_date
  FROM `seekho-c084b.content_recommendation.video_play`
  WHERE DATE(`timestamp`, 'Asia/Kolkata') BETWEEN start_date AND end_date
),

-- Step 2: Unified watch events — settled + intraday (no double-counting)
watch_raw AS (
  SELECT
    `timestamp`                       AS event_ts,
    firebase_uid                      AS user_id,
    CAST(series_id AS INT64)          AS series_id,
    CAST(watchtime AS FLOAT64)        AS seconds
  FROM `seekho-c084b.content_recommendation.video_play`
  WHERE DATE(`timestamp`, 'Asia/Kolkata') BETWEEN start_date AND end_date
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
  WHERE DATE(`timestamp`, 'Asia/Kolkata') BETWEEN start_date AND end_date
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
  WHERE DATE(cs.approved_on, "Asia/Kolkata") BETWEEN start_date AND end_date
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
ORDER BY publish_date DESC, views_24h DESC;

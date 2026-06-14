-- ============================================================================
-- SEEKHO — CONTENT MORNING RCA  (Hindi-anchored, all-levels, single query)
-- ----------------------------------------------------------------------------
-- One Redash-ready BigQuery query that, every morning, tells you WHAT moved
-- and WHY across three health blocks, at three rollup levels, plus how the
-- blocks move TOGETHER (correlation + co-movement pattern).
--   Block A — PAID DAU viewing health  | Block B — CONTENT SUCCESS-RATE
--   Block C — HDC dual-gate health      | Block D — CORRELATION + CO-MOVEMENT
--   Levels: TOTAL (overall_httmk) / LANGUAGE (hi,ta,te,ml,kn) / BU (Hindi only)
-- Run this standalone (daily) and upload the CSV to the Daily RCA tab.
-- ============================================================================

DECLARE end_date           DATE   DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE scan_lookback_days INT64  DEFAULT 45;
DECLARE report_window_days INT64  DEFAULT 14;
DECLARE sr_freeze_days     INT64  DEFAULT 3;     -- 72h tracking, then frozen (SR & HDC)
DECLARE start_date         DATE   DEFAULT DATE_SUB(end_date, INTERVAL scan_lookback_days DAY);

WITH
bu_mapping AS (
  SELECT category_id, 'Awareness' AS bu_name FROM UNNEST([71,80,64,67,94,68,6,79,66,2,89,5,52,69,38,17,82,62,92,18,13,54,58,61,55,59,8,57,35,25,29,40,14,43,60,21,27,19,51,53,32,33,91,109,65,97,9,106,78,111,83,75,34,105,76,95,10,108,114,115,116,117,121]) AS category_id
  UNION ALL
  SELECT category_id, 'Income'    FROM UNNEST([73,63,16,70,56,11,50,85,72,84,39,37,30,45,81,98,96]) AS category_id
  UNION ALL
  SELECT category_id, 'Skill'     FROM UNNEST([88,77,4,86,90,49,74,107,48,46,103,1,12,42,7,3,22,23,15,47,28,44,36,31,100,101,20,93,102,41,99,24,110,104,87,112,113,118,119,120]) AS category_id
),

-- ===========================================================================
-- BLOCK A — PAID DAU VIEWING HEALTH
-- ===========================================================================
trials AS (
  SELECT eo.profile_id AS user_id, DATE(MIN(pph.purchased_on),'Asia/Kolkata') AS payment_date
  FROM seekho.experiments_order eo
  LEFT JOIN seekho.experiments_profilepurchasehistory pph ON eo.id = pph.order_id
  WHERE LOWER(eo.status)='order_paid' AND eo.premium_item_id IS NULL AND eo.is_prod=TRUE
  GROUP BY 1
),
series_dim AS (
  SELECT CAST(cs.id AS STRING) AS series_id_str, cs.language, COALESCE(bu.bu_name,'Other') AS bu_name
  FROM seekho.courses_series cs LEFT JOIN bu_mapping bu ON cs.category_id=bu.category_id
),
vp_base AS (
  SELECT
    DATE(vp.timestamp,'Asia/Kolkata') AS date_,
    EXTRACT(HOUR FROM DATETIME(vp.timestamp,'Asia/Kolkata')) AS hour_ist,
    vp.user_id, sd.language, sd.bu_name, vp.watchtime_max,
    COALESCE(vp.source_screen,'unknown') AS source_screen,
    COALESCE(vp.source_section,'unknown') AS source_section,
    CASE
      WHEN vp.source_screen='from_notification' THEN 'push'
      WHEN vp.source_screen='from_moe_notification' THEN 'moe'
      WHEN LOWER(COALESCE(vp.source_screen,'')) LIKE '%whatsapp%' THEN 'whatsapp'
      WHEN LOWER(COALESCE(vp.source_section,'')) LIKE '%whatsapp%' THEN 'whatsapp'
      ELSE 'organic'
    END AS source_type,
    DATE_DIFF(DATE(vp.timestamp,'Asia/Kolkata'), t.payment_date, DAY) AS days_since_payment
  FROM content_recommendation.video_play_combined vp
  JOIN trials t ON t.user_id=vp.user_id AND DATE(vp.timestamp,'Asia/Kolkata')>=t.payment_date
  JOIN series_dim sd ON sd.series_id_str=vp.series_id
  WHERE DATE(vp.timestamp,'Asia/Kolkata') BETWEEN start_date AND end_date
    AND sd.language IN ('hi','ta','te','ml','kn')
),
seg_play AS (
  SELECT 'LANGUAGE' AS level, language AS segment, date_, hour_ist, user_id, watchtime_max, source_type, source_screen, source_section, days_since_payment FROM vp_base
  UNION ALL SELECT 'TOTAL','overall_httmk', date_, hour_ist, user_id, watchtime_max, source_type, source_screen, source_section, days_since_payment FROM vp_base
  UNION ALL SELECT 'BU', bu_name, date_, hour_ist, user_id, watchtime_max, source_type, source_screen, source_section, days_since_payment FROM vp_base WHERE language='hi' AND bu_name<>'Other'
),
user_day_seg AS (
  SELECT level, segment, date_, user_id,
    SUM(watchtime_max) AS total_watchtime, MAX(watchtime_max) AS max_watchtime,
    ARRAY_AGG(source_type ORDER BY watchtime_max DESC LIMIT 1)[OFFSET(0)] AS source_type,
    MIN(days_since_payment) AS days_since_payment
  FROM seg_play GROUP BY 1,2,3,4
),
classified AS (
  SELECT *,
    CASE WHEN days_since_payment=0 THEN 'D0' WHEN days_since_payment BETWEEN 1 AND 3 THEN 'D1_D3'
         WHEN days_since_payment BETWEEN 4 AND 7 THEN 'D4_D7' WHEN days_since_payment BETWEEN 8 AND 14 THEN 'D8_D14'
         WHEN days_since_payment BETWEEN 15 AND 30 THEN 'D15_D30' ELSE 'D30_plus' END AS payment_age_bucket,
    CASE WHEN LAG(date_) OVER w IS NULL THEN 'new'
         WHEN DATE_DIFF(date_, LAG(date_) OVER w, DAY)=1 THEN 'retained'
         WHEN DATE_DIFF(date_, LAG(date_) OVER w, DAY) BETWEEN 2 AND 7 THEN 'resurrected_2_7'
         ELSE 'resurrected_8_plus' END AS user_type,
    CASE WHEN max_watchtime>=5 THEN 1 ELSE 0 END AS is_dau
  FROM user_day_seg WINDOW w AS (PARTITION BY level, segment, user_id ORDER BY date_)
),
dau_daily AS (
  SELECT level, segment, date_,
    COUNT(DISTINCT IF(is_dau=1,user_id,NULL)) AS dau,
    COUNT(DISTINCT IF(source_type='organic' AND is_dau=1,user_id,NULL)) AS dau_organic,
    COUNT(DISTINCT IF(source_type='push' AND is_dau=1,user_id,NULL)) AS dau_push,
    COUNT(DISTINCT IF(source_type='moe' AND is_dau=1,user_id,NULL)) AS dau_moe,
    COUNT(DISTINCT IF(source_type='whatsapp' AND is_dau=1,user_id,NULL)) AS dau_whatsapp,
    COUNT(DISTINCT IF(user_type='new' AND is_dau=1,user_id,NULL)) AS dau_new,
    COUNT(DISTINCT IF(user_type='retained' AND is_dau=1,user_id,NULL)) AS dau_retained,
    COUNT(DISTINCT IF(user_type LIKE 'resurrected%' AND is_dau=1,user_id,NULL)) AS dau_resurrected,
    COUNT(DISTINCT IF(payment_age_bucket='D0' AND is_dau=1,user_id,NULL)) AS dau_d0,
    COUNT(DISTINCT IF(payment_age_bucket='D1_D3' AND is_dau=1,user_id,NULL)) AS dau_d1_d3,
    COUNT(DISTINCT IF(payment_age_bucket='D4_D7' AND is_dau=1,user_id,NULL)) AS dau_d4_d7,
    COUNT(DISTINCT IF(payment_age_bucket='D8_D14' AND is_dau=1,user_id,NULL)) AS dau_d8_d14,
    COUNT(DISTINCT IF(payment_age_bucket='D15_D30' AND is_dau=1,user_id,NULL)) AS dau_d15_d30,
    COUNT(DISTINCT IF(payment_age_bucket='D30_plus' AND is_dau=1,user_id,NULL)) AS dau_d30_plus,
    ROUND(SAFE_DIVIDE(SUM(IF(is_dau=1,total_watchtime,0)), COUNT(DISTINCT IF(is_dau=1,user_id,NULL)))/60,2) AS mins_per_dau
  FROM classified GROUP BY 1,2,3
),
dau_base AS (
  SELECT d.*, dod.dau AS dau_dod, sdlw.dau AS dau_sdlw,
    ROUND(AVG(d.dau) OVER (PARTITION BY d.level,d.segment ORDER BY d.date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),0) AS dau_7davg,
    dod.dau_organic AS dau_organic_dod, dod.dau_push AS dau_push_dod, dod.dau_moe AS dau_moe_dod, dod.dau_whatsapp AS dau_whatsapp_dod,
    dod.dau_new AS dau_new_dod, dod.dau_retained AS dau_retained_dod, dod.dau_resurrected AS dau_resurrected_dod,
    dod.dau_d0 AS dau_d0_dod, dod.dau_d1_d3 AS dau_d1_d3_dod, dod.dau_d4_d7 AS dau_d4_d7_dod, dod.dau_d8_d14 AS dau_d8_d14_dod,
    dod.dau_d15_d30 AS dau_d15_d30_dod, dod.dau_d30_plus AS dau_d30_plus_dod, dod.mins_per_dau AS mins_per_dau_dod
  FROM dau_daily d
  LEFT JOIN dau_daily dod ON dod.level=d.level AND dod.segment=d.segment AND dod.date_=DATE_SUB(d.date_,INTERVAL 1 DAY)
  LEFT JOIN dau_daily sdlw ON sdlw.level=d.level AND sdlw.segment=d.segment AND sdlw.date_=DATE_SUB(d.date_,INTERVAL 7 DAY)
),
surface_daily AS (
  SELECT level, segment, date_, source_screen, source_section, COUNT(DISTINCT IF(watchtime_max>=5,user_id,NULL)) AS dau_surface
  FROM seg_play GROUP BY 1,2,3,4,5
),
surface_chg AS (
  SELECT s.*, s.dau_surface - prev.dau_surface AS surface_change
  FROM surface_daily s LEFT JOIN surface_daily prev
    ON prev.level=s.level AND prev.segment=s.segment AND prev.source_screen=s.source_screen AND prev.source_section=s.source_section AND prev.date_=DATE_SUB(s.date_,INTERVAL 1 DAY)
),
surface_drops AS (
  SELECT level, segment, date_, STRING_AGG(CONCAT(source_screen,'>',source_section,' (',CAST(surface_change AS STRING),')'),' | ' ORDER BY surface_change ASC LIMIT 3) AS top_surface_drops
  FROM surface_chg WHERE surface_change<0 GROUP BY 1,2,3
),
hour_daily AS (
  SELECT level, segment, date_, hour_ist, COUNT(DISTINCT IF(watchtime_max>=5,user_id,NULL)) AS hr_users FROM seg_play GROUP BY 1,2,3,4
),
hour_base AS (
  SELECT *, ROUND(AVG(hr_users) OVER (PARTITION BY level,segment,hour_ist ORDER BY date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),0) AS hr_users_7davg FROM hour_daily
),
hour_drop AS (
  SELECT level, segment, date_,
    ARRAY_AGG(CONCAT(LPAD(CAST(hour_ist AS STRING),2,'0'),':00 (',CAST(hr_users-hr_users_7davg AS STRING),' vs 7dAvg)') ORDER BY (hr_users-hr_users_7davg) ASC LIMIT 1)[OFFSET(0)] AS peak_drop_hour
  FROM hour_base WHERE hr_users_7davg IS NOT NULL AND hr_users<hr_users_7davg GROUP BY 1,2,3
),
dau_final AS (
  SELECT b.*,
    b.dau-b.dau_dod AS dau_dod_chg, b.dau-b.dau_sdlw AS dau_sdlw_chg, b.dau-b.dau_7davg AS dau_7davg_chg,
    ROUND(SAFE_DIVIDE(b.dau-b.dau_dod,b.dau_dod)*100,1) AS dau_dod_pct,
    ROUND(SAFE_DIVIDE(b.dau-b.dau_sdlw,b.dau_sdlw)*100,1) AS dau_sdlw_pct,
    ROUND(SAFE_DIVIDE(b.dau-b.dau_7davg,b.dau_7davg)*100,1) AS dau_7davg_pct,
    sd.top_surface_drops, hd.peak_drop_hour,
    ARRAY_TO_STRING(ARRAY(SELECT r FROM UNNEST([STRUCT('organic ' AS r, GREATEST(b.dau_organic_dod-b.dau_organic,0) AS imp),STRUCT('push ' AS r, GREATEST(b.dau_push_dod-b.dau_push,0) AS imp),STRUCT('moe ' AS r, GREATEST(b.dau_moe_dod-b.dau_moe,0) AS imp),STRUCT('whatsapp ' AS r, GREATEST(b.dau_whatsapp_dod-b.dau_whatsapp,0) AS imp)]) WHERE imp>0 ORDER BY imp DESC LIMIT 2),'+ ') AS src_drop_driver,
    ARRAY_TO_STRING(ARRAY(SELECT r FROM UNNEST([STRUCT('new ' AS r, GREATEST(b.dau_new_dod-b.dau_new,0) AS imp),STRUCT('retained ' AS r, GREATEST(b.dau_retained_dod-b.dau_retained,0) AS imp),STRUCT('resurrected ' AS r, GREATEST(b.dau_resurrected_dod-b.dau_resurrected,0) AS imp)]) WHERE imp>0 ORDER BY imp DESC LIMIT 2),'+ ') AS usertype_drop_driver,
    ARRAY_TO_STRING(ARRAY(SELECT r FROM UNNEST([STRUCT('D0 ' AS r, GREATEST(b.dau_d0_dod-b.dau_d0,0) AS imp),STRUCT('D1-D3 ' AS r, GREATEST(b.dau_d1_d3_dod-b.dau_d1_d3,0) AS imp),STRUCT('D4-D7 ' AS r, GREATEST(b.dau_d4_d7_dod-b.dau_d4_d7,0) AS imp),STRUCT('D8-D14 ' AS r, GREATEST(b.dau_d8_d14_dod-b.dau_d8_d14,0) AS imp),STRUCT('D15-D30 ' AS r, GREATEST(b.dau_d15_d30_dod-b.dau_d15_d30,0) AS imp),STRUCT('D30+ ' AS r, GREATEST(b.dau_d30_plus_dod-b.dau_d30_plus,0) AS imp)]) WHERE imp>0 ORDER BY imp DESC LIMIT 2),'+ ') AS cohort_drop_driver
  FROM dau_base b
  LEFT JOIN surface_drops sd ON sd.level=b.level AND sd.segment=b.segment AND sd.date_=b.date_
  LEFT JOIN hour_drop hd ON hd.level=b.level AND hd.segment=b.segment AND hd.date_=b.date_
),

-- ===========================================================================
-- BLOCK B — CONTENT SUCCESS-RATE (frozen content_performance)
-- ===========================================================================
cp_base AS (
  SELECT cp.publish_date AS date_, cp.language, COALESCE(bu.bu_name,'Other') AS bu_name, cp.series_id, cp.status, cp.completion_rate, cp.targ_comp, cp.watch_hrs, cp.starts, cp.completes
  FROM analytics_content.content_performance cp
  JOIN seekho.courses_series cs ON cs.id=cp.series_id
  JOIN seekho.courses_show csh ON csh.id=cs.show_id AND csh.show_type='active' AND csh.state='live'
  LEFT JOIN bu_mapping bu ON cp.category_id=bu.category_id
  WHERE cp.publish_date BETWEEN start_date AND end_date AND cs.state IN ('live','expired') AND cp.language IN ('hi','ta','te','ml','kn')
),
seg_cp AS (
  SELECT 'LANGUAGE' AS level, language AS segment, cp_base.* EXCEPT(language,bu_name) FROM cp_base
  UNION ALL SELECT 'TOTAL','overall_httmk', cp_base.* EXCEPT(language,bu_name) FROM cp_base
  UNION ALL SELECT 'BU', bu_name, cp_base.* EXCEPT(language,bu_name) FROM cp_base WHERE language='hi' AND bu_name<>'Other'
),
content_daily AS (
  SELECT level, segment, date_,
    COUNT(DISTINCT series_id) AS series_launched,
    COUNT(DISTINCT IF(status=1,series_id,NULL)) AS series_success,
    COUNT(DISTINCT IF(status=0,series_id,NULL)) AS series_fail,
    COUNT(DISTINCT IF(status IS NULL,series_id,NULL)) AS series_tracking,
    ROUND(100*SAFE_DIVIDE(COUNT(DISTINCT IF(status=1,series_id,NULL)),COUNT(DISTINCT IF(status IN (0,1),series_id,NULL))),1) AS sr_pct,
    ROUND(AVG(completion_rate),1) AS avg_cr, ROUND(AVG(targ_comp),1) AS avg_targ_cr,
    ROUND(SUM(watch_hrs),1) AS content_watch_hrs, SUM(starts) AS content_starts, SUM(completes) AS content_completes
  FROM seg_cp GROUP BY 1,2,3
),
-- SUCCESS RATE is a POOLED cohort, not a single launch day: for each report_date it
-- pools every series published in [report_date-10, report_date-4] — 7 fully-settled
-- days (each ≥4 days old, past the 72h freeze). Matches the canonical SR query
-- (status=1 success / status=0 fail / NULL tracking excluded). Baseline = the prior
-- 7-day cohort [report_date-17, report_date-11].
sr_spine AS (
  SELECT DISTINCT level, segment, date_ AS report_date FROM dau_daily
),
sr_cur AS (
  SELECT sp.level, sp.segment, sp.report_date,
    SUM(cc.series_launched)  AS series_launched,
    SUM(cc.series_success)   AS series_success,
    SUM(cc.series_fail)      AS series_fail,
    SUM(cc.series_tracking)  AS series_tracking,
    ROUND(AVG(cc.avg_cr),1)       AS avg_cr,
    ROUND(AVG(cc.avg_targ_cr),1)  AS avg_targ_cr,
    ROUND(SUM(cc.content_watch_hrs),1) AS content_watch_hrs
  FROM sr_spine sp
  LEFT JOIN content_daily cc ON cc.level=sp.level AND cc.segment=sp.segment
    AND cc.date_ BETWEEN DATE_SUB(sp.report_date, INTERVAL 10 DAY) AND DATE_SUB(sp.report_date, INTERVAL 4 DAY)
  GROUP BY 1,2,3
),
sr_prev AS (
  SELECT sp.level, sp.segment, sp.report_date,
    SUM(cc.series_success) AS series_success, SUM(cc.series_fail) AS series_fail
  FROM sr_spine sp
  LEFT JOIN content_daily cc ON cc.level=sp.level AND cc.segment=sp.segment
    AND cc.date_ BETWEEN DATE_SUB(sp.report_date, INTERVAL 17 DAY) AND DATE_SUB(sp.report_date, INTERVAL 11 DAY)
  GROUP BY 1,2,3
),
content_final AS (
  SELECT cur.level, cur.segment, cur.report_date AS date_,
    cur.series_launched, cur.series_success, cur.series_fail, cur.series_tracking,
    ROUND(100*SAFE_DIVIDE(cur.series_success, NULLIF(cur.series_success+cur.series_fail,0)),1) AS sr_pct,
    CAST(NULL AS FLOAT64) AS sr_dod,
    ROUND(100*SAFE_DIVIDE(prv.series_success, NULLIF(prv.series_success+prv.series_fail,0)),1) AS sr_sdlw,
    ROUND(100*SAFE_DIVIDE(prv.series_success, NULLIF(prv.series_success+prv.series_fail,0)),1) AS sr_7davg,
    TRUE AS sr_is_frozen,   -- cohort window (D-10..D-4) is always past the 72h freeze
    cur.avg_cr, cur.avg_targ_cr,
    cur.content_watch_hrs, CAST(NULL AS FLOAT64) AS cwh_dod, CAST(NULL AS FLOAT64) AS cwh_sdlw
  FROM sr_cur cur
  LEFT JOIN sr_prev prv ON prv.level=cur.level AND prv.segment=cur.segment AND prv.report_date=cur.report_date
),

-- ===========================================================================
-- BLOCK C — HDC DUAL-GATE (all-user 24h view gate  +  frozen CR gate)
-- ===========================================================================
hdc_series AS (
  SELECT cs.id AS series_id, cs.language, COALESCE(bu.bu_name,'Other') AS bu_name,
         cs.duration_s,
         TIMESTAMP(cs.approved_on) AS approved_ts, DATE(cs.approved_on,'Asia/Kolkata') AS date_
  FROM seekho.courses_series cs
  JOIN seekho.courses_show csh ON csh.id=cs.show_id AND csh.show_type='active' AND csh.state='live'
  LEFT JOIN bu_mapping bu ON cs.category_id=bu.category_id
  WHERE DATE(cs.approved_on,'Asia/Kolkata') BETWEEN start_date AND end_date
    AND cs.language IN ('hi','ta','te','ml','kn') AND cs.state IN ('live','expired')
    AND cs.duration_s>0 AND cs.approved_on IS NOT NULL
),
hdc_plays AS (
  SELECT CAST(series_id AS INT64) AS series_id, firebase_uid AS uid, `timestamp` AS ts,
         CAST(watchtime AS FLOAT64) AS seconds
  FROM content_recommendation.video_play
  WHERE DATE(`timestamp`,'Asia/Kolkata') BETWEEN start_date AND DATE_ADD(end_date, INTERVAL 1 DAY)
    AND package_name NOT IN ('com.bolo.android','com.seekho.ios','com.seekhoai.android','com.seekhoglobal.ios','com.seekhoglobal.android')
    AND (source_screen NOT IN ('from_notification','sharing','from_moe_notification') OR source_screen IS NULL)
),
-- per series × user: total watch seconds inside the first-24h window
hdc_user_watch AS (
  SELECT s.series_id, s.language, s.bu_name, s.date_, s.duration_s,
         p.uid, SUM(COALESCE(p.seconds,0)) AS watch_seconds
  FROM hdc_series s
  JOIN hdc_plays p ON p.series_id=s.series_id
       AND p.ts >= s.approved_ts AND p.ts < TIMESTAMP_ADD(s.approved_ts, INTERVAL 24 HOUR)
  GROUP BY 1,2,3,4,5,6
),
-- per series: 24h distinct viewers + 24h completers (>=70% of duration), same-day.
hdc_views AS (
  SELECT s.series_id, s.language, s.bu_name, s.date_, s.duration_s,
         COUNT(DISTINCT w.uid) AS raw_views_24h,
         COUNT(DISTINCT IF(SAFE_DIVIDE(w.watch_seconds, s.duration_s) >= 0.7, w.uid, NULL)) AS completes_24h
  FROM hdc_series s
  LEFT JOIN hdc_user_watch w ON w.series_id=s.series_id
  GROUP BY 1,2,3,4,5
),
hdc_flags AS (
  SELECT v.series_id, v.language, v.bu_name, v.date_, v.duration_s, v.completes_24h,
    CASE WHEN v.raw_views_24h>=1000 THEN CAST(ROUND(v.raw_views_24h,-2) AS INT64) ELSE v.raw_views_24h END AS views_24h,
    -- CR gate computed SAME-DAY from the 24h window (matches the HDC report), not the
    -- 72h-frozen content_performance.status: actual CR vs duration-based target CR.
    ROUND(10 + (141.12/((v.duration_s/60.0)+1.8)), 1) AS target_cr,
    ROUND(100 * SAFE_DIVIDE(v.completes_24h,
      CASE WHEN v.raw_views_24h>=1000 THEN ROUND(v.raw_views_24h,-2) ELSE v.raw_views_24h END), 1) AS actual_cr
  FROM hdc_views v
),
hdc_p90 AS (
  SELECT date_, language, APPROX_QUANTILES(views_24h,100)[OFFSET(90)] AS p90_views
  FROM hdc_flags GROUP BY 1,2
),
hdc_labeled AS (
  SELECT f.*, LEAST(p.p90_views,1500) AS view_threshold,
    CASE WHEN f.views_24h >= LEAST(p.p90_views,1500) THEN 1 ELSE 0 END AS view_pass,
    CASE WHEN f.actual_cr >= f.target_cr THEN 1 ELSE 0 END AS cr_pass_flag,
    CASE WHEN f.views_24h >= LEAST(p.p90_views,1500) AND f.actual_cr >= f.target_cr THEN 1 ELSE 0 END AS hdc_flag
  FROM hdc_flags f LEFT JOIN hdc_p90 p ON p.date_=f.date_ AND p.language=f.language
),
seg_hdc AS (
  SELECT 'LANGUAGE' AS level, language AS segment, date_, view_pass, cr_pass_flag, hdc_flag, actual_cr, target_cr FROM hdc_labeled
  UNION ALL SELECT 'TOTAL','overall_httmk', date_, view_pass, cr_pass_flag, hdc_flag, actual_cr, target_cr FROM hdc_labeled
  UNION ALL SELECT 'BU', bu_name, date_, view_pass, cr_pass_flag, hdc_flag, actual_cr, target_cr FROM hdc_labeled WHERE language='hi' AND bu_name<>'Other'
),
hdc_daily AS (
  SELECT level, segment, date_,
    COUNT(*) AS hdc_eligible,
    SUM(hdc_flag) AS hdc_count,
    SUM(view_pass) AS view_pass_cnt,
    SUM(cr_pass_flag) AS cr_pass_cnt,
    SUM(CASE WHEN view_pass=0 AND cr_pass_flag=1 THEN 1 ELSE 0 END) AS miss_view_only,
    SUM(CASE WHEN view_pass=1 AND cr_pass_flag=0 THEN 1 ELSE 0 END) AS miss_cr_only,
    SUM(CASE WHEN view_pass=0 AND cr_pass_flag=0 THEN 1 ELSE 0 END) AS miss_both,
    ROUND(100*SAFE_DIVIDE(SUM(hdc_flag),COUNT(*)),1) AS hdc_rate
  FROM seg_hdc GROUP BY 1,2,3
),
-- Live 24h completion rate per segment per day (avg of per-series actual CR vs target).
-- This is the ONLY source with a value for un-frozen recent days (content_performance.
-- completion_rate is NULL until the 72h freeze), so D-2 etc. always have a number here.
hdc_cr_daily AS (
  SELECT level, segment, date_,
    ROUND(AVG(actual_cr),1) AS day_cr,
    ROUND(AVG(target_cr),1) AS day_targ
  FROM seg_hdc GROUP BY 1,2,3
),
hdc_final AS (
  SELECT h.*,
    -- HDC is fully determined once the 24h window has closed and its plays settled.
    -- That is ~D-2 (end_date is D-1), so HDC settles one day after end_date's data lands.
    (h.date_<=DATE_SUB(end_date,INTERVAL 1 DAY)) AS hdc_is_settled,
    dod.hdc_count AS hdc_dod, sdlw.hdc_count AS hdc_sdlw,
    ROUND(AVG(h.hdc_count) OVER (PARTITION BY h.level,h.segment ORDER BY h.date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),1) AS hdc_7davg,
    ROUND(AVG(h.hdc_rate)  OVER (PARTITION BY h.level,h.segment ORDER BY h.date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),1) AS hdc_rate_7davg,
    dod.hdc_eligible AS supply_dod,
    ROUND(AVG(h.hdc_eligible) OVER (PARTITION BY h.level,h.segment ORDER BY h.date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),1) AS supply_7davg
  FROM hdc_daily h
  LEFT JOIN hdc_daily dod  ON dod.level=h.level  AND dod.segment=h.segment  AND dod.date_  = DATE_SUB(h.date_,INTERVAL 1 DAY)
  LEFT JOIN hdc_daily sdlw ON sdlw.level=h.level AND sdlw.segment=h.segment AND sdlw.date_ = DATE_SUB(h.date_,INTERVAL 7 DAY)
),

-- ===========================================================================
-- BLOCK D — CORRELATION (segment-level, over settled frozen days)
-- ===========================================================================
corr_src AS (
  SELECT a.level, a.segment, a.date_, a.dau,
         c.sr_pct, CAST(h.hdc_count AS FLOAT64) AS hdc_count
  FROM dau_daily a
  LEFT JOIN content_daily c ON c.level=a.level AND c.segment=a.segment AND c.date_=a.date_
  LEFT JOIN hdc_daily   h ON h.level=a.level AND h.segment=a.segment AND h.date_=a.date_
  WHERE a.date_ <= DATE_SUB(end_date, INTERVAL sr_freeze_days DAY)
),
corr_block AS (
  SELECT level, segment,
    CASE WHEN COUNTIF(hdc_count IS NOT NULL AND dau IS NOT NULL)    >= 5 THEN ROUND(CORR(hdc_count, dau),2)    END AS corr_hdc_dau,
    CASE WHEN COUNTIF(sr_pct   IS NOT NULL AND dau IS NOT NULL)     >= 5 THEN ROUND(CORR(sr_pct,   dau),2)     END AS corr_sr_dau,
    CASE WHEN COUNTIF(hdc_count IS NOT NULL AND sr_pct IS NOT NULL) >= 5 THEN ROUND(CORR(hdc_count, sr_pct),2) END AS corr_hdc_sr
  FROM corr_src GROUP BY 1,2
),

-- ===========================================================================
-- UNIFY + AUTO-RCA (English narrative) + CO-MOVEMENT PATTERN
-- ===========================================================================
unified AS (
  SELECT
    COALESCE(a.date_, c.date_, h.date_) AS report_date,
    COALESCE(a.level, c.level, h.level) AS level,
    COALESCE(a.segment, c.segment, h.segment) AS segment,

    a.dau, a.dau_dod, a.dau_sdlw, a.dau_7davg, a.dau_dod_pct, a.dau_sdlw_pct, a.dau_7davg_pct,
    a.mins_per_dau, a.mins_per_dau_dod,
    a.dau_organic, a.dau_push, a.dau_moe, a.dau_whatsapp,
    a.dau_new, a.dau_retained, a.dau_resurrected,
    a.dau_d0, a.dau_d1_d3, a.dau_d4_d7, a.dau_d8_d14, a.dau_d15_d30, a.dau_d30_plus,
    a.src_drop_driver, a.usertype_drop_driver, a.cohort_drop_driver, a.top_surface_drops, a.peak_drop_hour,

    c.series_launched, c.series_success, c.series_fail, c.series_tracking,
    c.sr_pct, c.sr_dod, c.sr_sdlw, c.sr_7davg, c.sr_is_frozen, c.avg_cr, c.avg_targ_cr,
    cr4.day_cr AS cr_d4, cr4.day_targ AS cr_d4_targ,   -- live 24h completion, D-4 (settled)
    cr2.day_cr AS cr_d2, cr2.day_targ AS cr_d2_targ,   -- live 24h completion, D-2 (HDC day, not frozen)
    c.content_watch_hrs, c.cwh_dod, c.cwh_sdlw,

    h.hdc_eligible AS hdc_supply, h.supply_dod, h.supply_7davg,
    h.hdc_count, h.hdc_dod, h.hdc_sdlw, h.hdc_7davg, h.hdc_is_settled,
    h.hdc_rate, h.hdc_rate_7davg,
    h.view_pass_cnt, h.cr_pass_cnt, h.miss_view_only, h.miss_cr_only, h.miss_both,

    cb.corr_hdc_dau, cb.corr_sr_dau, cb.corr_hdc_sr,

    CASE
      WHEN a.dau IS NULL THEN 'no_paid_dau_row'
      WHEN a.dau_dod IS NULL OR a.dau_sdlw IS NULL OR a.dau_7davg IS NULL THEN 'baseline_incomplete'
      WHEN a.dau<a.dau_dod*0.97 AND a.dau<a.dau_sdlw*0.97 AND a.dau<a.dau_7davg*0.97 THEN 'REAL_DROP'
      WHEN a.dau>a.dau_dod*1.03 AND a.dau>a.dau_sdlw*1.03 AND a.dau>a.dau_7davg*1.03 THEN 'REAL_RISE'
      WHEN a.dau<a.dau_7davg*0.97 THEN 'soft_drop' WHEN a.dau>a.dau_7davg*1.03 THEN 'soft_rise' ELSE 'normal'
    END AS dau_verdict,

    CASE
      WHEN c.sr_pct IS NULL THEN 'no_content_launched'
      WHEN NOT c.sr_is_frozen THEN 'still_tracking_72h'
      WHEN c.sr_7davg IS NULL THEN 'baseline_incomplete'
      WHEN c.sr_pct < c.sr_7davg-10 THEN 'SR_DROP' WHEN c.sr_pct > c.sr_7davg+10 THEN 'SR_RISE' ELSE 'normal'
    END AS sr_verdict,

    CASE
      WHEN h.hdc_count IS NULL THEN 'no_content_launched'
      WHEN NOT h.hdc_is_settled THEN 'still_settling'
      WHEN h.hdc_7davg IS NULL THEN 'baseline_incomplete'
      WHEN h.hdc_count < h.hdc_7davg - GREATEST(1, 0.20*h.hdc_7davg) THEN 'HDC_DROP'
      WHEN h.hdc_count > h.hdc_7davg + GREATEST(1, 0.20*h.hdc_7davg) THEN 'HDC_RISE'
      ELSE 'normal'
    END AS hdc_verdict,

    CASE
      WHEN h.hdc_count IS NULL OR NOT h.hdc_is_settled OR h.hdc_7davg IS NULL THEN NULL
      WHEN h.hdc_count < h.hdc_7davg - GREATEST(1,0.20*h.hdc_7davg) AND h.hdc_eligible < h.supply_7davg*0.85
        THEN 'HDC down mainly SUPPLY (fewer launches)'
      WHEN h.hdc_count < h.hdc_7davg - GREATEST(1,0.20*h.hdc_7davg) AND h.hdc_rate < h.hdc_rate_7davg-5
        THEN 'HDC down mainly QUALITY (hit-rate fell)'
      WHEN h.hdc_count < h.hdc_7davg - GREATEST(1,0.20*h.hdc_7davg)
        THEN 'HDC down (supply+quality mixed)'
      ELSE NULL
    END AS hdc_attribution,

    CASE
      WHEN a.dau IS NULL AND h.hdc_count IS NULL THEN NULL
      WHEN a.dau_7davg IS NULL OR h.hdc_7davg IS NULL OR NOT h.hdc_is_settled THEN 'insufficient_baseline'
      WHEN h.hdc_count < h.hdc_7davg*0.8 AND c.sr_pct < c.sr_7davg-10 AND a.dau < a.dau_7davg*0.97
        THEN 'CONTENT-LED DECLINE: HDC+SR+DAU all down — fresh content weak AND it is pulling DAU down'
      WHEN h.hdc_count < h.hdc_7davg*0.8 AND a.dau >= a.dau_7davg*0.97
        THEN 'LEADING RISK: HDC down but DAU still holding on catalog — expect DAU softness if it persists'
      WHEN h.hdc_count > h.hdc_7davg*1.2 AND a.dau > a.dau_7davg*1.03
        THEN 'FRESH HITS LIFTING DAU: HDC up + DAU up'
      WHEN a.dau < a.dau_7davg*0.97 AND h.hdc_count >= h.hdc_7davg*0.8 AND c.sr_pct >= c.sr_7davg-10
        THEN 'NOT CONTENT: DAU down while content healthy — check distribution/notif/seasonality'
      WHEN h.hdc_count > h.hdc_7davg*1.2 AND a.dau < a.dau_7davg*0.97
        THEN 'DIVERGENCE: strong new content but DAU down — distribution not converting supply'
      ELSE 'aligned/normal'
    END AS comovement_pattern,

    CONCAT(
      CASE
        WHEN a.dau IS NULL THEN ''
        WHEN a.dau_dod IS NULL OR a.dau_sdlw IS NULL OR a.dau_7davg IS NULL THEN CONCAT('Paid DAU ',CAST(a.dau AS STRING),' (baselines incomplete). ')
        WHEN a.dau<a.dau_dod*0.97 AND a.dau<a.dau_sdlw*0.97 AND a.dau<a.dau_7davg*0.97
          THEN CONCAT('REAL paid-DAU drop: ',CAST(a.dau AS STRING),' (DoD ',CAST(a.dau_dod_pct AS STRING),'%, SDLW ',CAST(a.dau_sdlw_pct AS STRING),'%, vs7dAvg ',CAST(a.dau_7davg_pct AS STRING),'%). ',
               'source[',COALESCE(NULLIF(a.src_drop_driver,''),'n/a'),'] usertype[',COALESCE(NULLIF(a.usertype_drop_driver,''),'n/a'),'] cohort[',COALESCE(NULLIF(a.cohort_drop_driver,''),'n/a'),']. ',
               IFNULL(CONCAT('surface: ',a.top_surface_drops,'. '),''), IFNULL(CONCAT('worst hr: ',a.peak_drop_hour,'. '),''))
        WHEN a.dau>a.dau_dod*1.03 AND a.dau>a.dau_sdlw*1.03 AND a.dau>a.dau_7davg*1.03 THEN CONCAT('Paid-DAU rise: ',CAST(a.dau AS STRING),' (vs7dAvg ',CAST(a.dau_7davg_pct AS STRING),'%). ')
        WHEN a.dau<a.dau_7davg*0.97 THEN CONCAT('Soft paid-DAU dip vs 7dAvg (',CAST(a.dau_7davg_pct AS STRING),'%); DoD/SDLW not both down — likely weekday noise. ')
        ELSE CONCAT('Paid DAU normal (',CAST(a.dau AS STRING),'). ')
      END,
      CASE
        WHEN h.hdc_count IS NULL THEN ''
        WHEN NOT h.hdc_is_settled THEN CONCAT('HDC still settling (',CAST(h.hdc_eligible AS STRING),' launched). ')
        WHEN h.hdc_7davg IS NULL THEN CONCAT('HDC ',CAST(h.hdc_count AS STRING),'/',CAST(h.hdc_eligible AS STRING),' (baseline incomplete). ')
        WHEN h.hdc_count < h.hdc_7davg - GREATEST(1,0.20*h.hdc_7davg)
          THEN CONCAT('HDC DROP: ',CAST(h.hdc_count AS STRING),' vs 7dAvg ',CAST(h.hdc_7davg AS STRING),
               ' (rate ',CAST(h.hdc_rate AS STRING),'% vs ',CAST(h.hdc_rate_7davg AS STRING),'%; misses view-only/cr-only/both = ',
               CAST(h.miss_view_only AS STRING),'/',CAST(h.miss_cr_only AS STRING),'/',CAST(h.miss_both AS STRING),
               '). ',
               CASE WHEN h.miss_cr_only+h.miss_both >= h.miss_view_only THEN 'Mostly CONTENT misses -> show managers. ' ELSE 'Mostly VIEW misses -> recommendations/distribution. ' END)
        WHEN h.hdc_count > h.hdc_7davg + GREATEST(1,0.20*h.hdc_7davg) THEN CONCAT('HDC up: ',CAST(h.hdc_count AS STRING),' vs 7dAvg ',CAST(h.hdc_7davg AS STRING),'. ')
        ELSE CONCAT('HDC steady: ',CAST(h.hdc_count AS STRING),'/',CAST(h.hdc_eligible AS STRING),' (rate ',CAST(h.hdc_rate AS STRING),'%). ')
      END,
      CASE
        WHEN c.sr_pct IS NULL THEN 'No active-show series launched.'
        WHEN NOT c.sr_is_frozen THEN CONCAT('SR tracking (<72h): ',CAST(c.series_tracking AS STRING),' not yet frozen.')
        WHEN c.sr_7davg IS NULL THEN CONCAT('SR ',CAST(c.sr_pct AS STRING),'% (baseline incomplete).')
        WHEN c.sr_pct < c.sr_7davg-10 THEN CONCAT('SR DROP: ',CAST(c.sr_pct AS STRING),'% vs 7dAvg ',CAST(c.sr_7davg AS STRING),'% (avg CR ',CAST(c.avg_cr AS STRING),'% vs target ',CAST(c.avg_targ_cr AS STRING),'%).')
        WHEN c.sr_pct > c.sr_7davg+10 THEN CONCAT('SR strong: ',CAST(c.sr_pct AS STRING),'% vs 7dAvg ',CAST(c.sr_7davg AS STRING),'%.')
        ELSE CONCAT('SR steady: ',CAST(c.sr_pct AS STRING),'%.')
      END
    ) AS auto_rca

  FROM dau_final a
  FULL OUTER JOIN content_final c ON a.level=c.level AND a.segment=c.segment AND a.date_=c.date_
  FULL OUTER JOIN hdc_final h
    ON COALESCE(a.level,c.level)=h.level AND COALESCE(a.segment,c.segment)=h.segment AND COALESCE(a.date_,c.date_)=h.date_
  LEFT JOIN corr_block cb ON cb.level=COALESCE(a.level,c.level,h.level) AND cb.segment=COALESCE(a.segment,c.segment,h.segment)
  LEFT JOIN hdc_cr_daily cr4 ON cr4.level=COALESCE(a.level,c.level,h.level) AND cr4.segment=COALESCE(a.segment,c.segment,h.segment) AND cr4.date_=DATE_SUB(COALESCE(a.date_,c.date_,h.date_), INTERVAL 4 DAY)
  LEFT JOIN hdc_cr_daily cr2 ON cr2.level=COALESCE(a.level,c.level,h.level) AND cr2.segment=COALESCE(a.segment,c.segment,h.segment) AND cr2.date_=DATE_SUB(COALESCE(a.date_,c.date_,h.date_), INTERVAL 2 DAY)
)

SELECT *
FROM unified
WHERE report_date BETWEEN DATE_SUB(end_date, INTERVAL report_window_days DAY) AND end_date
ORDER BY
  report_date DESC,
  CASE level WHEN 'TOTAL' THEN 1 WHEN 'LANGUAGE' THEN 2 WHEN 'BU' THEN 3 ELSE 4 END,
  segment;

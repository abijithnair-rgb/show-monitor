-- ============================================================================
-- SEEKHO — CONTENT MORNING RCA v2  (Hindi-anchored, LABEL-LED, single query)
-- ----------------------------------------------------------------------------
-- Daily RCA with a full L0–L6 LABEL ENGINE at language + BU level, plus
-- per-show diagnostics. Run standalone daily; upload to the Daily RCA tab.
-- ============================================================================

DECLARE end_date           DATE   DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE scan_lookback_days INT64  DEFAULT 45;
DECLARE report_window_days INT64  DEFAULT 14;
DECLARE sr_freeze_days     INT64  DEFAULT 3;
DECLARE l7_days            INT64  DEFAULT 7;
DECLARE show_min_supply    INT64  DEFAULT 3;
DECLARE poor_l0_factor     FLOAT64 DEFAULT 0.6;
DECLARE high_l45_margin    FLOAT64 DEFAULT 15.0;
DECLARE active_threshold   FLOAT64 DEFAULT 80.0;
DECLARE start_date         DATE   DEFAULT DATE_SUB(end_date, INTERVAL scan_lookback_days DAY);
DECLARE hdc_end_date       DATE   DEFAULT DATE_SUB(end_date, INTERVAL 1 DAY);

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
    vp.timestamp AS event_ts,
    EXTRACT(HOUR FROM DATETIME(vp.timestamp,'Asia/Kolkata')) AS hour_ist,
    vp.user_id, sd.language, sd.bu_name, vp.watchtime_max,
    COALESCE(vp.source_screen,'unknown') AS source_screen,
    COALESCE(vp.source_section,'unknown') AS source_section,
    CASE
      WHEN vp.source_screen='from_notification' THEN 'push'
      WHEN vp.source_screen='from_moe_notification' THEN 'moe'
      WHEN vp.source_screen='sharing' THEN 'whatsapp'
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
  SELECT 'LANGUAGE' AS level, language AS segment, date_, event_ts, hour_ist, user_id, watchtime_max, source_type, source_screen, source_section, days_since_payment FROM vp_base
  UNION ALL SELECT 'TOTAL','overall_httmk', date_, event_ts, hour_ist, user_id, watchtime_max, source_type, source_screen, source_section, days_since_payment FROM vp_base
  UNION ALL SELECT 'BU', bu_name, date_, event_ts, hour_ist, user_id, watchtime_max, source_type, source_screen, source_section, days_since_payment FROM vp_base WHERE language='hi' AND bu_name<>'Other'
),
user_day_seg AS (
  SELECT level, segment, date_, user_id,
    SUM(watchtime_max) AS total_watchtime, MAX(watchtime_max) AS max_watchtime,
    ARRAY_AGG(IF(watchtime_max>=5, source_type, NULL) IGNORE NULLS ORDER BY event_ts ASC LIMIT 1)[SAFE_OFFSET(0)] AS source_type,
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
    TRUE AS sr_is_frozen,
    cur.avg_cr, cur.avg_targ_cr,
    cur.content_watch_hrs, CAST(NULL AS FLOAT64) AS cwh_dod, CAST(NULL AS FLOAT64) AS cwh_sdlw
  FROM sr_cur cur
  LEFT JOIN sr_prev prv ON prv.level=cur.level AND prv.segment=cur.segment AND prv.report_date=cur.report_date
),

-- ===========================================================================
-- LABEL ENGINE  (single source of truth for HDC=L0 and L1–L6)
-- ===========================================================================
lbl_series AS (
  SELECT cs.id AS series_id, cs.title AS series_title, cs.show_id, csh.title AS show_name,
    cs.language, COALESCE(bu.bu_name,'Other') AS bu_name, cs.duration_s,
    DATETIME(TIMESTAMP(cs.approved_on),'Asia/Kolkata') AS publish_ts_ist,
    DATETIME(TIMESTAMP_ADD(TIMESTAMP(cs.approved_on),INTERVAL 24 HOUR),'Asia/Kolkata') AS publish_24h_ts_ist,
    DATE(cs.approved_on,'Asia/Kolkata') AS publish_date
  FROM `seekho-c084b.seekho.courses_series` cs
  LEFT JOIN `seekho-c084b.seekho.courses_show` csh ON cs.show_id=csh.id
  LEFT JOIN seekho.users_creatorinfo ci ON cs.creator_id=ci.profile_id
  LEFT JOIN seekho.users_userprofile up ON ci.profile_id=up.user_ptr_id
  LEFT JOIN bu_mapping bu ON cs.category_id=bu.category_id
  WHERE DATE(cs.approved_on,'Asia/Kolkata') BETWEEN start_date AND end_date
    AND cs.language IN ('hi','ta','te','ml','kn')
    AND cs.duration_s>0 AND cs.approved_on IS NOT NULL
    AND (cs.state='live' OR cs.state='expired')
    AND up.is_quality_approved=TRUE
),
-- Canonical HDC population (qid match): PAID users only, ORGANIC only
-- (notification/sharing/moe stripped at source), from video_play + intraday
-- (settled-date guard avoids double-counting). Completes come from the SAME
-- organic watch (≥70% of duration), not a separate android-only table.
lbl_settled AS (
  SELECT DISTINCT DATE(`timestamp`,'Asia/Kolkata') AS settled_date
  FROM content_recommendation.video_play
  WHERE DATE(`timestamp`,'Asia/Kolkata') BETWEEN start_date AND DATE_ADD(end_date, INTERVAL 1 DAY)
),
lbl_paid_users AS (
  SELECT firebase_uid
  FROM seekho.users_userprofile
  WHERE firebase_uid IS NOT NULL AND first_purchased_on IS NOT NULL AND is_deleted = FALSE
),
lbl_watch_raw AS (
  SELECT `timestamp` AS event_ts, firebase_uid AS user_id, CAST(series_id AS INT64) AS series_id, CAST(watchtime AS FLOAT64) AS seconds
  FROM content_recommendation.video_play
  WHERE DATE(`timestamp`,'Asia/Kolkata') BETWEEN start_date AND DATE_ADD(end_date, INTERVAL 1 DAY)
    AND package_name NOT IN ('com.bolo.android','com.seekho.ios','com.seekhoai.android','com.seekhoglobal.ios','com.seekhoglobal.android')
    AND (source_screen NOT IN ('from_notification','sharing','from_moe_notification') OR source_screen IS NULL)
  UNION ALL
  SELECT `timestamp`, firebase_uid, CAST(series_id AS INT64), CAST(MAX(watchtime) AS FLOAT64)
  FROM content_recommendation.video_play_intraday
  WHERE DATE(`timestamp`,'Asia/Kolkata') BETWEEN start_date AND DATE_ADD(end_date, INTERVAL 1 DAY)
    AND DATE(`timestamp`,'Asia/Kolkata') NOT IN (SELECT settled_date FROM lbl_settled)
    AND package_name NOT IN ('com.bolo.android','com.seekho.ios','com.seekhoai.android','com.seekhoglobal.ios','com.seekhoglobal.android')
    AND (source_screen NOT IN ('from_notification','sharing','from_moe_notification') OR source_screen IS NULL)
  GROUP BY `timestamp`, firebase_uid, series_id
),
-- Organic watch tagged paid/not. HDC population differs by language:
--   Hindi (hi)            → PAID users only
--   Regional (ta/te/kn/ml)→ ALL organic users
-- The gate is applied below where the series language is known.
lbl_watch_organic AS (
  SELECT w.event_ts, w.user_id, w.series_id, w.seconds,
    CASE WHEN p.firebase_uid IS NOT NULL THEN 1 ELSE 0 END AS is_paid
  FROM lbl_watch_raw w
  LEFT JOIN lbl_paid_users p ON CAST(w.user_id AS STRING) = CAST(p.firebase_uid AS STRING)
),
lbl_views AS (
  SELECT se.series_id, se.series_title, se.show_id, se.show_name, se.language, se.bu_name, se.publish_date, se.duration_s,
    CASE WHEN COUNT(DISTINCT IF(se.language='hi' AND w.is_paid=0, NULL, w.user_id))>=1000
         THEN ROUND(COUNT(DISTINCT IF(se.language='hi' AND w.is_paid=0, NULL, w.user_id)),-2)
         ELSE COUNT(DISTINCT IF(se.language='hi' AND w.is_paid=0, NULL, w.user_id)) END AS views_24h,
    ROUND(SUM(IF(se.language='hi' AND w.is_paid=0, 0, COALESCE(w.seconds,0)))/3600.0,2) AS watch_hours
  FROM lbl_series se
  LEFT JOIN lbl_watch_organic w
    ON w.series_id=se.series_id AND w.user_id IS NOT NULL
   AND DATETIME(w.event_ts,'Asia/Kolkata')>=se.publish_ts_ist AND DATETIME(w.event_ts,'Asia/Kolkata')<se.publish_24h_ts_ist
  GROUP BY 1,2,3,4,5,6,7,8
),
lbl_watch AS (
  SELECT se.series_id, CAST(w.user_id AS STRING) AS user_id, SUM(COALESCE(w.seconds,0)) AS watch_time
  FROM lbl_series se
  JOIN lbl_watch_organic w
    ON w.series_id=se.series_id AND w.user_id IS NOT NULL
   AND DATETIME(w.event_ts,'Asia/Kolkata')>=se.publish_ts_ist AND DATETIME(w.event_ts,'Asia/Kolkata')<se.publish_24h_ts_ist
  WHERE NOT (se.language='hi' AND w.is_paid=0)
  GROUP BY 1,2
),
lbl_metrics AS (
  SELECT v.*, COUNT(DISTINCT CASE WHEN SAFE_DIVIDE(w.watch_time,v.duration_s)>=0.7 THEN w.user_id END) AS completes_24h
  FROM lbl_views v LEFT JOIN lbl_watch w ON w.series_id=v.series_id
  GROUP BY 1,2,3,4,5,6,7,8,9,10
),
lbl_p AS (
  SELECT *,
    PERCENTILE_CONT(views_24h,0.90) OVER (PARTITION BY publish_date,language) AS p90,
    PERCENTILE_CONT(views_24h,0.50) OVER (PARTITION BY publish_date,language) AS p50,
    PERCENTILE_CONT(views_24h,0.25) OVER (PARTITION BY publish_date,language) AS p25,
    PERCENTILE_CONT(views_24h,0.75) OVER (PARTITION BY publish_date,language) AS p75
  FROM lbl_metrics
),
labeled AS (
  SELECT *,
    LEAST(p90, CASE language WHEN 'te' THEN 500 WHEN 'ta' THEN 330 WHEN 'kn' THEN 200 WHEN 'ml' THEN 200 ELSE 1500 END) AS view_threshold_value,
    ROUND(10+(141.12/((duration_s/60.0)+1.8)),2) AS target_cr,
    ROUND(100*SAFE_DIVIDE(completes_24h,views_24h),2) AS actual_cr,
    CASE WHEN views_24h>=LEAST(p90, CASE language WHEN 'te' THEN 500 WHEN 'ta' THEN 330 WHEN 'kn' THEN 200 WHEN 'ml' THEN 200 ELSE 1500 END) THEN 1 ELSE 0 END AS view_thr,
    CASE WHEN 100*SAFE_DIVIDE(completes_24h,views_24h)>=10+(141.12/((duration_s/60.0)+1.8)) THEN 1 ELSE 0 END AS cr_thr
  FROM lbl_p
),
labeled2 AS (
  SELECT *,
    CASE WHEN view_thr=1 AND cr_thr=1 THEN 1 ELSE 0 END AS hdc_flag,
    CASE
      WHEN view_thr=1 AND cr_thr=1 THEN 'L0'
      WHEN view_thr=1 AND cr_thr=0 THEN 'L1'
      WHEN cr_thr=1 AND views_24h > IF(language='hi', 1000, p75) THEN 'L2'
      WHEN views_24h>p50 THEN 'L3'
      WHEN views_24h>=p25 AND views_24h<=p50 THEN 'L4'
      WHEN views_24h<p25 THEN 'L5'
      ELSE 'L6' END AS label
  FROM labeled
),
seg_label AS (
  SELECT 'LANGUAGE' AS level, language AS segment, publish_date, series_id, show_id, hdc_flag, label FROM labeled2
  UNION ALL SELECT 'TOTAL','overall_httmk', publish_date, series_id, show_id, hdc_flag, label FROM labeled2
  UNION ALL SELECT 'BU', bu_name, publish_date, series_id, show_id, hdc_flag, label FROM labeled2 WHERE language='hi' AND bu_name<>'Other'
),
label_daily AS (
  SELECT level, segment, publish_date AS date_,
    COUNT(*) AS supply,
    SUM(hdc_flag) AS l0,
    COUNTIF(label='L1') AS l1, COUNTIF(label='L2') AS l2, COUNTIF(label='L3') AS l3,
    COUNTIF(label='L4') AS l4, COUNTIF(label='L5') AS l5, COUNTIF(label='L6') AS l6,
    ROUND(100*SAFE_DIVIDE(SUM(hdc_flag),COUNT(*)),1) AS l0_pct,
    ROUND(100*SAFE_DIVIDE(COUNTIF(label IN ('L4','L5')),COUNT(*)),1) AS l4l5_pct
  FROM seg_label GROUP BY 1,2,3
),
label_roll AS (
  SELECT d.*,
    dod.l0 AS l0_dod, sdlw.l0 AS l0_sdlw,
    dod.supply AS supply_dod, sdlw.supply AS supply_sdlw,
    ROUND(AVG(d.l0)     OVER (PARTITION BY d.level,d.segment ORDER BY d.date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),1) AS l0_7davg,
    ROUND(AVG(d.supply) OVER (PARTITION BY d.level,d.segment ORDER BY d.date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),1) AS supply_7davg,
    ROUND(AVG(d.l0_pct) OVER (PARTITION BY d.level,d.segment ORDER BY d.date_ ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),1) AS l0_pct_7davg,
    SUM(d.l0)     OVER (PARTITION BY d.level,d.segment ORDER BY d.date_ ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS l0_7d,
    SUM(d.supply) OVER (PARTITION BY d.level,d.segment ORDER BY d.date_ ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS supply_7d,
    SUM(d.l4+d.l5) OVER (PARTITION BY d.level,d.segment ORDER BY d.date_ ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS l4l5_7d
  FROM label_daily d
  LEFT JOIN label_daily dod  ON dod.level=d.level  AND dod.segment=d.segment  AND dod.date_=DATE_SUB(d.date_,INTERVAL 1 DAY)
  LEFT JOIN label_daily sdlw ON sdlw.level=d.level AND sdlw.segment=d.segment AND sdlw.date_=DATE_SUB(d.date_,INTERVAL 7 DAY)
),
label_final AS (
  SELECT r.*,
    (r.date_ <= DATE_SUB(end_date, INTERVAL 1 DAY)) AS label_is_settled,
    ROUND(100*SAFE_DIVIDE(r.l0_7d, r.supply_7d),1) AS hdc_contribution_pct_7d,
    ROUND(100*SAFE_DIVIDE(r.l4l5_7d, r.supply_7d),1) AS l4l5_pct_7d
  FROM label_roll r
),

-- ===========================================================================
-- SHOW-LEVEL DIAGNOSTICS  (Hindi shows, trailing l7_days)
-- ===========================================================================
bu_pool_7d AS (
  SELECT bu_name,
    ROUND(100*SAFE_DIVIDE(SUM(hdc_flag),COUNT(*)),1) AS bu_l0_pct,
    ROUND(100*SAFE_DIVIDE(COUNTIF(label IN ('L4','L5')),COUNT(*)),1) AS bu_l4l5_pct
  FROM labeled2
  WHERE language='hi' AND bu_name<>'Other'
    AND publish_date BETWEEN DATE_SUB(end_date, INTERVAL l7_days DAY) AND hdc_end_date
  GROUP BY 1
),
show_7d AS (
  SELECT show_id,
    ANY_VALUE(show_name) AS show_name, ANY_VALUE(bu_name) AS bu_name,
    COUNT(*) AS supply_7d, SUM(hdc_flag) AS l0,
    COUNTIF(label='L1') AS l1, COUNTIF(label='L2') AS l2, COUNTIF(label='L3') AS l3,
    COUNTIF(label='L4') AS l4, COUNTIF(label='L5') AS l5, COUNTIF(label='L6') AS l6,
    ROUND(100*SAFE_DIVIDE(SUM(hdc_flag),COUNT(*)),1) AS l0_pct,
    ROUND(100*SAFE_DIVIDE(COUNTIF(label IN ('L4','L5')),COUNT(*)),1) AS l4l5_pct
  FROM labeled2
  WHERE language='hi'
    AND publish_date BETWEEN DATE_SUB(end_date, INTERVAL l7_days DAY) AND hdc_end_date
  GROUP BY show_id
),
show_freq AS (
  SELECT show_id, ANY_VALUE(freq) AS freq, ANY_VALUE(show_manager) AS show_manager
  FROM `seekho-c084b.analytics_content.show_detail`
  WHERE language='hi' AND freq IS NOT NULL
  GROUP BY show_id
),
show_diag AS (
  SELECT
    s.show_id, s.show_name, s.bu_name, s.supply_7d,
    s.l0, s.l1, s.l2, s.l3, s.l4, s.l5, s.l6, s.l0_pct, s.l4l5_pct,
    f.freq, f.show_manager,
    bp.bu_l0_pct, bp.bu_l4l5_pct,
    ROUND(SAFE_DIVIDE(s.supply_7d*100.0, f.freq),0) AS supply_vs_freq_pct,
    CASE WHEN f.freq IS NULL THEN NULL
         WHEN SAFE_DIVIDE(s.supply_7d*100.0, f.freq) >= active_threshold THEN 'Active' ELSE 'Inactive' END AS active_status,
    CASE WHEN f.freq IS NOT NULL AND SAFE_DIVIDE(s.supply_7d*100.0, f.freq) < active_threshold THEN 1 ELSE 0 END AS needs_supply_fix_flag,
    CASE WHEN s.supply_7d>=show_min_supply AND bp.bu_l0_pct IS NOT NULL AND s.l0_pct < poor_l0_factor*bp.bu_l0_pct THEN 1 ELSE 0 END AS poor_l0_flag,
    CASE WHEN s.supply_7d>=show_min_supply AND bp.bu_l4l5_pct IS NOT NULL AND s.l4l5_pct > bp.bu_l4l5_pct+high_l45_margin THEN 1 ELSE 0 END AS high_l45_flag
  FROM show_7d s
  LEFT JOIN show_freq f ON f.show_id=s.show_id
  LEFT JOIN bu_pool_7d bp ON bp.bu_name=s.bu_name
),
show_reco AS (
  SELECT d.*,
    TRIM(CONCAT(
      CASE WHEN d.needs_supply_fix_flag=1
           THEN CONCAT('SUPPLY: ',CAST(d.supply_7d AS STRING),'/',CAST(d.freq AS STRING),' wk (',CAST(d.supply_vs_freq_pct AS STRING),'% of target) — raise output. ')
           ELSE '' END,
      CASE WHEN d.poor_l0_flag=1
           THEN CONCAT('HIT-RATE: L0 ',CAST(d.l0_pct AS STRING),'% vs BU ',CAST(d.bu_l0_pct AS STRING),'% — rework formats/hooks. ')
           ELSE '' END,
      CASE WHEN d.high_l45_flag=1
           THEN CONCAT('TAIL: L4+L5 ',CAST(d.l4l5_pct AS STRING),'% vs BU ',CAST(d.bu_l4l5_pct AS STRING),'% — review topics/thumbnails/discovery. ')
           ELSE '' END,
      CASE WHEN d.supply_7d<show_min_supply
           THEN CONCAT('(low sample: only ',CAST(d.supply_7d AS STRING),' series in ',CAST(l7_days AS STRING),'d — quality flags suppressed) ')
           ELSE '' END,
      CASE WHEN d.needs_supply_fix_flag=0 AND d.poor_l0_flag=0 AND d.high_l45_flag=0 AND d.supply_7d>=show_min_supply
           THEN 'Healthy.' ELSE '' END
    )) AS show_recommendation
  FROM show_diag d
),

-- ===========================================================================
-- BLOCK D — CORRELATION  (uses label L0 as the HDC series)
-- ===========================================================================
corr_src AS (
  SELECT a.level, a.segment, a.date_, a.dau,
         c.sr_pct, CAST(l.l0 AS FLOAT64) AS hdc_count
  FROM dau_daily a
  LEFT JOIN content_daily c ON c.level=a.level AND c.segment=a.segment AND c.date_=a.date_
  LEFT JOIN label_daily  l ON l.level=a.level AND l.segment=a.segment AND l.date_=a.date_
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
-- UNIFY (A) — SEGMENT ROWS
-- ===========================================================================
seg_unified AS (
  SELECT
    -- report_date = the RUN day (D-0, the morning this row represents). DAU is the
    -- underlying D-1 day; HDC/labels are D-2 (carried in hdc_report_date). So a row
    -- run on the 15th has report_date=15, DAU for the 14th, HDC for the 13th.
    DATE_ADD(COALESCE(a.date_, c.date_), INTERVAL 1 DAY) AS report_date,
    COALESCE(a.level, c.level) AS level,
    COALESCE(a.segment, c.segment) AS segment,
    l.date_ AS hdc_report_date,
    CAST(NULL AS STRING) AS show_name,
    CAST(NULL AS STRING) AS show_manager,
    a.dau, a.dau_dod, a.dau_sdlw, a.dau_7davg, a.dau_dod_pct, a.dau_sdlw_pct, a.dau_7davg_pct,
    a.mins_per_dau, a.mins_per_dau_dod,
    a.dau_organic, a.dau_push, a.dau_moe, a.dau_whatsapp,
    a.dau_new, a.dau_retained, a.dau_resurrected,
    a.dau_d0, a.dau_d1_d3, a.dau_d4_d7, a.dau_d8_d14, a.dau_d15_d30, a.dau_d30_plus,
    a.src_drop_driver, a.usertype_drop_driver, a.cohort_drop_driver, a.top_surface_drops, a.peak_drop_hour,
    c.series_launched, c.series_success, c.series_fail, c.series_tracking,
    c.sr_pct, c.sr_sdlw, c.sr_7davg, c.sr_is_frozen, c.avg_cr, c.avg_targ_cr, c.content_watch_hrs,
    l.supply, l.l0, l.l1, l.l2, l.l3, l.l4, l.l5, l.l6,
    l.l0_pct, l.l4l5_pct,
    l.l0 AS hdc_count, l.l0_pct AS hdc_rate, l.l0_7davg AS hdc_count_7davg, l.supply_7davg, l.l0_pct_7davg,
    l.l0_dod AS hdc_dod, l.l0_sdlw AS hdc_sdlw, l.supply_dod, l.supply_sdlw,
    l.label_is_settled,
    l.l0_7d AS hdc_7d, l.supply_7d AS supply_7d_seg, l.l4l5_7d,
    l.hdc_contribution_pct_7d, l.l4l5_pct_7d,
    CAST(NULL AS INT64)   AS show_supply_7d,
    CAST(NULL AS INT64)   AS show_freq,
    CAST(NULL AS FLOAT64) AS show_supply_vs_freq_pct,
    CAST(NULL AS STRING)  AS show_active_status,
    CAST(NULL AS FLOAT64) AS bu_l0_pct, CAST(NULL AS FLOAT64) AS bu_l4l5_pct,
    CAST(NULL AS INT64)   AS poor_l0_flag, CAST(NULL AS INT64) AS high_l45_flag, CAST(NULL AS INT64) AS needs_supply_fix_flag,
    CAST(NULL AS STRING)  AS show_recommendation,
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
      WHEN l.l0 IS NULL THEN 'no_content_launched'
      WHEN NOT (l.date_ <= DATE_SUB(end_date, INTERVAL 1 DAY)) THEN 'still_settling'
      WHEN l.l0_7davg IS NULL THEN 'baseline_incomplete'
      WHEN l.l0 < l.l0_7davg - GREATEST(1, 0.20*l.l0_7davg) THEN 'HDC_DROP'
      WHEN l.l0 > l.l0_7davg + GREATEST(1, 0.20*l.l0_7davg) THEN 'HDC_RISE'
      ELSE 'normal'
    END AS hdc_verdict,
    CASE
      WHEN l.l0 IS NULL OR NOT (l.date_ <= DATE_SUB(end_date, INTERVAL 1 DAY)) OR l.l0_7davg IS NULL THEN NULL
      WHEN NOT (l.l0 < l.l0_7davg - GREATEST(1,0.20*l.l0_7davg)) THEN NULL
      WHEN l.supply < l.supply_7davg*0.85 THEN 'HDC down mainly SUPPLY (fewer launches)'
      WHEN l.l1 >= (l.l4+l.l5) THEN 'HDC down mainly CONTENT (L1 reach-but-no-completion — hook/pacing/target CR)'
      ELSE 'HDC down mainly DISTRIBUTION/REACH (L3–L5 heavy — recommendations/thumbnails/topics)'
    END AS hdc_attribution,
    CASE
      WHEN a.dau IS NULL AND l.l0 IS NULL THEN NULL
      WHEN a.dau_7davg IS NULL OR l.l0_7davg IS NULL OR NOT (l.date_ <= DATE_SUB(end_date, INTERVAL 1 DAY)) THEN 'insufficient_baseline'
      WHEN l.l0 < l.l0_7davg*0.8 AND c.sr_pct < c.sr_7davg-10 AND a.dau < a.dau_7davg*0.97
        THEN 'CONTENT-LED DECLINE: HDC+SR+DAU all down — fresh content weak AND pulling DAU down'
      WHEN l.l0 < l.l0_7davg*0.8 AND a.dau >= a.dau_7davg*0.97
        THEN 'LEADING RISK: HDC down but DAU still holding on catalog — expect DAU softness if it persists'
      WHEN l.l0 > l.l0_7davg*1.2 AND a.dau > a.dau_7davg*1.03
        THEN 'FRESH HITS LIFTING DAU: HDC up + DAU up'
      WHEN a.dau < a.dau_7davg*0.97 AND l.l0 >= l.l0_7davg*0.8 AND c.sr_pct >= c.sr_7davg-10
        THEN 'NOT CONTENT: DAU down while content healthy — check distribution/notif/seasonality'
      WHEN l.l0 > l.l0_7davg*1.2 AND a.dau < a.dau_7davg*0.97
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
        WHEN l.l0 IS NULL THEN ''
        WHEN NOT (l.date_ <= DATE_SUB(end_date, INTERVAL 1 DAY)) THEN CONCAT('HDC still settling (',CAST(l.supply AS STRING),' launched). ')
        WHEN l.l0_7davg IS NULL THEN CONCAT('HDC(L0) ',CAST(l.l0 AS STRING),'/',CAST(l.supply AS STRING),' (baseline incomplete). ')
        WHEN l.l0 < l.l0_7davg - GREATEST(1,0.20*l.l0_7davg)
          THEN CONCAT('HDC DROP: L0 ',CAST(l.l0 AS STRING),' vs 7dAvg ',CAST(l.l0_7davg AS STRING),
               ' (L0% ',CAST(l.l0_pct AS STRING),'% vs ',CAST(l.l0_pct_7davg AS STRING),'%; split L1/L2/L3/L4/L5 = ',
               CAST(l.l1 AS STRING),'/',CAST(l.l2 AS STRING),'/',CAST(l.l3 AS STRING),'/',CAST(l.l4 AS STRING),'/',CAST(l.l5 AS STRING),'). ',
               CASE WHEN l.l1 >= (l.l4+l.l5) THEN 'Mostly L1 (CR misses) -> content/hook. ' ELSE 'Mostly tail (L4/L5) -> reach/discovery. ' END)
        WHEN l.l0 > l.l0_7davg + GREATEST(1,0.20*l.l0_7davg) THEN CONCAT('HDC up: L0 ',CAST(l.l0 AS STRING),' vs 7dAvg ',CAST(l.l0_7davg AS STRING),'. ')
        ELSE CONCAT('HDC steady: L0 ',CAST(l.l0 AS STRING),'/',CAST(l.supply AS STRING),' (L0% ',CAST(l.l0_pct AS STRING),'%; L4+L5 ',CAST(l.l4l5_pct AS STRING),'%). ')
      END,
      CASE
        WHEN l.hdc_contribution_pct_7d IS NOT NULL THEN CONCAT('7d HDC contribution ',CAST(l.hdc_contribution_pct_7d AS STRING),'% (',CAST(l.l0_7d AS STRING),'/',CAST(l.supply_7d AS STRING),'). ') ELSE '' END,
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
  LEFT JOIN label_final l
    ON l.level=COALESCE(a.level,c.level) AND l.segment=COALESCE(a.segment,c.segment) AND l.date_=DATE_SUB(COALESCE(a.date_,c.date_), INTERVAL 1 DAY)
  LEFT JOIN corr_block cb ON cb.level=COALESCE(a.level,c.level) AND cb.segment=COALESCE(a.segment,c.segment)
),

-- ===========================================================================
-- UNIFY (B) — SHOW ROWS
-- ===========================================================================
show_unified AS (
  SELECT
    DATE_ADD(end_date, INTERVAL 1 DAY) AS report_date,   -- run day (D-0)
    'SHOW' AS level,
    r.bu_name AS segment,
    hdc_end_date AS hdc_report_date,
    r.show_name, r.show_manager,
    CAST(NULL AS INT64) AS dau, CAST(NULL AS INT64) AS dau_dod, CAST(NULL AS INT64) AS dau_sdlw, CAST(NULL AS FLOAT64) AS dau_7davg,
    CAST(NULL AS FLOAT64) AS dau_dod_pct, CAST(NULL AS FLOAT64) AS dau_sdlw_pct, CAST(NULL AS FLOAT64) AS dau_7davg_pct,
    CAST(NULL AS FLOAT64) AS mins_per_dau, CAST(NULL AS FLOAT64) AS mins_per_dau_dod,
    CAST(NULL AS INT64) AS dau_organic, CAST(NULL AS INT64) AS dau_push, CAST(NULL AS INT64) AS dau_moe, CAST(NULL AS INT64) AS dau_whatsapp,
    CAST(NULL AS INT64) AS dau_new, CAST(NULL AS INT64) AS dau_retained, CAST(NULL AS INT64) AS dau_resurrected,
    CAST(NULL AS INT64) AS dau_d0, CAST(NULL AS INT64) AS dau_d1_d3, CAST(NULL AS INT64) AS dau_d4_d7, CAST(NULL AS INT64) AS dau_d8_d14, CAST(NULL AS INT64) AS dau_d15_d30, CAST(NULL AS INT64) AS dau_d30_plus,
    CAST(NULL AS STRING) AS src_drop_driver, CAST(NULL AS STRING) AS usertype_drop_driver, CAST(NULL AS STRING) AS cohort_drop_driver, CAST(NULL AS STRING) AS top_surface_drops, CAST(NULL AS STRING) AS peak_drop_hour,
    CAST(NULL AS INT64) AS series_launched, CAST(NULL AS INT64) AS series_success, CAST(NULL AS INT64) AS series_fail, CAST(NULL AS INT64) AS series_tracking,
    CAST(NULL AS FLOAT64) AS sr_pct, CAST(NULL AS FLOAT64) AS sr_sdlw, CAST(NULL AS FLOAT64) AS sr_7davg, CAST(NULL AS BOOL) AS sr_is_frozen,
    CAST(NULL AS FLOAT64) AS avg_cr, CAST(NULL AS FLOAT64) AS avg_targ_cr, CAST(NULL AS FLOAT64) AS content_watch_hrs,
    r.supply_7d AS supply, r.l0, r.l1, r.l2, r.l3, r.l4, r.l5, r.l6,
    r.l0_pct, r.l4l5_pct,
    r.l0 AS hdc_count, r.l0_pct AS hdc_rate, CAST(NULL AS FLOAT64) AS hdc_count_7davg, CAST(NULL AS FLOAT64) AS supply_7davg, CAST(NULL AS FLOAT64) AS l0_pct_7davg,
    CAST(NULL AS INT64) AS hdc_dod, CAST(NULL AS INT64) AS hdc_sdlw, CAST(NULL AS INT64) AS supply_dod, CAST(NULL AS INT64) AS supply_sdlw,
    TRUE AS label_is_settled,
    CAST(r.l0 AS INT64) AS hdc_7d, r.supply_7d AS supply_7d_seg, CAST((r.l4+r.l5) AS INT64) AS l4l5_7d,
    r.l0_pct AS hdc_contribution_pct_7d, r.l4l5_pct AS l4l5_pct_7d,
    r.supply_7d AS show_supply_7d,
    r.freq AS show_freq,
    r.supply_vs_freq_pct AS show_supply_vs_freq_pct,
    r.active_status AS show_active_status,
    r.bu_l0_pct, r.bu_l4l5_pct,
    r.poor_l0_flag, r.high_l45_flag, r.needs_supply_fix_flag,
    r.show_recommendation,
    CAST(NULL AS FLOAT64) AS corr_hdc_dau, CAST(NULL AS FLOAT64) AS corr_sr_dau, CAST(NULL AS FLOAT64) AS corr_hdc_sr,
    CAST(NULL AS STRING) AS dau_verdict,
    CAST(NULL AS STRING) AS sr_verdict,
    CASE WHEN r.poor_l0_flag=1 THEN 'POOR_L0' WHEN r.high_l45_flag=1 THEN 'HIGH_L4L5' ELSE 'ok' END AS hdc_verdict,
    CASE WHEN r.poor_l0_flag=1 AND r.high_l45_flag=1 THEN 'quality: low hits AND heavy tail'
         WHEN r.poor_l0_flag=1 THEN 'quality: low hit-rate vs BU'
         WHEN r.high_l45_flag=1 THEN 'quality: heavy low-view tail vs BU' ELSE NULL END AS hdc_attribution,
    CASE WHEN r.needs_supply_fix_flag=1 THEN 'supply gap vs frequency target' ELSE NULL END AS comovement_pattern,
    r.show_recommendation AS auto_rca
  FROM show_reco r
)

SELECT * FROM seg_unified
WHERE report_date BETWEEN DATE_SUB(end_date, INTERVAL report_window_days DAY) AND DATE_ADD(end_date, INTERVAL 1 DAY)
UNION ALL
SELECT * FROM show_unified
ORDER BY
  report_date DESC,
  CASE level WHEN 'TOTAL' THEN 1 WHEN 'LANGUAGE' THEN 2 WHEN 'BU' THEN 3 WHEN 'SHOW' THEN 4 ELSE 5 END,
  segment, show_name;

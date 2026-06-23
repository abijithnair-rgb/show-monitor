-- =====================================================================
-- LANGUAGE-LEVEL SUCCESS RATE (settled series, active shows).
-- SR = successful ÷ (successful + failed) over the DISTINCT series published
-- in the window [today-10 .. today-4], for shows that are active & live, in the
-- five target languages. status from analytics_content.content_performance
-- (1 = success, 0 = failed; NULL excluded).
--
-- Consumed by the Experiments tab "Success rate by language" panel via the
-- COMBINED export (dataset tag 'langsr'). The standalone parameterised version
-- (date-range picker) is below for ad-hoc Redash use.
-- =====================================================================
WITH active_shows AS (
  SELECT DISTINCT id AS show_id
  FROM `seekho-c084b.seekho.courses_show`
  WHERE show_type = 'active' AND state = 'live'
),
c AS (
  SELECT cs.show_id, cs.language, cp.series_id, cp.status
  FROM `seekho-c084b.analytics_content.content_performance` cp
  JOIN `seekho-c084b.seekho.courses_series` cs ON cs.id = cp.series_id
  WHERE cp.publish_date BETWEEN DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 10 DAY)
                            AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 4 DAY)
    AND cs.language IN ('hi','ta','te','ml','kn')
    AND cs.show_id IN (SELECT show_id FROM active_shows)
    AND (cs.state = 'live' OR cs.state = 'expired')
)
-- Per-show grain (matches the COMBINED 'langsr' dataset). Roll up to language /
-- BU / POC by summing successful & failed across the relevant shows.
SELECT
  show_id,
  ANY_VALUE(language)                              AS language,
  COUNT(DISTINCT series_id)                        AS series,
  COUNT(DISTINCT IF(status = 1, series_id, NULL))  AS successful,
  COUNT(DISTINCT IF(status = 0, series_id, NULL))  AS failed
FROM c
GROUP BY show_id
ORDER BY show_id;

-- =====================================================================
-- Ad-hoc parameterised version (Redash date picker) — overall + per language.
-- =====================================================================
-- WITH active_shows AS (
--   SELECT DISTINCT id AS show_id FROM seekho-c084b.seekho.courses_show
--   WHERE show_type = 'active' AND state = 'live'
-- ),
-- c AS (
--   SELECT cs.language, cp.series_id, cp.status
--   FROM analytics_content.content_performance cp
--   JOIN seekho-c084b.seekho.courses_series cs ON cs.id = cp.series_id
--   WHERE cp.publish_date BETWEEN '{{ approved_on.start }}' AND '{{ approved_on.end }}'
--     AND cs.language IN ('hi','ta','te','ml','kn')
--     AND cs.show_id IN (SELECT show_id FROM active_shows)
--     AND (cs.state = 'live' OR cs.state = 'expired')
-- )
-- SELECT language,
--   COUNT(DISTINCT series_id) AS series,
--   COUNT(DISTINCT IF(status=1, series_id, NULL)) AS successful,
--   COUNT(DISTINCT IF(status=0, series_id, NULL)) AS failed,
--   CONCAT(ROUND(100 * COUNT(DISTINCT IF(status=1,series_id,NULL))
--     / NULLIF(COUNT(DISTINCT IF(status=1,series_id,NULL)) + COUNT(DISTINCT IF(status=0,series_id,NULL)),0)), '%') AS SR
-- FROM c GROUP BY 1 ORDER BY language DESC;

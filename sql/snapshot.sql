-- H123 views — latest `starts` per series from the CMS source of truth
-- (analytics_content.content_metrics_run_log_v2). Upload the CSV; the tool joins
-- it onto episodes by series_id and uses `views` as the H123 view count.
with latest_snap as (
  select
    series_id,
    starts                          as views,
    snapshot_tag,
    computed_at                     as snapshot_computed_at
  from `seekho-c084b.analytics_content.content_metrics_run_log_v2`
  -- `starts` is cumulative; take the MAX per series (most-complete = matches CMS UI).
  qualify row_number() over (
    partition by series_id
    order by starts desc, computed_at desc
  ) = 1
),

series_info as (
  select
    id                              as series_id,
    date(approved_on, 'Asia/Kolkata') as approved_on
  from `seekho-c084b.seekho.courses_series`
)

select
  l.series_id,
  s.approved_on,
  l.views,
  l.snapshot_tag,
  l.snapshot_computed_at
from latest_snap l
left join series_info s on s.series_id = l.series_id
order by s.approved_on desc, l.series_id

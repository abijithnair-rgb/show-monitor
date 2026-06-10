-- Live Performance Snapshot — latest H1 / H12 / H123 row per series.
-- Source of truth for H123 VIEWS + completion: analytics_content.content_metrics_run_log_v2
-- (the CMS view-count source). One row per series, freshest computed_at wins;
-- includes series approved 1-2 days ago.
--
-- This is the authoritative source for the tool's H123 view count, completion
-- rate, and PASS/FAIL verdict. Merge these columns into the Fatigue query so the
-- Fatigue CSV carries them per series (the tool reads, in priority order):
--   H123 views        ← views   (alias of starts)   [falls back to h123_unique_viewers]
--   H123 completion   ← completion_rate             [falls back to h123_completion_rate_pct]
--   outcome           ← comp_verdict (PASS/FAIL)    [falls back to video_status / completion≥target]
--   episode date      ← publish_date                [falls back to approved_dt]
--   maturity flag     ← snapshot_tag (H1/H12/H123)  → 'provisional' until frozen at H123

with latest_snap as (
  select
    series_id,
    creator_id,
    show_id,
    category_id,
    language,
    title              as series_title,
    publish_date,
    series_duration_mins,
    watch_hrs,
    starts,
    completes,
    completion_rate,
    targ_comp,
    avg_rating,
    status,
    computed_at,
    snapshot_tag
  from `seekho-c084b.analytics_content.content_metrics_run_log_v2`
  where language = '{{language}}'
    and publish_date between '{{publish_date.start}}' and '{{publish_date.end}}'
  qualify row_number() over (
    partition by series_id
    order by computed_at desc
  ) = 1
),

shows as (
  select id as show_id, title as show_title, show_type
  from `seekho-c084b.seekho.courses_show`
),

categories as (
  select id as category_id, title as category_title
  from `seekho-c084b.seekho.courses_category`
)

select
  l.publish_date,
  date_diff(current_date('Asia/Kolkata'), l.publish_date, day)              as days_since_publish,
  l.snapshot_tag,
  case l.snapshot_tag when 'H123' then 'frozen' else 'provisional' end      as maturity,
  l.series_id,
  l.series_title,
  l.language,
  l.show_id,
  s.show_title,
  s.show_type,
  c.category_title,
  l.creator_id,
  l.series_duration_mins,
  l.watch_hrs,
  l.starts                                                                  as views,
  l.completes,
  round(l.completion_rate, 2)                                               as completion_rate,
  round(l.targ_comp, 2)                                                     as targ_comp,
  case
    when l.completion_rate is null or l.targ_comp is null then null
    when l.completion_rate >= l.targ_comp then 'PASS'
    else 'FAIL'
  end                                                                       as comp_verdict,
  l.avg_rating,
  l.status,
  l.computed_at                                                             as snapshot_computed_at
from latest_snap l
left join shows      s on s.show_id     = l.show_id
left join categories c on c.category_id = l.category_id
order by l.publish_date desc, l.series_id

-- =====================================================================
-- PAID DAU per show × day (last 7 displayed days, D-7..D-1).
-- Columns consumed by the Deep Dive "Paid DAU" chart:
--   show_id, date_, paid_users, paid_users_7d_avg
-- (paid_watch_hours / paid_timespent_mins are extra context, not charted.)
--
-- To surface this in the tool, fold these rows into the COMBINED export with
-- dataset tag 'dau' and the row serialized into row_json — see sql/combined.sql
-- for how the other datasets (audience/retention) are wrapped.
-- =====================================================================
with trials as (
  -- first real paid order per profile
  select distinct
    eo.profile_id,
    date(min(pph.purchased_on), 'Asia/Kolkata') as payment_date
  from seekho.experiments_order eo
  left join seekho.experiments_profilepurchasehistory pph
    on eo.id = pph.order_id
  where lower(eo.status) in ('order_paid')
    and eo.premium_item_id is null
    and eo.is_prod = true
    and date(pph.purchased_on, 'Asia/Kolkata') >= '2022-01-01'
  group by 1
),

base as (
  -- paid users' plays, attributed to each series' show
  -- pull D-13..D-1 so the trailing-7d avg is fully formed on every displayed date (D-7..D-1)
  select
    date(vp.timestamp, 'Asia/Kolkata') as date_,
    ser.show_id,
    vp.user_id,
    vp.watchtime_max
  from content_recommendation.video_play_combined vp
  join trials
    on trials.profile_id = vp.user_id
    and date(vp.timestamp, 'Asia/Kolkata') >= trials.payment_date  -- only count on/after payment
  join seekho.courses_series ser
    on cast(ser.id as string) = vp.series_id  -- series_id is STRING on video_play_combined; cast the small side
  where date(vp.timestamp, 'Asia/Kolkata')
        between date_sub(current_date('Asia/Kolkata'), interval 13 day)
            and date_sub(current_date('Asia/Kolkata'), interval 1 day)
    and ser.language in ('hi','ta','te','ml','kn','hi-jr')
),

show_daily as (
  -- one row per (date, show); NULL show_id collapses into the (no show) bucket
  select
    date_,
    show_id,
    count(distinct user_id) as paid_users,
    sum(watchtime_max) as watch_secs
  from base
  group by 1, 2
),

labeled as (
  select
    sd.date_,
    sd.show_id,
    coalesce(cs.title, concat('show ', cast(sd.show_id as string))) as show_title,
    sd.paid_users,
    sd.watch_secs
  from show_daily sd
  left join seekho.courses_show cs
    on sd.show_id = cs.id
  where sd.show_id is not null
),

rolled as (
  select
    date_,
    show_id,
    show_title,
    paid_users,
    -- trailing 7-calendar-day average DAU: sum of daily DAU over the last 7 days / 7 (gap days = 0)
    round(
      safe_divide(
        sum(paid_users) over (
          partition by show_id
          order by unix_date(date_)
          range between 6 preceding and current row
        ),
        7.0
      ),
    2) as paid_users_7d_avg,
    round(safe_divide(watch_secs, 3600.0), 1) as paid_watch_hours,
    round(safe_divide(watch_secs, 60.0 * paid_users), 2) as paid_timespent_mins
  from labeled
)

select
  date_,
  show_id,
  show_title,
  paid_users,
  paid_users_7d_avg,
  paid_watch_hours,
  paid_timespent_mins
from rolled
where date_ >= date_sub(current_date('Asia/Kolkata'), interval 7 day)  -- display only D-7..D-1
order by date_ desc, paid_users desc;

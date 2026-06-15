import { esc } from './format';

// Metric tooltips (how each number is calculated) — ported verbatim.
export const METRIC_TIPS = {
  show: 'The show, with its language and category chips.',
  status: 'Show lifecycle state from the catalog: <b>active</b> (live/production), <b>experiment</b> (new bet being tested), or <b>inactive</b> (not currently running).',
  lifecycle: "New Show Evaluation verdict. Compares the show's <b>contribution %</b> (its share of the language's users) against peer percentile bars: <b>stop</b>=P25, <b>weak</b>=P40, <b>retain</b>=P60, <b>strong</b>=P75 within its language×category cohort. Also shows the recent-trajectory direction (last 3 weeks).",
  users: 'Distinct paid users who watched this show in the current week (HLL sketch, ~1% error). From the Evaluation framework.',
  fatigue_lens: 'Content Fatigue Monitor diagnosis: the dominant episode failure mode (Hook / Pace / Ending) over the last 10 evaluable episodes, plus the recommended action (scale, hold, fix, cut cadence, shutdown).',
  unified: 'The reconciled call combining both lenses — e.g. a peer-weak show with a fixable Hook problem becomes "Fixable decline: fix before cutting". See the Guideline tab for the full matrix.',
  agreement: 'Whether the two lenses point the same way. <b>Aligned</b> = both positive or both negative (high confidence). <b>Conflict</b> = they disagree (needs human judgment). <b>One lens</b> = matched in only one CSV.',
  contribution: "Contribution % = show's current-week users ÷ language's current-week users × 100. The single most important lifecycle number.",
  peer: 'Number of peer shows the thresholds were built from, and the cohort type: <b>category_x_language</b> (≥5 peers in that category) or <b>language_only</b> fallback.',
  confidence: 'Confidence tier from peer count + show users: <b>high</b> (≥20 peers & ≥1000 users), <b>medium</b> (≥10 & ≥500), else <b>low</b>.',
  fatigue_score: 'Computed over the <b>last 7 days</b> (videos approved today-8 to today-2), z-scored within language, weighted: <b>Comp efficiency Δ H123 60%</b> + <b>Category reach Δ 20%</b> + <b>6-day return 20%</b>. Higher = healthier (0 ≈ language average). Rough guide: <b>≥ 0.5 good</b>, <b>-0.5 to 0.5 watch</b>, <b>≤ -0.5 poor</b>. The chip (green/yellow/red) is the precise zone: top 65% / next 20% / bottom 15% within language.',
  success_rate: '% of successful videos among the last 7 videos whose H123 window has fully settled — approved between 4 and 10 days ago (older than the 72h H123 window + 1 buffer day) and with H123 data present. Success = content_performance.status=1, or (status null) H123 completion ≥ target. Denominator capped at 7.',
  return6: '6-day return rate (Duolingo model): of all show-user-days, the share where the same user returned to the show within the next 6 days. Right-censoring fix excludes the last 6 days of the window. The sub-line is the average across all shows in this language.',
  saturation: 'Average weekly saturation = avg episodes a user watched ÷ episodes published that week, across the last 4 weeks. >100% means users re-watch or binge multiple episodes.',
  cat_reach: "Category reach % = the show's D0 viewers ÷ the category's paid daily active users, averaged across the last 4 weeks. How much of the category audience each episode pulls. The sub-line is the average across all shows in this language.",
  time_per_play: 'Average minutes watched per play over the <b>last 7 days</b> (D-8 to D-2 IST), across all watch events for this show on Seekho main-language packages. = total watchtime ÷ play events. The sub-line is the play-event count. Shows with fewer than 20 plays in the window are excluded.',
  watch_hours: 'Total hours watched for this show over the <b>last 7 days</b> (D-8 to D-2 IST) = sum of watchtime ÷ 3600, across all plays on Seekho main-language packages. The sub-line is the count of unique viewers. Shows with fewer than 20 plays in the window are excluded.',
  hdc_rate: 'HDC rate = HDC (L0) content ÷ total content this show published in the last 7 days (today-8 to today-2) × 100. HDC = a video that crossed the p90/language view cap AND its completion target within 24h.',
  hdc_block: 'High-Demand-Content supply and label mix for this show over the last 7 days (publish_date from today-8 to today-2; today excluded because its 24h window is still open).',
  hdc_supply: 'Total videos this show published in the last-7-day window.',
  hdc_count: 'Number of those videos that qualified as HDC (label L0).',
  hdc_avglevel: 'Average label level across the window (L0=0 … L6=6 over labelled videos). Lower is better.',
  mode_label: 'Most-common label this show received over the last 7 days (today-8 to today-2). The label that appears on the most days wins; ties break toward the worse (higher) label. E.g. L2×2 days, L3×2, L5×3 → L5.',
  label_L0: 'L0 — HDC: crossed the view threshold AND the completion-rate target within 24h. Top-performing.',
  label_L1: 'L1 — crossed the view threshold but missed the completion target (high reach, weak retention).',
  label_L2: 'L2 — met the completion target and >p75 views, but did not qualify for HDC (strong engagement, meaningful scale).',
  label_L3: 'L3 — missed view/CR thresholds but views above the day×language median (p50).',
  label_L4: 'L4 — views between p25 and p50 for the day×language cohort (average to below-average).',
  label_L5: 'L5 — views below p25 for the day×language cohort (low-performing).',
  label_L6: 'L6 — fallback for uncategorised or edge-case series.',
  hero_red: 'Shows whose unified call is Stop / urgent — Confirmed Stop or Review for Stop.',
  hero_amber: 'Shows whose unified call is Fix / adjust — Fixable Decline, Cut/Trim Cadence, Tune, Watch & Fix.',
  hero_green: 'Shows whose unified call is positive — Promote, Scale Up, or Hold (healthy).',
  hero_grey: 'Shows to watch or that matched only one lens (single-lens / Needs a look).',
  ep: 'Episode number within the show.',
  series_title: 'Title of the individual episode (series) in this show.',
  approved: 'Date the episode was approved (IST).',
  d0views: 'D0 views ≈ H1: the final H1 `starts` from the CMS source of truth (content_metrics_run_log_v2) — the largest H1 reading just before it rolls into H12.',
  h123views: 'H123 views = the <b>latest</b> snapshot\'s `starts` for the series from the CMS source of truth (content_metrics_run_log_v2), freshest computed_at per series. Used as-is regardless of snapshot tag.',
  h123_views: 'Average H123 viewers per episode across the last 4 weeks — distinct paid users who watched within the first 72h (D0+D1+D2) of approval. The D0 figure beneath is same-day viewers for contrast.',
  outcome: 'Success/fail: content_performance.status if set, else H123 completion ≥ target completion.',
  comp_eff: 'Completion efficiency H123 = H123 completion ÷ per-video target completion × 100. 100% means it hit its target.',
  hook_ret: 'Hook retention: cumulative % of starters still watching at 30 seconds. Coloured against the <b>data-backed minimum for this video\'s length</b> (e.g. 2–2.5 min needs ≥70% @30s). Green = at/above the floor (on track to beat target completion), amber = within 5pp, red = below. Floors come from the p5 of target-beating videos.',
  mid_ret: 'Mid retention: cumulative % of starters still watching at the 50% mark — the best early-warning checkpoint. Coloured against the data-backed minimum for this video\'s length (e.g. 2–2.5 min needs ≥55% @50%). Green = at/above floor, amber = within 5pp, red = below.',
  end_ret: 'End retention: cumulative % of starters still watching at 70% of the video (≈ the completion rate). Coloured against the data-backed minimum for this video\'s length (e.g. 2–2.5 min needs ≥47% @70%). Green = at/above floor, amber = within 5pp, red = below.',
  failure: 'Per-episode failure mode: the weakest retention checkpoint when it is also below the language 25th-percentile (HOOK / PACE / ENDING), else OK.',
};

// returns an attribute string ` data-tip="..."` for use in HTML-string builders
export function tip(key) {
  const t = METRIC_TIPS[key];
  return t ? ` data-tip="${esc(t)}"` : '';
}

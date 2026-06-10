// Required columns, action metadata, tabs, upload config — verbatim from the original.

export const EVAL_REQUIRED = ['language','category_id','category_name','show_type','state','show_id','show_title','launch_date','period_type','period_name','period_number','threshold_used','peer_count','show_users','language_users','show_users_contrib_pct_of_language','stop_below_users_contrib_pct','weak_below_users_contrib_pct','retain_above_users_contrib_pct','strong_above_users_contrib_pct','period_contrib_status','launch_trajectory','recent_trajectory','confidence','show_verdict','experimental_decision','decision_reason'];

export const FAT_REQUIRED = ['show_id','show_title','language','approved_dt','d0_unique_viewers','h123_unique_viewers','d0_completion_rate_pct','h123_completion_rate_pct','failure_mode','show_dominant_failure_mode','show_6day_return_rate_pct','show_avg_saturation_pct','show_action_recommendation','show_fatigue_score','show_fatigue_zone','show_remarks'];

// "one of these must be present" groups — tolerates CSVs from before the 8→10 episode-window rename
export const FAT_EITHER = [['comp_pass_rate_7eps_pct', 'comp_pass_rate_10eps_pct', 'comp_pass_rate_8eps_pct']];

// HDC label CSV (one row per series): show-level HDC supply + L0..L6 label, per publish_date.
export const HDC_REQUIRED = ['show_id', 'publish_date', 'series_id', 'HDC_threshold', 'Label'];

// HDC query now covers all 5 languages; this set is used only for diagnostics.
export const HDC_LANGS = new Set(['te', 'ta', 'ml', 'kn']);

export const ACTION_META = {
  CONFIRMED_STOP: { tone: 'red', label: 'Confirmed Stop', icon: '🛑' },
  STOP_REVIEW: { tone: 'red', label: 'Review for Stop', icon: '🛑' },
  OVERPUBLISHING: { tone: 'amber', label: 'Cut Cadence', icon: '📉' },
  FIXABLE_DECLINE: { tone: 'amber', label: 'Fixable Decline', icon: '🎬' },
  PROMOTE: { tone: 'green', label: 'Promote', icon: '📈' },
  PROMOTE_WITH_FIX: { tone: 'green', label: 'Promote + Fix', icon: '📈' },
  SCALE: { tone: 'green', label: 'Scale Up', icon: '🚀' },
  TRIM_CADENCE: { tone: 'amber', label: 'Trim Cadence', icon: '📉' },
  TUNE_HEALTHY: { tone: 'amber', label: 'Tune While Ahead', icon: '🎬' },
  WATCH_AND_FIX: { tone: 'amber', label: 'Watch & Fix', icon: '👀' },
  WATCH: { tone: 'grey', label: 'Watch', icon: '👀' },
  HOLD_HEALTHY: { tone: 'green', label: 'Hold (Healthy)', icon: '✅' },
  REVIEW: { tone: 'grey', label: 'Needs a Look', icon: '❓' },
  SINGLE_LENS_EVAL: { tone: 'grey', label: 'Lifecycle Only', icon: '◐' },
  SINGLE_LENS_FAT: { tone: 'grey', label: 'Fatigue Only', icon: '◑' },
};

export const TABS = [
  { id: 'data', label: 'Data', tip: 'Run both queries, upload both CSVs', gated: false },
  { id: 'explorer', label: 'Explorer', tip: 'Every show — lifecycle verdict first, with the reconciled call', gated: true },
  { id: 'queue', label: 'Action Queue', tip: 'Shows needing a decision, prioritised', gated: true },
  { id: 'deep', label: 'Deep Dive', tip: 'Full both-lens profile for one show', gated: true },
  { id: 'guide', label: 'Guideline', tip: 'How the two frameworks combine', gated: false },
];

export const UPLOAD_META = {
  eval: { metaKey: 'evalMeta', rowsKey: 'evalRows', sqlId: 'eval-sql', title: 'Evaluation CSV — lifecycle / peer verdict', sub: 'From the New Show Evaluation v1.4 query' },
  fatigue: { metaKey: 'fatMeta', rowsKey: 'fatRows', sqlId: 'fatigue-sql', title: 'Fatigue CSV — episode / creative diagnosis', sub: 'From the Content Fatigue Monitor v6 query' },
  hdc: { metaKey: 'hdcMeta', rowsKey: 'hdcRows', sqlId: 'hdc-sql', title: 'HDC CSV — high-demand content labels', sub: 'From the HDC label query (per-series L0–L6 + HDC flag)' },
};

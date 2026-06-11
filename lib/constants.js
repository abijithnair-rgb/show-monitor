// Required columns, action metadata, tabs, upload config — verbatim from the original.

export const EVAL_REQUIRED = ['language','category_id','category_name','show_type','state','show_id','show_title','launch_date','period_type','period_name','period_number','threshold_used','peer_count','show_users','language_users','show_users_contrib_pct_of_language','stop_below_users_contrib_pct','weak_below_users_contrib_pct','retain_above_users_contrib_pct','strong_above_users_contrib_pct','period_contrib_status','launch_trajectory','recent_trajectory','confidence','show_verdict','experimental_decision','decision_reason'];

export const FAT_REQUIRED = ['show_id','show_title','language','approved_dt','d0_unique_viewers','h123_unique_viewers','d0_completion_rate_pct','h123_completion_rate_pct','failure_mode','show_dominant_failure_mode','show_6day_return_rate_pct','show_avg_saturation_pct','show_action_recommendation','show_fatigue_score','show_fatigue_zone','show_remarks'];

// "one of these must be present" groups — tolerates CSVs from before the 8→10 episode-window rename
export const FAT_EITHER = [['comp_pass_rate_7eps_pct', 'comp_pass_rate_10eps_pct', 'comp_pass_rate_8eps_pct']];

// HDC label CSV (one row per series): show-level HDC supply + L0..L6 label, per publish_date.
export const HDC_REQUIRED = ['show_id', 'publish_date', 'series_id', 'HDC_threshold', 'Label'];

// Time-spent CSV (one row per show): show-level avg watch minutes per play.
export const TS_REQUIRED = ['show_id', 'avg_min_per_play'];

// Show-metadata CSV (one row per show): canonical state + BU + owner/designer/cadence.
export const META_REQUIRED = ['show_id', 'state'];

// States that mean the show should be dropped from the tool entirely.
export const DROP_STATES = new Set(['draft', 'deleted']);

// H123 views snapshot CSV (one row per series): series_id + latest CMS `views`/`starts`.
export const SNAP_REQUIRED = ['series_id'];
export const SNAP_EITHER = [['views', 'starts']];

// HDC query now covers all 5 languages; this set is used only for diagnostics.
export const HDC_LANGS = new Set(['te', 'ta', 'ml', 'kn']);

// Business-unit (BU) mapping by category_id — mirrors the bu_mapping CTE in the
// HDC query. Used to derive each show's BU from its Evaluation category_id.
export const BU_BY_CATEGORY = (() => {
  const m = {};
  const add = (ids, bu) => ids.forEach((id) => { m[id] = bu; });
  add([71, 80, 64, 67, 94, 68, 6, 79, 66, 2, 89, 5, 52, 69, 38, 17, 82, 62, 92, 18, 13, 54, 58, 61, 55, 59, 8, 57, 35, 25, 29, 40, 14, 43, 60, 21, 27, 19, 51, 53, 32, 33, 91, 109, 65, 97, 9, 106, 78, 111, 83, 75, 34, 105, 76, 95, 10, 108, 114, 115, 116, 117, 121], 'Awareness');
  add([73, 63, 16, 70, 56, 11, 50, 85, 72, 84, 39, 37, 30, 45, 81, 98, 96], 'Income');
  add([88, 77, 4, 86, 90, 49, 74, 107, 48, 46, 103, 1, 12, 42, 7, 3, 22, 23, 15, 47, 28, 44, 36, 31, 100, 101, 20, 93, 102, 41, 99, 24, 110, 104, 87, 112, 113, 118, 119, 120], 'Skill');
  return m;
})();

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
  { id: 'queue', label: 'Action Queue', tip: 'Experiments & stop candidates needing a decision', gated: true },
  { id: 'deep', label: 'Deep Dive', tip: 'Full both-lens profile for one show', gated: true },
  { id: 'guide', label: 'Guideline', tip: 'How the two frameworks combine', gated: false },
];

export const UPLOAD_META = {
  eval: { metaKey: 'evalMeta', rowsKey: 'evalRows', sqlId: 'eval-sql', title: 'Evaluation CSV — lifecycle / peer verdict', sub: 'From the New Show Evaluation v1.4 query' },
  fatigue: { metaKey: 'fatMeta', rowsKey: 'fatRows', sqlId: 'fatigue-sql', title: 'Fatigue CSV — episode / creative diagnosis', sub: 'From the Content Fatigue Monitor v6 query' },
  hdc: { metaKey: 'hdcMeta', rowsKey: 'hdcRows', sqlId: 'hdc-sql', title: 'HDC CSV — high-demand content labels', sub: 'From the HDC label query (per-series L0–L6 + HDC flag)' },
};

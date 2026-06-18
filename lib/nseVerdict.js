// New Show Experiments — pure verdict engine (no React, no DOM), so it's
// unit-testable. Judges a new-show launch experiment from its record + the
// show's live data. Reuses num/pickv (format) and effExperimentalDecision (model).
//
// A record is the KV experiment row:
//   { show_id, show_name, language, category, manager, hypothesis, pickup_date,
//     launch_date, review_date, remarks, stage, extended, review_date2,
//     manager_verdict, manager_remark }
// `show` = the joined model record (buildModel byId), may be null before the show
// appears in the data. `eps` = fatigue episode rows for the show (buildFatIndex
// .get(show_id)?.eps), may be null/empty.
import { num, pickv } from './format';
import { effExperimentalDecision } from './model';

// Terminal / interim verdict strings (single source of truth — UI + tests read these).
export const V = {
  TRACKING: null,
  LAUNCH_FAIL: 'Show launch unsuccessful',
  MIN_VIDEO_FAIL: "Experiment failed: didn't meet minimum video requirement",
  CONTINUE_5: 'Continue experiment with 5 more videos',
  REPLACE: 'Replace creator',
  REPLACE_SR: "Replace creator: Show didn't meet SR requirement",
  PROMOTE: 'Promote',
  STOP_LIFECYCLE: 'Stop experiment: lifecycle verdict STOP',
  STOP_CONTRIB: "Stop experiment: Show didn't meet contribution%",
  AWAIT_LIFECYCLE: 'Awaiting lifecycle verdict',
};

// Manager-override picks (Deepak). Blank = use system verdict.
export const MANAGER_VERDICTS = [V.REPLACE, V.CONTINUE_5, V.PROMOTE];

const SR_PASS = 80; // success-rate threshold (≥ 80% = 4/5)
const epDate = (e) => String(pickv(e, 'approved_dt', 'publish_date') || '').slice(0, 10);

// Map any verdict string to the Action-Queue candidate kind it implies.
export function queueOf(verdict) {
  if (!verdict) return null;
  if (verdict === V.PROMOTE) return 'promote';
  if (verdict === V.REPLACE || verdict === V.REPLACE_SR || verdict === V.STOP_LIFECYCLE || verdict === V.STOP_CONTRIB) return 'stop';
  return null; // CONTINUE_5 / MIN_VIDEO_FAIL / LAUNCH_FAIL / AWAIT / tracking → not a candidate
}

// Videos this show published on/after the pickup date, sorted oldest-first and
// capped at 10 (the tool never counts beyond the first 10). status: 1=success,
// 0=fail (settled), null=unsettled/excluded.
export function collectVideos(record, eps) {
  const from = String(record?.pickup_date || '').slice(0, 10);
  return (eps || [])
    .map((e) => ({ date: epDate(e), status: num(e.video_status) }))
    .filter((v) => v.date && (!from || v.date >= from))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 10);
}

// Success rate over a video slice — settled only (status 0/1); pct = pass/n.
export function srOfSlice(slice) {
  const settled = (slice || []).filter((v) => v.status === 0 || v.status === 1);
  if (!settled.length) return { pct: null, pass: 0, n: 0 };
  const pass = settled.filter((v) => v.status === 1).length;
  return { pct: Math.round((pass / settled.length) * 100), pass, n: settled.length };
}

// Lifecycle verdict (PROMOTE/STOP/CONTINUE) for an experimental show, else null.
function lifecycleOf(show) {
  if (!show || !show.life || !show.life.isExp) return null;
  const v = show.life.verdictRaw || (show.eval ? effExperimentalDecision(show.eval.cur) : null);
  if (v === 'PROMOTE' || v === 'STOP' || v === 'CONTINUE') return v;
  return null; // LOW_CONFIDENCE / INSUFFICIENT_DATA → not a firm call
}

// Main: judge one experiment. `today` = YYYY-MM-DD.
export function computeNseVerdict(record, show, eps, today) {
  const videos = collectVideos(record, eps);
  const count = videos.length;
  const firstDate = videos[0]?.date || null;
  const isExp = show?.status === 'experiment';
  const lifecycle = lifecycleOf(show);
  const extended = !!record?.extended;
  const sr1 = srOfSlice(videos.slice(0, 5));
  const sr2 = extended ? srOfSlice(videos.slice(5, 10)) : { pct: null, pass: 0, n: 0 };

  const activeReview = extended ? record?.review_date2 : record?.review_date;
  const reviewReached = !!activeReview && today >= String(activeReview).slice(0, 10);

  // Launch tag: on-time if the first video landed on/before the launch date while
  // the show was experimental; otherwise the launch date was missed.
  const launchedOnTime = isExp && firstDate != null && firstDate <= String(record?.launch_date || '').slice(0, 10);
  const launchTag = launchedOnTime ? 'launch successful' : 'launch date missed';

  const out = {
    status: 'tracking', stage: extended ? 2 : 1, count, sr1, sr2, lifecycle,
    tags: [], systemVerdict: null, effectiveVerdict: null, canExtend: false, queueCandidate: null,
  };

  let systemVerdict = null;
  let tags = [];

  if (reviewReached) {
    out.status = 'reviewed';
    // Not in experimental stage with any video by the review date → launch failed.
    if (!isExp || firstDate == null) {
      systemVerdict = V.LAUNCH_FAIL;
      tags = ['launch date missed'];
    } else if (!extended) {
      // ---- Stage 1: judge the first 5 videos ----
      if (count < 5) {
        systemVerdict = V.MIN_VIDEO_FAIL;
      } else {
        const pass = sr1.pct != null && sr1.pct >= SR_PASS;
        if (lifecycle === 'STOP') systemVerdict = V.STOP_LIFECYCLE;
        else if (lifecycle === 'PROMOTE') systemVerdict = pass ? V.PROMOTE : V.REPLACE;
        else if (lifecycle === 'CONTINUE') systemVerdict = pass ? V.CONTINUE_5 : V.REPLACE;
        else systemVerdict = V.AWAIT_LIFECYCLE;
      }
      tags = [launchTag];
    } else {
      // ---- Stage 2 (extended): judge videos 6–10 ----
      if (count < 10) {
        systemVerdict = V.MIN_VIDEO_FAIL; // no further extension once extended
      } else {
        const pass = sr2.pct != null && sr2.pct >= SR_PASS;
        if (lifecycle === 'CONTINUE') systemVerdict = V.STOP_CONTRIB; // rule 9
        else if (lifecycle === 'STOP') systemVerdict = V.STOP_LIFECYCLE;
        else if (lifecycle === 'PROMOTE') systemVerdict = pass ? V.PROMOTE : V.REPLACE_SR; // rules 10/11
        else systemVerdict = V.AWAIT_LIFECYCLE;
      }
      tags = [launchTag];
    }
  }

  // Manager override (Deepak): his verdict wins; the launch tag is preserved and an
  // "Override Verdict" tag is added.
  const mgr = record?.manager_verdict || null;
  const effectiveVerdict = mgr || systemVerdict;
  if (mgr) tags = [...tags, 'Override Verdict'];

  out.systemVerdict = systemVerdict;
  out.effectiveVerdict = effectiveVerdict;
  out.tags = tags;
  out.queueCandidate = queueOf(effectiveVerdict);
  // Extend offered only before extension, when the effective call asks for more
  // videos or stage-1 fell short of 5 (max 10 → no extend once extended).
  out.canExtend = !extended && (effectiveVerdict === V.CONTINUE_5 || systemVerdict === V.MIN_VIDEO_FAIL);
  return out;
}

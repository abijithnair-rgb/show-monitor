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
  NO_SHOW_ID: 'No show ID found',
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

// Terminal verdicts that count as a FAILED new-show experiment — the only ones
// that can be concluded → saved to history. (Promote is success → Action Queue.)
export const NSE_FAILED = new Set([
  V.MIN_VIDEO_FAIL, V.LAUNCH_FAIL, V.REPLACE, V.REPLACE_SR, V.STOP_LIFECYCLE, V.STOP_CONTRIB,
]);
export const isNseFailed = (v) => NSE_FAILED.has(v);

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
//
// "Published" comes from the UNION of two sources, deduped by series_id:
//   • HDC rows (hdcRows) — every published series by publish_date. This is the
//     authoritative "videos published" list and updates as soon as a video goes
//     live, but carries no settled success/fail outcome.
//   • Fatigue episodes (eps) — carry the settled video_status (0/1) but only
//     appear once a video's H123 window settles, so they lag a few days.
// A just-published video shows up in HDC immediately (counted, status null =
// unsettled, excluded from SR); its success/fail is filled in from fatigue later.
export function collectVideos(record, hdcRows, eps) {
  const from = String(record?.pickup_date || '').slice(0, 10);
  const sid = String(record?.show_id || '').trim();
  const byKey = new Map(); // series_id (or date) → { date, status }
  let auto = 0;
  const put = (seriesId, date, status) => {
    if (!date || (from && date < from)) return;
    const key = seriesId != null && seriesId !== '' ? `s:${seriesId}` : `d:${date}:${auto++}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { date, status }); return; }
    // Merge: prefer a settled status and the earliest date seen.
    if (prev.status == null && status != null) prev.status = status;
    if (date < prev.date) prev.date = date;
  };
  // HDC published list (only this show's rows).
  if (sid) {
    for (const r of hdcRows || []) {
      if (String(r.show_id) !== sid) continue;
      put(r.series_id, String(r.publish_date || '').slice(0, 10), num(r.video_status));
    }
  }
  // Fatigue episodes (settled outcome).
  for (const e of eps || []) {
    put(e.series_id, epDate(e), num(e.video_status));
  }
  return [...byKey.values()]
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
export function computeNseVerdict(record, show, hdcRows, eps, today) {
  const videos = collectVideos(record, hdcRows, eps);
  const count = videos.length;
  const firstDate = videos[0]?.date || null;
  const hasShowId = !!String(record?.show_id || '').trim();
  const isExp = show?.status === 'experiment';
  const lifecycle = lifecycleOf(show);
  const extended = !!record?.extended;
  const sr1 = srOfSlice(videos.slice(0, 5));
  const sr2 = extended ? srOfSlice(videos.slice(5, 10)) : { pct: null, pass: 0, n: 0 };

  const activeReview = extended ? record?.review_date2 : record?.review_date;
  const reviewReached = !!activeReview && today >= String(activeReview).slice(0, 10);

  // Launch tag: the real launch date is when the first video goes live after
  // pickup (its approved_on date). collectVideos already restricts videos to
  // dates ≥ pickup, so the first video lands on-or-after pickup by construction.
  // Launched correctly if that first video is on/before the (stage-1) review
  // date; if it only goes live after the review date, the launch was missed.
  const launchDeadline = String(record?.review_date || '').slice(0, 10);
  const launchedOnTime = isExp && firstDate != null && launchDeadline && firstDate <= launchDeadline;
  const launchTag = launchedOnTime ? 'launch successful' : 'launch date missed';

  // Did the show launch within the promised window? = a video published between
  // the pickup date and the (manually-entered) launch date, inclusive. (Distinct
  // from the review-date launch tag above; used by the Show Manager KPI.)
  const launchPromise = String(record?.launch_date || '').slice(0, 10);
  const launchedInWindow = firstDate != null && launchPromise ? firstDate <= launchPromise : false;

  const out = {
    status: 'tracking', stage: extended ? 2 : 1, count, sr1, sr2, lifecycle,
    firstVideoDate: firstDate, launchedInWindow,
    tags: [], systemVerdict: null, effectiveVerdict: null, canExtend: false, queueCandidate: null,
  };

  let systemVerdict = null;
  let tags = [];

  if (reviewReached) {
    out.status = 'reviewed';
    // A show id is mandatory by the review date — without it we can't tie the
    // experiment to any data, so it can't be judged.
    if (!hasShowId) {
      systemVerdict = V.NO_SHOW_ID;
      tags = [];
    // Not in experimental stage with any video by the review date → launch failed.
    } else if (!isExp || firstDate == null) {
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
  } else if (extended) {
    // ---- Extended, review not yet reached ----
    // After Deepak extends ("Continue experiment with 5 more videos"), keep showing
    // that line as a reminder UNTIL the next video goes live, then fall back to
    // plain Tracking. The boundary is the video count captured at extend time
    // (extend_count); legacy records (no extend_count) use the stage-1 size of 5.
    const extendCount = num(record?.extend_count) ?? 5;
    if (count <= extendCount) {
      systemVerdict = V.CONTINUE_5;
      tags = ['extended'];
    }
    // count > extendCount → a new video arrived → leave systemVerdict null (Tracking).
  }

  // Manager override (Deepak): his verdict wins; the launch tag is preserved and an
  // "Override Verdict" tag is added. EXCEPTION: a CONTINUE_5 override is NOT sticky —
  // it's the extend reminder, which the engine already derives above and which must
  // revert to Tracking once a new video arrives. So ignore a stored CONTINUE_5 here.
  const mgrRaw = record?.manager_verdict || null;
  const mgr = mgrRaw === V.CONTINUE_5 ? null : mgrRaw;
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

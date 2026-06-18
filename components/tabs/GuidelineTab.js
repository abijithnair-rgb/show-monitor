'use client';

// Metric glossary — grouped by lens. [name, formula/definition].
const METRIC_GROUPS = [
  {
    title: 'Lifecycle lens — New Show Evaluation',
    metrics: [
      ['Contribution %', "Show's current-week distinct paid users ÷ the language's current-week paid users × 100. The single most important lifecycle number — the show's share of its language audience."],
      ['Peer percentile bars', 'Stop / weak / retain / strong thresholds = the P25 / P40 / P60 / P75 of contribution % across the show\'s peer cohort (category×language if ≥5 peers, else language-only). The show is judged against where it sits on these bars.'],
      ['Recent trajectory', 'Direction of contribution % over the last 3 weeks: improving / declining / stable / volatile.'],
      ['Current users', 'Distinct paid users who watched the show in the current week (HyperLogLog sketch, ~1% error).'],
      ['Confidence', 'Tier from peer count + show users: high (≥20 peers & ≥1000 users), medium (≥10 & ≥500), else low.'],
      ['Experiment decision', 'For experimental shows: PROMOTE when it clears the retain bar, STOP when below the stop bar; production shows use decay detection instead.'],
    ],
  },
  {
    title: 'Fatigue lens — Content Fatigue Monitor',
    metrics: [
      ['Fatigue score', 'Computed over the last 7 days (videos approved today-8 to today-2), z-scored within language, weighted Comp-efficiency Δ H123 60% + Category-reach Δ 20% + 6-day return 20%. Higher = healthier (0 ≈ language avg). Zone chip: green = top 65%, yellow = next 20%, red = bottom 15% within language.'],
      ['Success rate (last 7, settled H123)', 'Of the last 7 videos with a settled success flag (approved 4–10 days ago, past the 72h H123 window + 1 buffer day), the share that succeeded. SR = status=1 ÷ (status=1 + status=0); videos whose content_performance.status is still NULL (not yet evaluated) are excluded entirely — no completion-rate fallback. Denominator capped at 7. Same definition as the Daily RCA.'],
      ['Category reach %', "Show's D0 viewers ÷ the category's paid daily-active users, averaged over the last 4 weeks. How much of the category audience each episode pulls."],
      ['6-day return rate', 'Of all show-user-days, the share where the same user returned to the show within the next 6 days (Duolingo model). The last 6 days of the window are excluded to fix right-censoring.'],
      ['Saturation', 'Avg episodes a user watched ÷ episodes published that week, averaged over 4 weeks. >100% means users binge / re-watch.'],
      ['Failure mode (Hook / Pace / Ending)', 'In the Last-10 table, read off the same cumulative retention and per-video-length floors the cells show: the checkpoint with the biggest shortfall below its floor wins — HOOK (30s), PACE (50% mark), ENDING (70% completion); if all three clear their floor → OK. The show\'s dominant mode is the most frequent across the last 10 evaluable episodes.'],
      ['Retention checkpoints (H123)', 'Hook = share of H123 viewers who watched ≥30s; Mid = share reaching the 50% mark; End = share completing ≥70% (Seekho\'s "completed" bar).'],
      ['Completion efficiency H123', 'H123 completion ÷ the per-video target completion × 100. 100% = hit target.'],
    ],
  },
  {
    title: 'Views & engagement',
    metrics: [
      ['D0 views', 'D0 ≈ H1: the final H1 `starts` from the CMS source of truth (content_metrics_run_log_v2) — the largest H1 reading just before it rolls into H12.'],
      ['H123 views', 'The latest snapshot\'s `starts` for the series from the CMS (freshest computed_at per series), used as-is regardless of snapshot tag.'],
      ['Watch hours (7d)', 'Total hours watched over the last 7 days (D-8 to D-2 IST) = Σ watchtime ÷ 3600, across all plays on Seekho main-language packages. Shows with <20 plays in the window are excluded.'],
      ['Avg time/play (7d)', 'Total watchtime ÷ play events over the last 7 days (D-8 to D-2 IST), in minutes — average stickiness per play. Shows with <20 plays excluded.'],
    ],
  },
  {
    title: 'Supply & demand — HDC labels',
    metrics: [
      ['HDC rate (7d)', 'HDC (L0) content ÷ total content the show published in the last 7 days (today-8 to today-2) × 100. HDC = a video that crossed the p90/language view cap AND its completion target within 24h.'],
      ['Most-common label (7d)', 'The label appearing on the most days over the window; ties break toward the worse (higher) label.'],
      ['Labels L0–L6', 'L0 HDC (view+CR within 24h) · L1 high reach, weak CR · L2 strong CR + scale (>p75 views) · L3 above day×language median (p50) · L4 between p25–p50 · L5 below p25 · L6 uncategorised. Lower is better.'],
      ['BU (business unit)', 'Each show\'s category mapped to one of three units — Awareness, Income, or Skill — via the category→BU mapping. Available as a filter in Explorer and Action Queue.'],
    ],
  },
  {
    title: 'Deep Dive — audience & return behaviour',
    metrics: [
      ['Daily audience by surface', 'Per-show daily chart (last 30 days) of where in the app each play started — Home, Player autoplay, Search, Category, Push, Show page, Library, New & Hot, Learning journey, AI chat, Shared, Other, Unknown. Surface is the in-app launch point, NOT an acquisition channel. Toggle between Views (5-second-qualified play events) and Unique viewers (distinct firebase_uids). Scoped to paid + organic plays on the 6 main-language apps.'],
      ['Return rate by viewer recency (NURR/CURR/RURR/SURR)', 'Weekly trend (last 7 reference days) of next-day return among PAYING users: of those who watched the show on a reference day, the share who came back the next day — split by how recently they had previously watched the SAME show. NURR = New (no watch in prior 60d) · CURR = Current (1–6d ago) · RURR = Reactivated (7–29d) · SURR = Resurrected (30–60d). The optional dashed overlay is each state\'s language median for reference.'],
    ],
  },
  {
    title: 'Daily RCA — morning content RCA',
    metrics: [
      ['Per-language HDC RCA (D-2 vs D-3)', 'The Daily RCA opens with a day-over-day HDC comparison — where we are now (D-2, the latest settled day) vs D-3 — for EVERY language: Hindi first, then a combined TTMK block (Tamil+Telugu+Malayalam+Kannada), then each of Tamil / Telugu / Malayalam / Kannada on its own. Each section is collapsible with an L0 D-2→D-3 summary chip, and has its own D-2/D-3 day pickers, executive RCA report, headline numbers, key deltas, manager breakdown, and L0 series lists. BU breakdown shows for Hindi only (regional languages have no BU split).'],
      ['Executive RCA report', 'A short, direction-aware synthesis at the top of each language section: L0 move, the key math (view-pass / CR-pass / supply / avg views / avg CR), the driving lever (must move the SAME way as L0), any counter-current lever (a drag on a rise / a cushion on a fall), p90-threshold movement, the biggest BU/manager contributors, and first-time L0 conversions.'],
      ['Report dating (D-0 / D-1 / D-2)', 'A row is dated by the RUN day (D-0, the morning it represents). Within it: paid DAU is the prior day (D-1); HDC=L0 and the L0–L6 label split are D-2 (the latest fully-settled 24h window, in hdc_report_date); success rate is the D-10→D-4 settled cohort.'],
      ['Segments', 'Computed at three levels: TOTAL (all of hi+ta+te+ml+kn), per LANGUAGE, and — for Hindi only — per BU (Awareness / Income / Skill). Plus per-SHOW triage rows for Hindi.'],
      ['HDC (L0) movement', 'Daily HDC count and L0 rate vs the trailing 7-day average (Δ in percentage points), plus the 7-day HDC contribution (L0 ÷ supply) and the L4+L5 tail share.'],
      ['Paid DAU movement', 'Daily paid DAU with signed % moves vs the 7-day average, day-over-day, and same-day-last-week, plus a verdict (REAL_DROP / soft_drop / normal / …) and the drop drivers — source (organic/push/MoEngage/WhatsApp), post-payment cohort, top falling surfaces, worst hour.'],
      ['HDC population (paid + organic)', 'Hindi HDC counts PAID users only; Telugu/Tamil/Kannada/Malayalam count ALL organic users. Organic = excludes notification/share-sourced plays. View caps: hi 1500 / te 500 / ta 330 / kn 200 / ml 200; L2 view gate >1000 (hi) else p75.'],
      ['Hindi show triage', 'Trailing-7d per-show flags vs the show\'s BU: poor L0% (hit-rate below BU), high L4+L5% (heavy low-view tail), and supply gap vs the show\'s frequency target — each with a concrete recommendation.'],
    ],
  },
  {
    title: 'Action Queue — shared ownership',
    metrics: [
      ['What gets queued', 'The Action Queue lists experiments & stop candidates, plus metric-driven reviews: shows trending at the worst view band (L5-heavy) and shows with success rate below 75% ("Review & act"). CONTINUE experiments are not listed — no action is needed.'],
      ['Pick up = start an experiment', 'In the Action Queue, "Pick up" opens a panel under the show where you choose the METRIC you\'re working on (success rate, HDC/label, hook/pace/ending fix, stop, promote), a TARGET for it (e.g. success rate ≥ 85%, decrease L5 by 30%, +1 L0 content, increase L3 by 20%, resolve hook drop-off), and optional "actions by" / "review on" dates. The current numbers are snapshotted at pickup. Owner is a self-reported name, shared across everyone (no login).'],
      ['Auto verdict (Tracking → reached / failed)', 'The tool tracks the chosen metric against the target. If the target is hit on or before the review date → "Target reached". If the review date passes unmet → "Experiment failed". Until then it shows "Tracking". The owner can override (mark reached/failed) anytime.'],
      ['Needs attention → top of queue', 'A picked-up experiment whose review date has arrived, or whose target has been reached/failed, floats to the top of the Action Queue (red banner + tint), so nothing is missed.'],
      ['Conclude → history', 'The owner concludes an experiment ("save to history"), which moves it — with its final verdict — into the show\'s experiment history. History is shown read-only at the bottom of that show\'s Deep Dive. The Deep Dive shows the active experiment as a summary only; actions are taken in the Action Queue.'],
      ['Row colour (Experiments tab)', 'A completed-and-successful experiment ("Target reached") is tinted light green; a "Experiment failed" experiment (or a tracking one whose review date has arrived) is tinted red. In-progress tracking rows stay white.'],
      ['New-show experiment candidates', 'When a New Show Experiment lands on a stop verdict (Replace creator / Stop) it appears here as a STOP candidate; a Promote verdict appears as a PROMOTE candidate. The candidate reflects the EFFECTIVE verdict, so Deepak\'s manager override replaces the candidate in place rather than creating a duplicate.'],
    ],
  },
  {
    title: 'New Show Experiments — launch lifecycle',
    metrics: [
      ['What it tracks', 'A dedicated board for brand-new shows being launched. A show manager adds a show with its launch date, review date, hypothesis and (optionally) show id; the tool then tracks it through a 5→10 video experiment, judging launch timing, success rate and lifecycle verdict automatically. Stored in a shared KV board, visible to everyone.'],
      ['Header KPIs', 'New shows picked up, Successful launches, Promoted shows, Closed shows — computed over the currently-filtered rows. Five filters scope the view: month of pickup, show manager, language, BU, and final verdict.'],
      ['Video count (cap 10)', 'Counts the videos the show publishes from the pickup date, matched automatically by show id against the data. The first 5 are stage 1; videos 6–10 are the extension. The tool only ever considers the first 10 (an 11th+ is ignored).'],
      ['Success rate (≥80% = pass)', 'Of the videos in the active stage (1–5, or 6–10 after extension), the share with a settled success outcome. ≥80% (i.e. 4/5) passes. The success rate restarts from 0 for the extension — only videos 6–10 count in stage 2.'],
      ['Launch timing', 'The launch date is entered manually as the promise. Whether it was met is judged from the first video that goes live after pickup: if that first video\'s approved date is on/between the pickup and review dates → "launch successful"; if it only goes live after the review date → "launch date missed". A promoted show still proceeds even with a "launch date missed" tag.'],
      ['Final verdict — stage 1 (5 videos)', '<5 videos by review → "Experiment failed: didn\'t meet minimum video requirement" (extendable). With 5: lifecycle STOP → Stop experiment; PROMOTE & SR≥80 → Promote; PROMOTE & SR<80 → Replace creator; CONTINUE & SR≥80 → Continue experiment with 5 more videos (extendable); CONTINUE & SR<80 → Replace creator. No show id by review → "No show ID found".'],
      ['Final verdict — stage 2 (videos 6–10)', 'After an extension, judged on videos 6–10: <10 by the new review → minimum-video fail (no further extension). With 10: CONTINUE → "Stop experiment: didn\'t meet contribution%"; PROMOTE & SR<80 → "Replace creator: didn\'t meet SR requirement"; PROMOTE & SR≥80 → Promote.'],
      ['Extension', 'Offered once when the verdict is "Continue experiment with 5 more videos" or a stage-1 minimum-video fail. Clicking it sets a new review date and continues the count from 5 toward 10 (max 10 — no second extension).'],
      ['Experiment status', 'An editable workflow status set by the show manager: Sourcing creator → Creator finalised → Merchandise released → Agreement signed → Videos ready in draft. Once the experiment is extended it auto-locks to a read-only "Experiment extended" chip.'],
      ['Show id (optional, auto-matched)', 'Optional at creation (the creator may not be finalised yet) and editable later in its own column. When exactly one show in the data shares the same name + language, the id is auto-filled. A show id is mandatory by the review date — without one the verdict is "No show ID found".'],
      ['Manager override (Deepak)', 'Deepak has a Manager-verdict column (Replace creator / Continue / Promote) plus a remark. If set, it overrides the system verdict (the row shows an "Override Verdict" tag, launch tag preserved) and replaces any Action-Queue candidate in place. Only Deepak can delete an experiment, via a Yes/No confirmation.'],
    ],
  },
  {
    title: 'Show Manager — per-POC ownership',
    metrics: [
      ['Leaderboard & drill-in', 'Lists every POC with shows-managed, active experiments, picked-up, concluded, reached/failed and experiment success %, scoped to a chosen week or month. Click a manager to drill into their detail with KPI cards and tables.'],
      ['KPI cards (per manager)', 'Shows managed, Avg HDC rate (over the period window), Avg success rate (7-day SR over the period window, ACTIVE shows only — so it tracks the week/month filter), Picked up, Concluded, Experiment success %, plus the four New-Show KPIs (picked up / successful launches / promoted / closed).'],
      ['Sub-tabs', 'Three views: Experiments (one row per experiment in the period), Shows managed (HDC rate & success rate per assigned show over the window), and New show experiments (every launch experiment this manager owns, with status, videos, lifecycle, SR, launch tag and final verdict).'],
    ],
  },
];

const ROWS = [
  ['Below peer stop bar', 'Sustained comp+retention miss (SHUTDOWN)', "🛑 <b>Confirmed Stop</b> — both lenses agree it isn't earning its slot."],
  ['Below peer stop bar', 'Hook / Pace / Ending fixable', '🎬 <b>Fixable Decline</b> — peers ahead, but cause is creative. Fix before cutting.'],
  ['Slipping / below bar', 'Over-publishing (CADENCE_DOWN)', "📉 <b>Cut Cadence</b> — demand can't absorb frequency."],
  ['Below peer stop bar', 'Drop-off healthy / no lever', '🛑 <b>Review for Stop</b> — demand problem, not craft.'],
  ['Experiment clears bar', 'Healthy', '📈 <b>Promote</b> to production.'],
  ['Experiment clears bar', 'Has a failure mode', '📈 <b>Promote + Fix</b> on the way up.'],
  ['Strong / healthy vs peers', 'Frequency headroom (CADENCE_UP)', '🚀 <b>Scale Up</b> — publish more / add sibling show.'],
  ['Healthy vs peers', 'Failure mode present', '🎬 <b>Tune While Ahead</b> — protect the lead.'],
  ['Between stop & retain', 'Any creative signal', '👀 <b>Watch & Fix</b> — re-check next week.'],
  ['Above retain bar', 'Clean drop-off', '✅ <b>Hold</b> — nothing to do.'],
];

export default function GuidelineTab() {
  return (
    <div className="prose max-w-none">
      <h2 className="text-xl font-semibold mb-2">How the two lenses combine</h2>
      <div className="card p-4 mb-4">
        <p className="text-sm text-slate-600">
          This tool joins two independent Seekho analyses on <code>show_id</code> and reconciles them into one call:
        </p>
        <ul className="text-sm text-slate-600 list-disc pl-5 mt-2 space-y-1">
          <li>
            <b>Lifecycle lens</b> (New Show Evaluation v1.4): is the show earning its slot <i>relative to peers</i> in its language/category? Peer-percentile stop/weak/retain/strong bars on contribution %; STOP/PROMOTE for experiments; decay detection for production shows.
          </li>
          <li>
            <b>Fatigue lens</b> (Content Fatigue Monitor v6): <i>why</i> is a running show tiring? Episode-grain Hook/Pace/Ending failure-mode classifier, saturation, demand density, 6-day return, fatigue score.
          </li>
        </ul>
        <p className="text-sm text-slate-600 mt-2">
          The lifecycle lens answers <b>which</b> shows need attention; the fatigue lens answers <b>why and what to do</b>. The reconciliation matrix below is the harmony.
        </p>
      </div>
      <div className="card p-4 overflow-x-auto">
        <div className="font-semibold mb-2">Reconciliation matrix</div>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th className="matrix-cell" style={{ background: '#fafafa' }}>Lifecycle lens says…</th>
              <th className="matrix-cell" style={{ background: '#fafafa' }}>Fatigue lens says…</th>
              <th className="matrix-cell" style={{ background: '#fafafa' }}>Unified recommendation</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r, i) => (
              <tr key={i}>
                <td className="matrix-cell">{r[0]}</td>
                <td className="matrix-cell">{r[1]}</td>
                <td className="matrix-cell" dangerouslySetInnerHTML={{ __html: r[2] }} />
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint mt-2">
          When the two lenses point opposite ways (e.g. weak vs peers but creatively healthy), the row is flagged <b>Conflict — judge</b> so a human makes the call.
        </p>
      </div>
      <div className="card p-4 mt-4 text-sm text-slate-600">
        <div className="font-semibold mb-1">Agreement badge</div>
        <p>
          <span className="agree-dot" style={{ background: '#065f46' }} /> <b>Aligned</b> — both lenses agree (both positive or both negative): high confidence. &nbsp;
          <span className="agree-dot" style={{ background: '#92400e' }} /> <b>Conflict</b> — lenses disagree: needs judgment. &nbsp;
          <span className="agree-dot" style={{ background: '#94a3b8' }} /> <b>One lens</b> — show matched in only one CSV.
        </p>
      </div>

      <h2 className="text-xl font-semibold mb-2 mt-6">Metric glossary — what every number means</h2>
      <p className="text-sm text-slate-500 mb-3">Every metric the tool surfaces, with how it is calculated. The same definitions appear as hover tooltips throughout the app.</p>
      {METRIC_GROUPS.map((g) => (
        <div className="card p-4 mb-4" key={g.title}>
          <div className="font-semibold mb-2">{g.title}</div>
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {g.metrics.map((m) => (
                <tr key={m[0]}>
                  <td className="matrix-cell align-top whitespace-nowrap font-medium" style={{ width: 220 }}>{m[0]}</td>
                  <td className="matrix-cell text-sm text-slate-600">{m[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

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
      ['Pick up / owner', 'Anyone can "pick up" an action in the Action Queue to claim it. The owner\'s name and the pickup date are shared across everyone using the tool (stored centrally, not per-browser), so the team can see who is working on what. Identity is a self-reported name (no login).'],
      ['Mark done / Release', 'The owner can mark a picked-up action done (kept on the board with a done stamp) or release it back to the pool for someone else.'],
      ['Since pickup', 'When an action is claimed, the show\'s key metrics (HDC rate, contribution %, success rate, users) are snapshotted. The "Since pickup" column then shows the change from that snapshot to the latest data — so the impact of the work is visible over time.'],
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

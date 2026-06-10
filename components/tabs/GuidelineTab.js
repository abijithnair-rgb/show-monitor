'use client';

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
    </div>
  );
}

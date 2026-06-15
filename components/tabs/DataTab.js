'use client';
import { useStore } from '@/store/useStore';
import { buildModel } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import CombinedUploadCard from '@/components/CombinedUploadCard';
import RcaUploadCard from '@/components/RcaUploadCard';
import SheetSyncCard from '@/components/SheetSyncCard';

export default function DataTab() {
  const evalRows = useStore((s) => s.evalRows);
  const fatRows = useStore((s) => s.fatRows);
  const hdcRows = useStore((s) => s.hdcRows);
  const data = useStore((s) => s.data());
  const hasData = useStore((s) => !!(s.evalRows || s.fatRows));
  const setTab = useStore((s) => s.setTab);
  const loadSample = useStore((s) => s.loadSample);
  const clearAll = useStore((s) => s.clearAll);

  let joinNote = null;
  if (evalRows && fatRows) {
    const m = buildModel(data);
    const both = m.filter((s) => s.source === 'both').length;
    const eo = m.filter((s) => s.source === 'eval').length;
    const fo = m.filter((s) => s.source === 'fatigue').length;
    joinNote = (
      <div className="banner banner-yellow mb-4" style={{ background: '#ecfeff', borderColor: '#67e8f9', color: '#155e75' }}>
        <span>
          🔗 Joined on <code>show_id</code>: <b>{both}</b> shows seen by both lenses · {eo} lifecycle-only · {fo} fatigue-only. The Explorer reconciles the {both} matched shows.
        </span>
        <button className="btn btn-secondary" onClick={() => setTab('explorer')}>Open Explorer →</button>
      </div>
    );
  } else if (evalRows || fatRows) {
    joinNote = (
      <div className="banner banner-amber mb-4">
        <span>Only one lens loaded. The tool works, but unified recommendations need <b>both</b> CSVs. Upload the other to unlock the harmony.</span>
      </div>
    );
  }

  let hdcNote = null;
  if (hdcRows) {
    const hi = buildHdcIndex(hdcRows);
    const shows = hi.size !== undefined ? hi.size : 0;
    hdcNote = (
      <div className="banner banner-yellow mb-4" style={{ background: '#f0fdf4', borderColor: '#86efac', color: '#166534' }}>
        <span>🏷️ HDC labels loaded: <b>{shows}</b> shows have content in the last-7-day window. Shown in Deep Dive (HDC rate + L0–L6 mix).</span>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-1">Load the data</h2>
      <p className="text-sm text-slate-500 mb-4">
        Run the single combined query in Redash, download it as one CSV, and drop it below. Everything stays in your browser (IndexedDB). It carries all four datasets — Evaluation + Fatigue power the Explorer; HDC adds supply &amp; label metrics and Time-spent adds avg watch minutes per play in Deep Dive.
      </p>
      {joinNote}
      {hdcNote}
      <SheetSyncCard />
      <CombinedUploadCard />
      <div className="mt-4">
        <RcaUploadCard />
      </div>
      <div className="flex gap-2 mt-4">
        <button className="btn btn-secondary" onClick={loadSample}>Try with sample data</button>
        {hasData && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              if (confirm('Clear all datasets?')) clearAll();
            }}
          >
            Clear all data
          </button>
        )}
      </div>
    </div>
  );
}

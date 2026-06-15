'use client';
import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import { fmtDate, timeAgo } from '@/lib/format';
import CombinedUploadCard from '@/components/CombinedUploadCard';
import RcaUploadCard from '@/components/RcaUploadCard';
import SheetSyncCard from '@/components/SheetSyncCard';

export default function DataTab() {
  const evalRows = useStore((s) => s.evalRows);
  const fatRows = useStore((s) => s.fatRows);
  const hdcRows = useStore((s) => s.hdcRows);
  const data = useStore((s) => s.data());
  const hasData = useStore((s) => !!(s.evalRows || s.fatRows));
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const syncing = useStore((s) => s.syncing);
  const setTab = useStore((s) => s.setTab);
  const loadSample = useStore((s) => s.loadSample);
  const clearAll = useStore((s) => s.clearAll);

  // Manual CSV entry is hidden by default; it auto-shows when there's no data.
  const [manualOpen, setManualOpen] = useState(false);
  const showManual = manualOpen || !hasData;

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
      <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
        <h2 className="text-xl font-semibold">Data</h2>
        <div className="text-sm text-right">
          {syncing ? (
            <span className="text-slate-500">Updating…</span>
          ) : lastSyncAt ? (
            <span className="text-slate-600">Last updated <b>{fmtDate(lastSyncAt)}</b> <span className="hint">({timeAgo(lastSyncAt)})</span></span>
          ) : (
            <span className="text-slate-400">Not updated yet</span>
          )}
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Data refreshes automatically every morning at <b>7:30 AM</b> from Redash (and whenever this page is opened). No manual upload needed.
      </p>

      {joinNote}
      {hdcNote}

      <SheetSyncCard />

      {/* Manual CSV entry — hidden unless data isn't loaded or the user opts in. */}
      {hasData && (
        <button className="btn btn-ghost mt-1" onClick={() => setManualOpen((v) => !v)}>
          {showManual ? 'Hide manual CSV upload' : 'Provide CSV manually'}
        </button>
      )}

      {showManual && (
        <div className="mt-3">
          {!hasData && (
            <p className="text-sm text-slate-500 mb-3">
              No data loaded yet — auto-sync may still be running, or you can upload the CSVs manually below.
            </p>
          )}
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
      )}
    </div>
  );
}

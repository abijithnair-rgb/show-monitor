'use client';
import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import { timeAgo, toast } from '@/lib/format';

// Auto-sync. Primary source = Redash (server proxy /api/redash; query API keys live in
// server env vars, never in the browser). Optional fallback = Google-Sheet published-CSV links.
export default function SheetSyncCard() {
  const combinedUrl = useStore((s) => s.sheetCombinedUrl);
  const rcaUrl = useStore((s) => s.sheetRcaUrl);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const syncing = useStore((s) => s.syncing);
  const syncError = useStore((s) => s.syncError);
  const remoteConfigured = useStore((s) => s.remoteConfigured);
  const setSheetUrl = useStore((s) => s.setSheetUrl);
  const syncFromSheets = useStore((s) => s.syncFromSheets);
  const syncFromRedash = useStore((s) => s.syncFromRedash);
  const checkRemote = useStore((s) => s.checkRemote);

  const [open, setOpen] = useState(false);
  useEffect(() => { checkRemote(); }, [checkRemote]);

  const redashOn = !!(remoteConfigured && (remoteConfigured.combined || remoteConfigured.rca));
  const sheetsOn = !!(combinedUrl || rcaUrl);

  async function syncNow() {
    try {
      if (redashOn) await syncFromRedash({});
      else await syncFromSheets({});
      toast('Synced');
    } catch (e) {
      toast('⚠ ' + (e.message || 'Sync failed'));
    }
  }

  return (
    <div className="card p-4 mb-4" style={{ background: '#f0fdf4', borderColor: '#86efac' }}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-semibold">🔄 Auto-sync</div>
          <div className="hint">
            {redashOn
              ? <>Connected to <b>Redash</b> ({[remoteConfigured.combined && 'combined', remoteConfigured.rca && 'RCA'].filter(Boolean).join(' + ')}). {lastSyncAt ? `Last synced ${timeAgo(lastSyncAt)}.` : 'Syncs automatically on load.'}</>
              : sheetsOn
                ? <>Using Google-Sheet links. {lastSyncAt ? `Last synced ${timeAgo(lastSyncAt)}.` : 'Not synced yet.'}</>
                : 'Not configured. Redash auto-syncs when server env vars are set; or add Google-Sheet links below.'}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {(redashOn || sheetsOn) && (
            <button className="btn btn-secondary" onClick={syncNow} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Sheet links'}</button>
        </div>
      </div>

      {syncError && <div className="banner banner-red text-[12px] mt-2"><span>⚠ {syncError}</span></div>}

      {open && (
        <div className="mt-3 space-y-3">
          <div className="hint">Optional fallback — only needed if not using Redash. Use the Sheet’s <b>Publish to web → CSV</b> link.</div>
          <label className="block text-xs text-slate-600">
            Combined CSV link
            <input
              type="url"
              value={combinedUrl}
              placeholder="https://docs.google.com/…/pub?gid=…&single=true&output=csv"
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              onChange={(e) => setSheetUrl('combined', e.target.value.trim())}
            />
          </label>
          <label className="block text-xs text-slate-600">
            Daily RCA CSV link (optional)
            <input
              type="url"
              value={rcaUrl}
              placeholder="https://docs.google.com/…/pub?gid=…&single=true&output=csv"
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              onChange={(e) => setSheetUrl('rca', e.target.value.trim())}
            />
          </label>
        </div>
      )}
    </div>
  );
}

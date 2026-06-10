'use client';
import { useStore } from '@/store/useStore';

// Stale-data banner: shown above gated tabs when the eval/fat CSVs are 8+ days old.
export default function StaleBanner() {
  const evalMeta = useStore((s) => s.evalMeta);
  const fatMeta = useStore((s) => s.fatMeta);
  const setTab = useStore((s) => s.setTab);
  const metas = [evalMeta, fatMeta].filter(Boolean);
  if (!metas.length) return null;
  const oldest = Math.max(...metas.map((m) => (Date.now() - new Date(m.uploadedAt)) / 864e5));
  if (oldest < 8) return null;
  const cls = oldest >= 15 ? 'banner-red' : 'banner-amber';
  return (
    <div className={`banner ${cls} mb-4`}>
      <span>⚠ Data is {Math.floor(oldest)} days old. Re-run the queries for a fresh picture.</span>
      <button className="btn btn-secondary" onClick={() => setTab('data')}>Go to Data tab</button>
    </div>
  );
}

'use client';
import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { normalizeSeriesRow } from '@/lib/hdcRca';
import HdcRcaSection from '@/components/HdcRcaSection';
import RegionalRca from '@/components/RegionalRca';

// Daily RCA. Day-over-day HDC view (D-2 current vs D-3) per language: Hindi first,
// then a combined TTMK block, then Tamil/Telugu/Malayalam/Kannada individually.
// The old label-led regional RCA stays at the bottom.

const TTMK = [
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'kn', name: 'Kannada' },
];

export default function RcaTab() {
  const rcaRows = useStore((s) => s.rcaRows);

  const allSeries = useMemo(
    () => (rcaRows || []).filter((r) => r.level === 'HDC_SERIES').map(normalizeSeriesRow),
    [rcaRows]
  );
  const byLang = useMemo(() => {
    const m = {};
    for (const r of allSeries) (m[r.language] = m[r.language] || []).push(r);
    return m;
  }, [allSeries]);
  const ttmkRows = useMemo(
    () => allSeries.filter((r) => TTMK.some((l) => l.code === r.language)),
    [allSeries]
  );

  return (
    <div>
      <div className="mb-3">
        <h2 className="text-xl font-semibold">Daily RCA — HDC day-over-day (D-2 vs D-3)</h2>
        <p className="text-sm text-slate-500">
          Where we are now (<b>D-2</b>) compared against <b>D-3</b>, per language. Hindi first, then a
          combined TTMK block, then each regional language. The label-led regional RCA is at the bottom.
        </p>
      </div>

      {!allSeries.length ? (
        <div className="card p-8 text-center text-slate-400 mb-4">
          No per-series HDC rows found. This view needs the day-over-day series detail (level
          <code> HDC_SERIES</code>) — re-run the Daily RCA query (qid 109927) after the merge, then sync,
          or load the sample data on the Data tab.
        </div>
      ) : (
        <>
          <HdcRcaSection
            title="Hindi HDC"
            blurb="Hindi day-over-day HDC, with BU & manager breakdowns and the L0 series list."
            rows={byLang.hi || []}
            showBU
            defaultOpen
          />
          <HdcRcaSection
            title="TTMK HDC (Tamil + Telugu + Malayalam + Kannada)"
            blurb="Combined regional HDC across the four TTMK languages, rolled up by manager."
            rows={ttmkRows}
          />
          {TTMK.map((l) => (
            <HdcRcaSection
              key={l.code}
              title={`${l.name} HDC`}
              blurb={`${l.name} day-over-day HDC, by manager and L0 series.`}
              rows={byLang[l.code] || []}
            />
          ))}
        </>
      )}

      {/* Regional-language label-led RCA */}
      <RegionalRca rcaRows={rcaRows} />
    </div>
  );
}

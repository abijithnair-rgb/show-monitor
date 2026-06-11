'use client';
import { useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { parseCombined } from '@/lib/csv';
import { fmtNum, timeAgo, toast } from '@/lib/format';
import combinedSql from '@/sql/combined.sql';

const REDASH = 'https://analytics.seekho.in/queries/new';

// Single upload that replaces the three separate CSVs. Runs sql/combined.sql
// (UNION ALL of Evaluation + Fatigue + HDC, one JSON-serialized row each),
// splits it back into the three datasets, and loads them in one shot.
export default function CombinedUploadCard() {
  const evalMeta = useStore((s) => s.evalMeta);
  const fatMeta = useStore((s) => s.fatMeta);
  const hdcMeta = useStore((s) => s.hdcMeta);
  const setCombined = useStore((s) => s.setCombined);
  const [showSql, setShowSql] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const sqlText = (combinedSql || '').trim();
  const loaded = !!(evalMeta || fatMeta || hdcMeta);

  function handleFile(file) {
    if (!file) return;
    parseCombined(file, (res) => {
      if (res.error) {
        toast('⚠ ' + res.error);
        alert('Combined CSV error:\n' + res.error);
        return;
      }
      setCombined(res);
      const parts = [];
      if (res.eval.length) parts.push(`${fmtNum(res.eval.length)} eval`);
      if (res.fat.length) parts.push(`${fmtNum(res.fat.length)} fatigue`);
      if (res.hdc.length) parts.push(`${fmtNum(res.hdc.length)} hdc`);
      toast(`Loaded ${parts.join(' · ')}`);
    });
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div>
          <div className="font-semibold">Combined CSV — all three datasets</div>
          <div className="hint">One query (Evaluation + Fatigue + HDC) → one CSV → one upload</div>
        </div>
        <span className={'chip ' + (loaded ? 'chip-green' : 'chip-light')}>{loaded ? '✓ loaded' : 'not loaded'}</span>
      </div>
      <div className="flex gap-2 my-2">
        <button
          className="btn btn-secondary"
          onClick={() => {
            navigator.clipboard.writeText(sqlText);
            toast('SQL copied');
          }}
        >
          📋 Copy SQL
        </button>
        <a className="btn btn-secondary" href={REDASH} target="_blank" rel="noopener noreferrer">Open in Redash ↗</a>
        <button className="btn btn-ghost" onClick={() => setShowSql((v) => !v)}>View SQL</button>
      </div>
      <div
        className={'dropzone' + (loaded ? ' loaded' : '') + (drag ? ' drag' : '')}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
      >
        <div className="text-sm">
          {loaded ? (
            <>
              {evalMeta && <span><b>{fmtNum(evalMeta.rowCount)}</b> eval</span>}
              {fatMeta && <span> · <b>{fmtNum(fatMeta.rowCount)}</b> fatigue</span>}
              {hdcMeta && <span> · <b>{fmtNum(hdcMeta.rowCount)}</b> hdc</span>}
              {' · '}{timeAgo((evalMeta || fatMeta || hdcMeta).uploadedAt)}
            </>
          ) : (
            'Drag & drop the combined CSV here, or click to browse'
          )}
        </div>
        {loaded && <div className="hint mt-1">Click to replace</div>}
        <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
      </div>
      {showSql && <pre className="sql mt-2">{sqlText}</pre>}
    </div>
  );
}

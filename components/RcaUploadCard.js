'use client';
import { useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { RCA_REQUIRED } from '@/lib/constants';
import { parseCSV } from '@/lib/csv';
import { fmtNum, timeAgo, toast } from '@/lib/format';
import rcaSql from '@/sql/rca.sql';

const REDASH = 'https://analytics.seekho.in/queries/new';

// Standalone daily RCA upload (its own heavy morning query, run separately from
// the combined show CSV). One row per report_date × level × segment.
export default function RcaUploadCard() {
  const meta = useStore((s) => s.rcaMeta);
  const setUpload = useStore((s) => s.setUpload);
  const [showSql, setShowSql] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const sqlText = (rcaSql || '').trim();

  function handleFile(file) {
    if (!file) return;
    parseCSV(
      file,
      RCA_REQUIRED,
      (res) => {
        if (res.error) {
          toast('⚠ ' + res.error);
          alert('Daily RCA CSV error:\n' + res.error);
          return;
        }
        setUpload('rca', res.rows, res.meta);
        toast(`Loaded ${fmtNum(res.meta.rowCount)} RCA rows`);
      },
      []
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div>
          <div className="font-semibold">Daily RCA CSV — content morning RCA</div>
          <div className="hint">HDC / DAU / success-rate movement & why · per date × level × segment</div>
        </div>
        <span className={'chip ' + (meta ? 'chip-green' : 'chip-light')}>{meta ? '✓ loaded' : 'not loaded'}</span>
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
        className={'dropzone' + (meta ? ' loaded' : '') + (drag ? ' drag' : '')}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
      >
        <div className="text-sm">
          {meta ? (
            <>
              <b>{meta.filename}</b> · {fmtNum(meta.rowCount)} rows · {meta.columnCount} cols · {timeAgo(meta.uploadedAt)}
            </>
          ) : (
            'Drag & drop the daily RCA CSV here, or click to browse'
          )}
        </div>
        {meta && <div className="hint mt-1">Click to replace</div>}
        <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
      </div>
      {showSql && <pre className="sql mt-2">{sqlText}</pre>}
    </div>
  );
}

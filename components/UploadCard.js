'use client';
import { useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { UPLOAD_META, EVAL_REQUIRED, FAT_REQUIRED, HDC_REQUIRED, FAT_EITHER } from '@/lib/constants';
import { parseCSV } from '@/lib/csv';
import { fmtNum, timeAgo, toast } from '@/lib/format';
import evalSql from '@/sql/evaluation.sql';
import fatigueSql from '@/sql/fatigue.sql';
import hdcSql from '@/sql/hdc.sql';

const SQL = { 'eval-sql': evalSql, 'fatigue-sql': fatigueSql, 'hdc-sql': hdcSql };
const REDASH = 'https://analytics.seekho.in/queries/new';

export default function UploadCard({ which }) {
  const cfg = UPLOAD_META[which];
  const meta = useStore((s) => s[cfg.metaKey]);
  const setUpload = useStore((s) => s.setUpload);
  const [showSql, setShowSql] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const sqlText = (SQL[cfg.sqlId] || '').trim();
  const required = which === 'eval' ? EVAL_REQUIRED : which === 'hdc' ? HDC_REQUIRED : FAT_REQUIRED;
  const either = which === 'fatigue' ? FAT_EITHER : [];
  const labelName = which === 'eval' ? 'Evaluation' : which === 'hdc' ? 'HDC' : 'Fatigue';

  function handleFile(file) {
    if (!file) return;
    parseCSV(
      file,
      required,
      (res) => {
        if (res.error) {
          toast('⚠ ' + res.error);
          alert(labelName + ' CSV error:\n' + res.error);
          return;
        }
        setUpload(which, res.rows, res.meta);
        toast(`Loaded ${fmtNum(res.meta.rowCount)} rows`);
      },
      either
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div>
          <div className="font-semibold">{cfg.title}</div>
          <div className="hint">{cfg.sub}</div>
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
            'Drag & drop CSV here, or click to browse'
          )}
        </div>
        {meta && <div className="hint mt-1">Click to replace</div>}
        <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
      </div>
      {showSql && <pre className="sql mt-2">{sqlText}</pre>}
    </div>
  );
}

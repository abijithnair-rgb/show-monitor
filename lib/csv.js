import Papa from 'papaparse';
import { EVAL_REQUIRED, FAT_REQUIRED, FAT_EITHER, HDC_REQUIRED } from './constants';

// Validate one dataset bucket's columns against required/either groups.
function validateCols(cols, required, eitherGroups) {
  const missing = required.filter((c) => !cols.includes(c));
  (eitherGroups || []).forEach((g) => {
    if (!g.some((c) => cols.includes(c))) missing.push(g.join(' or '));
  });
  return missing;
}

// Parse the combined CSV (columns: dataset, row_json) produced by sql/combined.sql.
// Each row carries one original row serialized as JSON, tagged eval | fatigue | hdc.
// Splits back into the three datasets and validates each non-empty bucket.
// cb({ eval, fat, hdc, meta }) or cb({ error }).
export function parseCombined(file, cb) {
  Papa.parse(file, {
    header: true,
    dynamicTyping: false, // keep row_json as a raw string for JSON.parse
    skipEmptyLines: true,
    complete: (res) => {
      const rows = res.data.filter((r) => r && r.dataset && r.row_json);
      if (!rows.length) {
        cb({ error: 'Combined CSV is empty, or missing the dataset / row_json columns.' });
        return;
      }
      const buckets = { eval: [], fatigue: [], hdc: [] };
      let badJson = 0;
      for (const r of rows) {
        const ds = String(r.dataset).trim();
        if (!(ds in buckets)) continue;
        try {
          buckets[ds].push(JSON.parse(r.row_json));
        } catch {
          badJson += 1;
        }
      }
      if (badJson) {
        cb({ error: `${badJson} row(s) had unparseable row_json. Re-export the combined CSV.` });
        return;
      }

      // Validate each non-empty bucket against its required columns.
      const checks = [
        ['Evaluation', buckets.eval, EVAL_REQUIRED, []],
        ['Fatigue', buckets.fatigue, FAT_REQUIRED, FAT_EITHER],
        ['HDC', buckets.hdc, HDC_REQUIRED, []],
      ];
      for (const [name, arr, required, either] of checks) {
        if (!arr.length) continue;
        const missing = validateCols(Object.keys(arr[0]), required, either);
        if (missing.length) {
          cb({ error: `${name} rows missing columns: ${missing.join(', ')}` });
          return;
        }
      }

      const now = new Date().toISOString();
      const mk = (arr) => arr.length ? {
        filename: file.name,
        uploadedAt: now,
        rowCount: arr.length,
        columnCount: Object.keys(arr[0]).length,
        columns: Object.keys(arr[0]),
        parseErrors: res.errors.length,
      } : null;

      cb({
        eval: buckets.eval,
        fat: buckets.fatigue,
        hdc: buckets.hdc,
        meta: {
          eval: mk(buckets.eval),
          fat: mk(buckets.fatigue),
          hdc: mk(buckets.hdc),
        },
      });
    },
  });
}

// CSV parse + validation — ported verbatim. cb({rows, meta}) or cb({error}).
export function parseCSV(file, required, cb, eitherGroups) {
  Papa.parse(file, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    complete: (res) => {
      const rows = res.data.filter((r) => Object.keys(r).length > 1);
      if (!rows.length) {
        cb({ error: 'CSV is empty. No rows found.' });
        return;
      }
      const cols = Object.keys(rows[0]);
      const missing = required.filter((c) => !cols.includes(c));
      (eitherGroups || []).forEach((g) => {
        if (!g.some((c) => cols.includes(c))) missing.push(g.join(' or '));
      });
      if (missing.length) {
        cb({ error: 'Missing required columns: ' + missing.join(', ') });
        return;
      }
      cb({
        rows,
        meta: {
          filename: file.name,
          uploadedAt: new Date().toISOString(),
          rowCount: rows.length,
          columnCount: cols.length,
          columns: cols,
          parseErrors: res.errors.length,
        },
      });
    },
  });
}

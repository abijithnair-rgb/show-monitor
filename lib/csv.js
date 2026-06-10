import Papa from 'papaparse';

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
          parseErrors: res.errors.length,
        },
      });
    },
  });
}

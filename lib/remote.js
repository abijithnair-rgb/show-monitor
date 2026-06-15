// Remote sync from Google Sheets "Publish to web → CSV" links.
// The published CSV URL always serves the sheet's latest contents and is
// CORS-friendly, so the browser can fetch it directly (no proxy/key needed).
import { parseCombined, parseCSV } from './csv';
import { RCA_REQUIRED } from './constants';

// Fetch the published CSV as text, then hand it to the existing File-based
// parsers by wrapping it in a File (so filename/meta logic is unchanged).
async function fetchCsvFile(url, name) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    // Surface the proxy's JSON error message when present.
    let msg = `Fetch failed (HTTP ${res.status}) for ${name}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const text = await res.text();
  const head = text.slice(0, 200).toLowerCase();
  // A wrong/again-login URL returns an HTML page, not CSV — catch that early.
  if (head.includes('<!doctype html') || head.includes('<html')) {
    throw new Error(`${name}: that URL returned a web page, not CSV. Use the "Publish to web → CSV" link.`);
  }
  return new File([text], name, { type: 'text/csv' });
}

// Promise wrappers around the callback-based parsers.
function parseCombinedAsync(file) {
  return new Promise((resolve, reject) => {
    parseCombined(file, (res) => (res.error ? reject(new Error(res.error)) : resolve(res)));
  });
}
function parseCsvAsync(file, required) {
  return new Promise((resolve, reject) => {
    parseCSV(file, required, (res) => (res.error ? reject(new Error(res.error)) : resolve(res)), []);
  });
}

// Pull the combined CSV (and optionally the RCA CSV) from their published URLs.
// Returns { combined, rca } where each is the parsed payload (or null if no URL).
export async function fetchSheets({ combinedUrl, rcaUrl }) {
  const out = { combined: null, rca: null };
  if (combinedUrl) {
    out.combined = await parseCombinedAsync(await fetchCsvFile(combinedUrl, 'sheet_combined.csv'));
  }
  if (rcaUrl) {
    out.rca = await parseCsvAsync(await fetchCsvFile(rcaUrl, 'sheet_rca.csv'), RCA_REQUIRED);
  }
  return out;
}

// ---- Redash proxy (server route /api/redash) ----
// Asks the server which datasets are configured (keys/URLs stay server-side).
export async function remoteStatus() {
  try {
    const res = await fetch('/api/redash', { cache: 'no-store' });
    if (!res.ok) return { combined: false, rca: false };
    const j = await res.json();
    return j.configured || { combined: false, rca: false };
  } catch {
    return { combined: false, rca: false };
  }
}

// Pull combined + RCA from Redash via the proxy and parse through the normal path.
// Each dataset is fetched independently — a failure in one (wrong query, parse error)
// does NOT block the other. Returns { combined, rca, errors: [] }.
export async function fetchRemote() {
  const status = await remoteStatus();
  const out = { combined: null, rca: null, errors: [] };
  if (status.combined) {
    try {
      out.combined = await parseCombinedAsync(await fetchCsvFile('/api/redash?which=combined', 'redash_combined.csv'));
    } catch (e) {
      out.errors.push(`Combined: ${e.message}`);
    }
  }
  if (status.rca) {
    try {
      out.rca = await parseCsvAsync(await fetchCsvFile('/api/redash?which=rca', 'redash_rca.csv'), RCA_REQUIRED);
    } catch (e) {
      out.errors.push(`RCA: ${e.message}`);
    }
  }
  return out;
}

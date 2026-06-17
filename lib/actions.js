// Client helpers for the shared action-ownership board (/api/actions).
// Thin wrappers over fetch; all writes return the updated single claim so the
// store can patch its `actions` map without a full re-fetch.

export async function fetchActions() {
  const res = await fetch('/api/actions', { cache: 'no-store' });
  if (!res.ok) return { configured: false, actions: {} };
  return res.json();
}

async function post(body) {
  const res = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (HTTP ${res.status}).`);
  return json;
}

// `claim` creates a new experiment for a show (server assigns the id). update /
// archive / release target a single experiment by its `id`.
// extra = { metric, target, action_date, review_date, note } — all optional.
export const claimAction = (show_id, by, snapshot, extra = {}) =>
  post({ op: 'claim', show_id, by, snapshot, ...extra });
export const updateClaim = (id, fields = {}) => post({ op: 'update', id, ...fields });
export const archiveAction = (id, verdict, final_snapshot, conclude_note) => post({ op: 'archive', id, verdict, final_snapshot, conclude_note });
export const releaseAction = (id) => post({ op: 'release', id });

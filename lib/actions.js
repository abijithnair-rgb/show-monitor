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

// extra = { action_date, review_date, note } — all optional.
export const claimAction = (show_id, by, snapshot, extra = {}) =>
  post({ op: 'claim', show_id, by, snapshot, ...extra });
export const updateClaim = (show_id, fields = {}) => post({ op: 'update', show_id, ...fields });
export const markDone = (show_id, by) => post({ op: 'done', show_id, by });
export const releaseAction = (show_id) => post({ op: 'release', show_id });

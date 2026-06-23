// Client helpers for the group-experiment board (/api/groups). Thin fetch
// wrappers mirroring lib/actions.js; writes return the updated single claim so
// the store can patch its `groupActions` map without a full re-fetch.

export async function fetchGroups() {
  const res = await fetch('/api/groups', { cache: 'no-store' });
  if (!res.ok) return { configured: false, groups: {}, history: {} };
  return res.json();
}

async function post(body) {
  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (HTTP ${res.status}).`);
  return json;
}

// `claim` creates a new group experiment (server assigns the id). update /
// archive / release target a single experiment by its `id`.
// extra = { metric, target, action_date, review_date, note, assigned_by }.
export const claimGroup = (scope, scope_value, by, snapshot, extra = {}) =>
  post({ op: 'claim', scope, scope_value, by, snapshot, ...extra });
export const updateGroup = (id, fields = {}) => post({ op: 'update', id, ...fields });
export const archiveGroup = (id, verdict, final_snapshot, conclude_note) => post({ op: 'archive', id, verdict, final_snapshot, conclude_note });
export const releaseGroup = (id) => post({ op: 'release', id });

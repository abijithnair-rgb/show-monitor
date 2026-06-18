// Client helpers for the New Show Experiments board (/api/nse). Thin fetch
// wrappers mirroring lib/actions.js; writes return the updated record.

export async function fetchNse() {
  const res = await fetch('/api/nse', { cache: 'no-store' });
  if (!res.ok) return { configured: false, nse: {} };
  return res.json();
}

async function post(body) {
  const res = await fetch('/api/nse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (HTTP ${res.status}).`);
  return json;
}

export const createNse = (rec) => post({ op: 'create', ...rec });
export const extendNse = (id, review_date2) => post({ op: 'extend', id, review_date2 });
export const setNseShowId = (id, show_id) => post({ op: 'set_show_id', id, show_id });
export const setNseManagerVerdict = (id, manager_verdict, manager_remark) =>
  post({ op: 'manager_verdict', id, manager_verdict, manager_remark });
export const deleteNse = (id) => post({ op: 'delete', id });

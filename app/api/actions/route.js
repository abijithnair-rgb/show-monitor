// Shared "action ownership" board — the tool's only WRITE-bearing, multi-user
// store. Backed by Vercel KV (an Upstash Redis instance) over its REST API,
// reached with plain fetch so we add no npm dependency and mirror the existing
// /api/redash pattern (keys stay server-side, never sent to the browser).
//
// Env vars (auto-added when a Vercel KV store is linked to the project):
//   KV_REST_API_URL   = https://<id>.upstash.io
//   KV_REST_API_TOKEN = <token>
// When unset the route reports { configured:false } and the UI hides the
// pick-up controls — the rest of the tool is unaffected.
//
// Storage shape: a single Redis HASH `sm:actions`, field = show_id, value =
// claim JSON. Per-field writes mean two people claiming different shows never
// clobber each other; one HGETALL reads the whole board.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = 'sm:actions';
const url = () => process.env.KV_REST_API_URL;
const token = () => process.env.KV_REST_API_TOKEN;
const configured = () => !!(url() && token());

// Run one Redis command via the Upstash REST API: POST [cmd, ...args].
async function kv(args) {
  const res = await fetch(url(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`KV ${args[0]} → HTTP ${res.status}`);
  const json = await res.json();
  return json.result;
}

// HGETALL returns a flat [field, value, field, value, ...] array; fold it into
// { show_id: claim } with each value JSON-parsed.
function foldHash(flat) {
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      const k = flat[i];
      try { out[k] = JSON.parse(flat[i + 1]); } catch { /* skip bad value */ }
    }
  }
  return out;
}

export async function GET() {
  if (!configured()) return Response.json({ configured: false, actions: {} });
  try {
    const flat = await kv(['HGETALL', KEY]);
    return Response.json({ configured: true, actions: foldHash(flat) });
  } catch (err) {
    return Response.json({ configured: true, actions: {}, error: err?.message || 'KV read failed.' }, { status: 502 });
  }
}

export async function POST(req) {
  if (!configured()) {
    return Response.json({ error: 'Shared actions are not configured on the server.' }, { status: 501 });
  }
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const op = String(body?.op || '');
  const showId = body?.show_id != null ? String(body.show_id) : '';
  if (!showId) return Response.json({ error: 'show_id is required.' }, { status: 400 });

  // Normalise a YYYY-MM-DD date input (or '' / null) to a clean string or null.
  const dateOrNull = (v) => {
    const s = v == null ? '' : String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };

  try {
    if (op === 'release') {
      await kv(['HDEL', KEY, showId]);
      return Response.json({ ok: true, show_id: showId, claim: null });
    }
    // 'update' edits dates/note on an existing claim without changing ownership.
    if (op === 'update') {
      let prev = null;
      try { const raw = await kv(['HGET', KEY, showId]); prev = raw ? JSON.parse(raw) : null; } catch { prev = null; }
      if (!prev) return Response.json({ error: 'No claim to update.' }, { status: 404 });
      const claim = {
        ...prev,
        action_date: 'action_date' in body ? dateOrNull(body.action_date) : (prev.action_date ?? null),
        review_date: 'review_date' in body ? dateOrNull(body.review_date) : (prev.review_date ?? null),
        note: body?.note != null ? String(body.note) : (prev.note || ''),
      };
      await kv(['HSET', KEY, showId, JSON.stringify(claim)]);
      return Response.json({ ok: true, show_id: showId, claim });
    }
    if (op === 'claim' || op === 'done') {
      const by = String(body?.by || '').trim();
      if (!by) return Response.json({ error: 'A name (by) is required.' }, { status: 400 });
      // For "done" preserve the original claim's by/claimed_at/snapshot/dates when present.
      let prev = null;
      try { const raw = await kv(['HGET', KEY, showId]); prev = raw ? JSON.parse(raw) : null; } catch { prev = null; }
      const now = new Date().toISOString();
      const claim = {
        show_id: showId,
        status: op === 'done' ? 'done' : 'in_progress',
        by: op === 'done' && prev?.by ? prev.by : by,
        claimed_at: prev?.claimed_at || now,
        action_date: op === 'done' ? (prev?.action_date ?? null) : dateOrNull(body?.action_date) ?? (prev?.action_date ?? null),
        review_date: op === 'done' ? (prev?.review_date ?? null) : dateOrNull(body?.review_date) ?? (prev?.review_date ?? null),
        done_at: op === 'done' ? now : null,
        note: body?.note != null ? String(body.note) : (prev?.note || ''),
        snapshot: prev?.snapshot || body?.snapshot || null,
      };
      await kv(['HSET', KEY, showId, JSON.stringify(claim)]);
      return Response.json({ ok: true, show_id: showId, claim });
    }
    return Response.json({ error: `Unknown op "${op}".` }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err?.message || 'KV write failed.' }, { status: 502 });
  }
}

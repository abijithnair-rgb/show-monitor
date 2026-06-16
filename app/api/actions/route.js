// Shared "action ownership" board — the tool's only WRITE-bearing, multi-user
// store. Backed by Vercel KV (an Upstash Redis instance) over its REST API,
// reached with plain fetch so we add no npm dependency and mirror the existing
// /api/redash pattern (keys stay server-side, never sent to the browser).
//
// Env vars (auto-added when an Upstash Redis store is linked to the project).
// The Vercel/Upstash integration may inject them under various names — and often
// with a custom prefix chosen at setup time, e.g.:
//   KV_REST_API_URL / KV_REST_API_TOKEN
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   <Prefix>_KV_REST_API_URL / <Prefix>_KV_REST_API_TOKEN   (e.g. New_experiment_storage_…)
// So we resolve by SUFFIX: the first env var whose name ends in the REST URL /
// write-token suffix wins. (Read-only tokens are ignored — we need writes.)
// When unset the route reports { configured:false } and the UI hides the
// pick-up controls — the rest of the tool is unaffected.
//
// Storage shape: a single Redis HASH `sm:actions`, field = show_id, value =
// claim JSON. Per-field writes mean two people claiming different shows never
// clobber each other; one HGETALL reads the whole board.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = 'sm:actions';      // active experiments: field = show_id
const HKEY = 'sm:history';     // concluded experiments: field = show_id → JSON array

// Find an env value by trying exact names first, then any key ending in a suffix.
function envBySuffix(exact, suffixes) {
  for (const name of exact) if (process.env[name]) return process.env[name];
  for (const [name, val] of Object.entries(process.env)) {
    if (!val) continue;
    if (suffixes.some((sfx) => name.endsWith(sfx))) return val;
  }
  return undefined;
}
const url = () => envBySuffix(
  ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'],
  ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'],
);
const token = () => envBySuffix(
  ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'],
  // write token only — never the *READ_ONLY_TOKEN.
  ['_KV_REST_API_TOKEN', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'],
);
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
  if (!configured()) return Response.json({ configured: false, actions: {}, history: {} });
  try {
    const [flat, hflat] = await Promise.all([kv(['HGETALL', KEY]), kv(['HGETALL', HKEY])]);
    return Response.json({ configured: true, actions: foldHash(flat), history: foldHash(hflat) });
  } catch (err) {
    return Response.json({ configured: true, actions: {}, history: {}, error: err?.message || 'KV read failed.' }, { status: 502 });
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

  const validOverride = (v) => (v === 'reached' || v === 'failed' ? v : null);
  const getPrev = async () => { try { const raw = await kv(['HGET', KEY, showId]); return raw ? JSON.parse(raw) : null; } catch { return null; } };

  try {
    if (op === 'release') {
      await kv(['HDEL', KEY, showId]);
      return Response.json({ ok: true, show_id: showId, claim: null });
    }
    // 'archive' concludes the active experiment: append it to per-show history
    // (with the final verdict + snapshot the client computed) and clear it from
    // the active board.
    if (op === 'archive') {
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to archive.' }, { status: 404 });
      const record = {
        ...prev,
        verdict: validOverride(body?.verdict) || (body?.verdict === 'reached' || body?.verdict === 'failed' ? body.verdict : 'failed'),
        final_snapshot: body?.final_snapshot || null,
        concluded_at: new Date().toISOString(),
      };
      let hist = [];
      try { const raw = await kv(['HGET', HKEY, showId]); hist = raw ? JSON.parse(raw) : []; } catch { hist = []; }
      if (!Array.isArray(hist)) hist = [];
      hist.unshift(record); // newest first
      await kv(['HSET', HKEY, showId, JSON.stringify(hist.slice(0, 50))]);
      await kv(['HDEL', KEY, showId]);
      return Response.json({ ok: true, show_id: showId, claim: null, archived: record });
    }
    // 'update' edits dates / note / verdict override on an existing claim.
    if (op === 'update') {
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to update.' }, { status: 404 });
      const claim = {
        ...prev,
        action_date: 'action_date' in body ? dateOrNull(body.action_date) : (prev.action_date ?? null),
        review_date: 'review_date' in body ? dateOrNull(body.review_date) : (prev.review_date ?? null),
        note: body?.note != null ? String(body.note) : (prev.note || ''),
        verdict_override: 'verdict_override' in body ? validOverride(body.verdict_override) : (prev.verdict_override ?? null),
      };
      await kv(['HSET', KEY, showId, JSON.stringify(claim)]);
      return Response.json({ ok: true, show_id: showId, claim });
    }
    if (op === 'claim') {
      const by = String(body?.by || '').trim();
      if (!by) return Response.json({ error: 'A name (by) is required.' }, { status: 400 });
      const now = new Date().toISOString();
      const claim = {
        show_id: showId,
        by,
        claimed_at: now,
        metric: body?.metric != null ? String(body.metric) : null,
        target: body?.target ?? null,
        action_date: dateOrNull(body?.action_date),
        review_date: dateOrNull(body?.review_date),
        note: body?.note != null ? String(body.note) : '',
        snapshot: body?.snapshot || null,
        verdict_override: null,
      };
      await kv(['HSET', KEY, showId, JSON.stringify(claim)]);
      return Response.json({ ok: true, show_id: showId, claim });
    }
    return Response.json({ error: `Unknown op "${op}".` }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err?.message || 'KV write failed.' }, { status: 502 });
  }
}

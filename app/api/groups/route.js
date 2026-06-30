// Group-experiment board (scope = language / BU / POC) — a WRITE-bearing,
// multi-user store, mirroring /api/actions exactly (env-suffix resolution, plain
// fetch, no deps; keys stay server-side). A group experiment carries a scope +
// scope_value instead of a show_id; the aggregate verdict is computed client-side.
//
// Storage: HASH `sm:groups` (active, field = experiment id → claim JSON) +
// HASH `sm:groups_history` (concluded, field = "scope:scope_value" → JSON array).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = 'sm:groups';
const HKEY = 'sm:groups_history';

// 'category' is the composite scope (category, optionally bifurcated by language
// as "<category>::<lang>"); its scope_value is opaque to the server.
const VALID_SCOPES = new Set(['language', 'bu', 'category', 'poc']);

function newId(scope, value) {
  return `${scope}:${value}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

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
  ['_KV_REST_API_TOKEN', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'],
);
const configured = () => !!(url() && token());

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

function foldHash(flat) {
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      const field = flat[i];
      try {
        const claim = JSON.parse(flat[i + 1]);
        if (claim && claim.id == null) claim.id = field;
        out[claim?.id ?? field] = claim;
      } catch { /* skip bad value */ }
    }
  }
  return out;
}

export async function GET() {
  if (!configured()) return Response.json({ configured: false, groups: {}, history: {} });
  try {
    const [flat, hflat] = await Promise.all([kv(['HGETALL', KEY]), kv(['HGETALL', HKEY])]);
    return Response.json({ configured: true, groups: foldHash(flat), history: foldHash(hflat) });
  } catch (err) {
    return Response.json({ configured: true, groups: {}, history: {}, error: err?.message || 'KV read failed.' }, { status: 502 });
  }
}

export async function POST(req) {
  if (!configured()) {
    return Response.json({ error: 'Group experiments are not configured on the server.' }, { status: 501 });
  }
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const op = String(body?.op || '');
  const expId = body?.id != null ? String(body.id) : '';

  const dateOrNull = (v) => {
    const s = v == null ? '' : String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  const validOverride = (v) => (v === 'reached' || v === 'failed' ? v : null);
  const CONSTRAINT_METRICS = new Set(['supply', 'success_rate', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
  const cleanConstraints = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((c) => c && CONSTRAINT_METRICS.has(c.metric) && (c.op === 'gte' || c.op === 'lte') && Number.isFinite(Number(c.value)) && Number(c.value) >= 0)
    .map((c) => ({ metric: c.metric, op: c.op, value: Math.max(0, Math.round(Number(c.value))) }));
  const getPrev = async () => { try { const raw = await kv(['HGET', KEY, expId]); return raw ? JSON.parse(raw) : null; } catch { return null; } };

  try {
    if (op === 'release') {
      if (!expId) return Response.json({ error: 'id is required.' }, { status: 400 });
      await kv(['HDEL', KEY, expId]);
      return Response.json({ ok: true, id: expId, claim: null });
    }
    if (op === 'archive') {
      if (!expId) return Response.json({ error: 'id is required.' }, { status: 400 });
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to archive.' }, { status: 404 });
      const record = {
        ...prev,
        id: prev.id ?? expId,
        verdict: validOverride(body?.verdict) || (body?.verdict === 'reached' || body?.verdict === 'failed' ? body.verdict : 'failed'),
        final_snapshot: body?.final_snapshot || null,
        conclude_note: body?.conclude_note != null ? String(body.conclude_note) : null,
        concluded_at: new Date().toISOString(),
      };
      const hid = `${prev.scope}:${prev.scope_value}`; // history keyed by scope
      let hist = [];
      try { const raw = await kv(['HGET', HKEY, hid]); hist = raw ? JSON.parse(raw) : []; } catch { hist = []; }
      if (!Array.isArray(hist)) hist = [];
      hist.unshift(record);
      await kv(['HSET', HKEY, hid, JSON.stringify(hist.slice(0, 50))]);
      await kv(['HDEL', KEY, expId]);
      return Response.json({ ok: true, id: expId, claim: null, archived: record });
    }
    if (op === 'update') {
      if (!expId) return Response.json({ error: 'id is required.' }, { status: 400 });
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to update.' }, { status: 404 });
      const claim = {
        ...prev,
        id: prev.id ?? expId,
        action_date: 'action_date' in body ? dateOrNull(body.action_date) : (prev.action_date ?? null),
        review_date: 'review_date' in body ? dateOrNull(body.review_date) : (prev.review_date ?? null),
        note: body?.note != null ? String(body.note) : (prev.note || ''),
        verdict_override: 'verdict_override' in body ? validOverride(body.verdict_override) : (prev.verdict_override ?? null),
      };
      await kv(['HSET', KEY, claim.id, JSON.stringify(claim)]);
      return Response.json({ ok: true, id: claim.id, claim });
    }
    if (op === 'claim') {
      const scope = String(body?.scope || '');
      const scopeValue = String(body?.scope_value || '').trim();
      if (!VALID_SCOPES.has(scope)) return Response.json({ error: 'A valid scope (language/bu/category/poc) is required.' }, { status: 400 });
      if (!scopeValue) return Response.json({ error: 'scope_value is required.' }, { status: 400 });
      const by = String(body?.by || '').trim();
      if (!by) return Response.json({ error: 'A name (by) is required.' }, { status: 400 });
      if (!body?.target) return Response.json({ error: 'A target is required.' }, { status: 400 });
      const now = new Date().toISOString();
      const id = newId(scope, scopeValue);
      const claim = {
        id,
        scope,
        scope_value: scopeValue,
        by,
        assigned_by: body?.assigned_by ? String(body.assigned_by) : null,
        claimed_at: now,
        metric: body?.metric != null ? String(body.metric) : null,
        target: body.target,
        action_date: dateOrNull(body?.action_date),
        review_date: dateOrNull(body?.review_date),
        note: body?.note != null ? String(body.note) : '',
        snapshot: body?.snapshot || null,
        constraints: cleanConstraints(body?.constraints),
        verdict_override: null,
      };
      await kv(['HSET', KEY, id, JSON.stringify(claim)]);
      return Response.json({ ok: true, id, claim });
    }
    return Response.json({ error: `Unknown op "${op}".` }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err?.message || 'KV write failed.' }, { status: 502 });
  }
}

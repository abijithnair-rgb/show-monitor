// New Show Experiments board — a WRITE-bearing, multi-user store for new-show
// launch experiments. Backed by Vercel KV (Upstash Redis) over its REST API,
// mirroring /api/actions exactly (env-suffix resolution, plain fetch, no deps).
//
// Storage: a single Redis HASH `sm:nse`, field = experiment id, value = record
// JSON. launch_date / review_date are write-once (set at create, never edited).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = 'sm:nse';            // active board: field = experiment id
const NHKEY = 'sm:nse_history';  // concluded (failed) experiments: field = id

function newId(showId) {
  return `${showId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
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
        const rec = JSON.parse(flat[i + 1]);
        if (rec && rec.id == null) rec.id = field;
        out[rec?.id ?? field] = rec;
      } catch { /* skip bad value */ }
    }
  }
  return out;
}

const dateOrNull = (v) => {
  const s = v == null ? '' : String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const str = (v) => (v == null ? '' : String(v));
const validManagerVerdict = (v) => {
  const ok = ['Replace creator', 'Continue experiment with 5 more videos', 'Promote'];
  return ok.includes(v) ? v : null;
};
// Manual experiment-status options the show manager can set. "Experiment extended"
// is auto-applied on extension and is NOT a selectable option here.
const EXP_STATUSES = ['Sourcing creator', 'Creator finalised', 'Merchandise released', 'Agreement signed', 'Videos ready in draft'];
const validExpStatus = (v) => (EXP_STATUSES.includes(v) ? v : '');
// Failed/closed verdicts — the only ones that may be concluded → history.
// (Mirrors NSE_FAILED in lib/nseVerdict.js; kept inline so the route stays dep-free.)
const FAILED_VERDICTS = new Set([
  "Experiment failed: didn't meet minimum video requirement",
  'Show launch unsuccessful',
  'Replace creator',
  "Replace creator: Show didn't meet SR requirement",
  'Stop experiment: lifecycle verdict STOP',
  "Stop experiment: Show didn't meet contribution%",
]);

export async function GET() {
  if (!configured()) return Response.json({ configured: false, nse: {}, nseHistory: {} });
  try {
    const [flat, hflat] = await Promise.all([kv(['HGETALL', KEY]), kv(['HGETALL', NHKEY])]);
    return Response.json({ configured: true, nse: foldHash(flat), nseHistory: foldHash(hflat) });
  } catch (err) {
    return Response.json({ configured: true, nse: {}, nseHistory: {}, error: err?.message || 'KV read failed.' }, { status: 502 });
  }
}

export async function POST(req) {
  if (!configured()) {
    return Response.json({ error: 'New Show Experiments storage is not configured on the server.' }, { status: 501 });
  }
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const op = String(body?.op || '');
  const id = body?.id != null ? String(body.id) : '';
  const getPrev = async () => { try { const raw = await kv(['HGET', KEY, id]); return raw ? JSON.parse(raw) : null; } catch { return null; } };

  try {
    if (op === 'create') {
      // show_id is OPTIONAL at creation — the creator may not be finalised yet.
      // It can be filled later (manually or auto-matched) and is mandatory by the
      // review date (enforced in the verdict engine).
      const showId = str(body?.show_id).trim();
      const newRecId = newId(showId || 'new');
      const now = new Date().toISOString();
      const rec = {
        id: newRecId,
        show_id: showId,
        show_name: str(body?.show_name).trim(),
        language: str(body?.language).trim(),
        category: str(body?.category).trim(),
        manager: str(body?.manager).trim(),
        hypothesis: str(body?.hypothesis),
        pickup_date: dateOrNull(body?.pickup_date) || now.slice(0, 10),
        launch_date: dateOrNull(body?.launch_date),   // write-once
        review_date: dateOrNull(body?.review_date),   // write-once
        remarks: str(body?.remarks),
        exp_status: validExpStatus(str(body?.exp_status).trim()),
        created_by: str(body?.created_by).trim(),
        created_at: now,
        stage: 1,
        extended: false,
        review_date2: null,
        manager_verdict: null,
        manager_remark: '',
      };
      await kv(['HSET', KEY, newRecId, JSON.stringify(rec)]);
      return Response.json({ ok: true, id: newRecId, record: rec });
    }

    if (op === 'extend') {
      if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to extend.' }, { status: 404 });
      if (prev.extended) return Response.json({ error: 'Experiment already extended (max 10 videos).' }, { status: 409 });
      const rd2 = dateOrNull(body?.review_date2);
      if (!rd2) return Response.json({ error: 'A valid new review date is required.' }, { status: 400 });
      // Capture the video count at extend time so the "Continue…" reminder reverts
      // to Tracking once a NEW video arrives. Clear any sticky manager_verdict.
      const extendCount = Number.isFinite(Number(body?.extend_count)) ? Math.max(0, Math.round(Number(body.extend_count))) : 5;
      const rec = {
        ...prev, id: prev.id ?? id, stage: 2, extended: true, review_date2: rd2,
        extend_count: extendCount, manager_verdict: null,
        manager_remark: body?.manager_remark != null ? str(body.manager_remark) : (prev.manager_remark || ''),
      };
      await kv(['HSET', KEY, rec.id, JSON.stringify(rec)]);
      return Response.json({ ok: true, id: rec.id, record: rec });
    }

    // 'conclude' archives a FAILED experiment to history and removes it from the
    // active board. Successful (Promote) rows flow to the Action Queue instead.
    if (op === 'conclude') {
      if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to conclude.' }, { status: 404 });
      const finalVerdict = str(body?.final_verdict);
      if (!FAILED_VERDICTS.has(finalVerdict)) {
        return Response.json({ error: 'Only failed experiments can be concluded to history.' }, { status: 400 });
      }
      const record = {
        ...prev, id: prev.id ?? id,
        final_verdict: finalVerdict,
        concluded_at: new Date().toISOString(),
        concluded_by: str(body?.concluded_by).trim(),
      };
      await kv(['HSET', NHKEY, record.id, JSON.stringify(record)]);
      await kv(['HDEL', KEY, record.id]);
      return Response.json({ ok: true, id: record.id, record: null, concluded: record });
    }

    if (op === 'manager_verdict') {
      if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to update.' }, { status: 404 });
      const rec = {
        ...prev,
        id: prev.id ?? id,
        manager_verdict: 'manager_verdict' in body ? validManagerVerdict(body.manager_verdict) : (prev.manager_verdict ?? null),
        manager_remark: body?.manager_remark != null ? str(body.manager_remark) : (prev.manager_remark || ''),
      };
      await kv(['HSET', KEY, rec.id, JSON.stringify(rec)]);
      return Response.json({ ok: true, id: rec.id, record: rec });
    }

    // 'set_show_id' fills/updates the show_id later (manual edit or auto-match).
    if (op === 'set_show_id') {
      if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to update.' }, { status: 404 });
      const rec = { ...prev, id: prev.id ?? id, show_id: str(body?.show_id).trim() };
      await kv(['HSET', KEY, rec.id, JSON.stringify(rec)]);
      return Response.json({ ok: true, id: rec.id, record: rec });
    }

    // 'set_status' updates the manual experiment-workflow status (show manager).
    if (op === 'set_status') {
      if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
      const prev = await getPrev();
      if (!prev) return Response.json({ error: 'No experiment to update.' }, { status: 404 });
      const rec = { ...prev, id: prev.id ?? id, exp_status: validExpStatus(str(body?.exp_status).trim()) };
      await kv(['HSET', KEY, rec.id, JSON.stringify(rec)]);
      return Response.json({ ok: true, id: rec.id, record: rec });
    }

    if (op === 'delete') {
      if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
      await kv(['HDEL', KEY, id]);
      return Response.json({ ok: true, id, record: null });
    }

    return Response.json({ error: `Unknown op "${op}".` }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err?.message || 'KV write failed.' }, { status: 502 });
  }
}

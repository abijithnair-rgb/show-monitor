import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_ROUNDS = 8;
const MAX_TOOL_CHARS = 6000;

// ---------------------------------------------------------------------------
// Lean analyst prompt — the bot pulls real numbers via tools, never from a
// frozen snapshot. Report formatting is intentionally light (per product call).
// ---------------------------------------------------------------------------
function systemPrompt(dataset) {
  const cat = (dataset?.catalog || [])
    .map((c) => `• ${c.name} (${c.rows} rows)${c.truncated ? ' [omitted: too large]' : ''}: ${c.description}\n   columns: ${c.columns.join(', ')}`)
    .join('\n');
  const meta = dataset?.meta || {};
  const defs = (meta.definitions || []).map((d) => '• ' + d).join('\n');
  return `You are "Show Master", the analytics assistant for Seekho's Show Monitor dashboard. It joins two analyses per show — New Show Evaluation (peer-relative lifecycle verdict) and the Content Fatigue Monitor (episode-grain creative diagnosis) — and reconciles them into one recommendation per show, plus HDC (high-demand-content) labels.

HOW YOU WORK — USE THE TOOLS, ALWAYS:
You do NOT have a pre-baked summary. You have live query tools over the dashboard's actual datasets. For ANY factual claim, counts, rankings, a show's metrics, breakdowns, or movements — CALL A TOOL and read the real number before you answer. Never guess, never invent shows / numbers / columns. If the data doesn't contain something, say so plainly.
• list_datasets — see every dataset, its columns, and definitions.
• get_show — full reconciled record(s) for a show by id or name.
• query_dataset — filter/sort/project rows of any dataset (use "shows" for the computed per-show table).
• aggregate — group + compute count/sum/avg/min/max/median (e.g. avg success rate by category).
Prefer the "shows" table for show-level questions (its numbers match the UI). Drop to the raw datasets (fatigue / hdc / rca) for episode-grain or daily-movement questions. Chain tools as needed: look a show up, then query its episodes.

SCOPE (ask once, briefly, at the start of a new chat — unless the user already asked a clear question):
Which language do they work on — Hindi (hi), Telugu (te), Tamil (ta), Malayalam (ml), Kannada (kn)? If Hindi, also which BU (Awareness / Income / Skill). For te/ta/ml/kn they own the whole language (BU is not a meaningful split there). They can skip for a whole-product view. Once known, default answers to that slice and filter your tool queries accordingly.

RULES:
• Call tools SILENTLY. Do not narrate what you are about to do, do not think out loud, and do not write commentary between tool calls (no "let me check…", "interesting…", "let me widen…"). The user sees only your text, so write nothing until you have gathered what you need, then output just the finished answer.
• Lead with the answer, then the why and a concrete next step. Be concise unless a deep analysis is requested.
• INACTIVE shows are already stopped — never recommend stopping them again; only surface one as a possible RELAUNCH if its numbers are genuinely strong.
• The chat renders PLAIN TEXT — no markdown. No "#", no "**bold**", no tables. Use short labelled lines, a trailing colon or UPPERCASE for labels, and "•" bullets.
• Cite the exact figures the tools return; don't re-derive percentages in your head.

DATA WINDOW: episodes ${meta.episode_window || 'n/a'}; HDC labels ${meta.hdc_window || 'n/a'}. Languages: ${(meta.languages || []).join(', ') || 'n/a'}. Treat the loaded data as the latest week — if asked for "this week", state the window once and proceed; never refuse for lack of a date filter.

DATASET CATALOG:
${cat || '(no datasets loaded)'}

DEFINITIONS:
${defs}`;
}

// ---- tiny numeric coercion (matches lib/format.num behaviour) ----
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[, ]/g, ''));
  return isNaN(n) ? null : n;
};
const looseEq = (a, b) => {
  if (a == null) return b == null || b === '';
  const na = num(a), nb = num(b);
  if (na != null && nb != null) return na === nb;
  return String(a).toLowerCase() === String(b).toLowerCase();
};

function matchWhere(row, where) {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([col, cond]) => {
    const v = row[col];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const { op, value } = cond;
      switch (op) {
        case 'eq': return looseEq(v, value);
        case 'ne': return !looseEq(v, value);
        case 'gt': return num(v) != null && num(v) > Number(value);
        case 'gte': return num(v) != null && num(v) >= Number(value);
        case 'lt': return num(v) != null && num(v) < Number(value);
        case 'lte': return num(v) != null && num(v) <= Number(value);
        case 'contains': return String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
        case 'in': return Array.isArray(value) && value.some((x) => looseEq(v, x));
        default: return false;
      }
    }
    return looseEq(v, cond);
  });
}

function pickArray(dataset, name) {
  if (name === 'shows') return dataset.shows || [];
  return (dataset.datasets || {})[name] || null;
}

function project(row, columns) {
  if (!Array.isArray(columns) || !columns.length) return row;
  const out = {};
  columns.forEach((c) => { out[c] = row[c]; });
  return out;
}

const AGG = {
  count: (vals) => vals.length,
  sum: (vals) => vals.reduce((a, b) => a + b, 0),
  avg: (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null),
  min: (vals) => (vals.length ? Math.min(...vals) : null),
  max: (vals) => (vals.length ? Math.max(...vals) : null),
  median: (vals) => { if (!vals.length) return null; const s = [...vals].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; },
};

function runTool(name, input, dataset) {
  try {
    if (name === 'list_datasets') {
      return JSON.stringify({ catalog: dataset.catalog || [], meta: dataset.meta || {} });
    }
    if (name === 'get_show') {
      const q = String(input?.query ?? '').trim().toLowerCase();
      if (!q) return 'error: provide a "query" (show id or name).';
      const shows = dataset.shows || [];
      let hits = shows.filter((s) => String(s.id).toLowerCase() === q);
      if (!hits.length) hits = shows.filter((s) => String(s.title || '').toLowerCase().includes(q));
      if (!hits.length) return `No show matches "${input.query}". Try list_datasets or query_dataset on "shows".`;
      return JSON.stringify({ matched: hits.length, shows: hits.slice(0, 5) });
    }
    if (name === 'query_dataset') {
      const arr = pickArray(dataset, input?.dataset);
      if (!arr) return `error: unknown dataset "${input?.dataset}". Use list_datasets to see valid names.`;
      let rows = arr.filter((r) => matchWhere(r, input?.where));
      const matched = rows.length;
      if (input?.sort?.column) {
        const { column, dir } = input.sort;
        rows = [...rows].sort((a, b) => {
          const na = num(a[column]), nb = num(b[column]);
          let c;
          if (na != null && nb != null) c = na - nb;
          else c = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
          return dir === 'desc' ? -c : c;
        });
      }
      const limit = Math.min(Math.max(1, input?.limit || 50), 100);
      const out = rows.slice(0, limit).map((r) => project(r, input?.columns));
      return JSON.stringify({ matched, returned: out.length, rows: out });
    }
    if (name === 'aggregate') {
      const arr = pickArray(dataset, input?.dataset);
      if (!arr) return `error: unknown dataset "${input?.dataset}". Use list_datasets to see valid names.`;
      const rows = arr.filter((r) => matchWhere(r, input?.where));
      const groupBy = Array.isArray(input?.group_by) ? input.group_by : [];
      const metrics = Array.isArray(input?.metrics) ? input.metrics : [{ fn: 'count' }];
      const groups = new Map();
      rows.forEach((r) => {
        const key = groupBy.length ? groupBy.map((g) => String(r[g] ?? '∅')).join(' | ') : '(all)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });
      const result = [...groups.entries()].map(([key, grpRows]) => {
        const o = {};
        groupBy.forEach((g, i) => { o[g] = key.split(' | ')[i]; });
        o.n = grpRows.length;
        metrics.forEach((m) => {
          const fn = AGG[m.fn] || AGG.count;
          if (m.fn === 'count' || !m.column) { o[m.column ? `${m.fn}_${m.column}` : 'count'] = fn(grpRows); return; }
          const vals = grpRows.map((r) => num(r[m.column])).filter((v) => v != null);
          let v = fn(vals);
          if (v != null && !Number.isInteger(v)) v = Math.round(v * 100) / 100;
          o[`${m.fn}_${m.column}`] = v;
        });
        return o;
      });
      return JSON.stringify({ groups: result.length, result });
    }
    return `error: unknown tool "${name}".`;
  } catch (e) {
    return `error running ${name}: ${e?.message || 'unknown error'}`;
  }
}

function cap(str) {
  if (typeof str !== 'string') str = String(str);
  return str.length > MAX_TOOL_CHARS ? str.slice(0, MAX_TOOL_CHARS) + '\n…(result truncated; narrow your query)' : str;
}

const TOOLS = [
  {
    name: 'list_datasets',
    description: 'List every available dataset with its row count, columns, and definitions. Call this first if unsure what data exists.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_show',
    description: 'Fetch the full reconciled per-show record(s) (lifecycle + fatigue + HDC + time-spent) by show id or title substring. Returns up to 5 matches.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Show id or part of the title (case-insensitive).' } }, required: ['query'] },
  },
  {
    name: 'query_dataset',
    description: 'Filter, sort and project rows of a dataset. Use dataset "shows" for the computed per-show table, or a raw dataset name (e.g. "hdc", "fatigue", "rca") for episode/daily grain. Returns up to 100 rows plus the total matched count.',
    input_schema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset name (e.g. "shows", "hdc", "fatigue", "rca", "timespent", "langsr").' },
        where: { type: 'object', description: 'AND-combined filters. Each key is a column; value is either an exact match, or { "op": "eq|ne|gt|gte|lt|lte|contains|in", "value": ... }.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Optional columns to return (projection).' },
        sort: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 100).' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'aggregate',
    description: 'Group rows and compute aggregate metrics. e.g. average sr_pct by category on the "shows" dataset, or sum of supply by language.',
    input_schema: {
      type: 'object',
      properties: {
        dataset: { type: 'string' },
        where: { type: 'object', description: 'Same filter shape as query_dataset.' },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Columns to group by (omit for a single overall group).' },
        metrics: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max', 'median'] } }, required: ['fn'] } },
      },
      required: ['dataset', 'metrics'],
    },
  },
];

export async function POST(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart.' }, { status: 500 });
  }

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return Response.json({ error: 'Body must include a non-empty messages array.' }, { status: 400 });
  }
  const dataset = body && typeof body.dataset === 'object' && body.dataset ? body.dataset : null;
  const hasData = dataset && !dataset.empty;

  const system = hasData
    ? systemPrompt(dataset)
    : `You are "Show Master", the Show Monitor analytics assistant. ${dataset?.message || 'No data is currently loaded in the dashboard.'} Tell the user to upload the Evaluation and Fatigue CSVs on the Data tab (or click "Try with sample data"), then ask again.`;

  const client = new Anthropic({ apiKey });
  const apiMessages = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));

  // Probe the first turn up front so auth/request errors surface as JSON (proper
  // status) before we commit to a 200 streaming response.
  const baseParams = { model: MODEL, max_tokens: 4096, system };
  let firstStream;
  try {
    firstStream = await client.messages.create({ ...baseParams, messages: apiMessages, stream: true, ...(hasData ? { tools: TOOLS } : {}) });
  } catch (err) {
    const msg = err?.error?.error?.message || err?.message || 'Unknown error calling Claude.';
    return Response.json({ error: msg }, { status: err?.status || 500 });
  }

  const encoder = new TextEncoder();
  const convo = [...apiMessages];

  // Consume one streamed turn: assemble the assistant content blocks
  // (text + tool_use) and the stop reason. Text is buffered (NOT forwarded) so
  // that "thinking out loud" preamble in tool-use turns is never shown — only
  // the final, tool-free answer is emitted to the client.
  async function consumeTurn(stream) {
    const blockState = new Map();
    let stopReason = null;
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        blockState.set(ev.index, cb.type === 'tool_use'
          ? { type: 'tool_use', id: cb.id, name: cb.name, json: '' }
          : { type: 'text', text: '' });
      } else if (ev.type === 'content_block_delta') {
        const st = blockState.get(ev.index);
        if (!st) continue;
        if (ev.delta.type === 'text_delta') st.text += ev.delta.text;
        else if (ev.delta.type === 'input_json_delta') st.json += ev.delta.partial_json;
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      }
    }
    const content = [...blockState.entries()].sort((a, b) => a[0] - b[0]).map(([, st]) => {
      if (st.type === 'tool_use') {
        let parsed = {};
        try { parsed = st.json ? JSON.parse(st.json) : {}; } catch { parsed = {}; }
        return { type: 'tool_use', id: st.id, name: st.name, input: parsed };
      }
      return { type: 'text', text: st.text };
    });
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { content, stopReason, text };
  }

  const textStream = new ReadableStream({
    async start(controller) {
      try {
        let stream = firstStream;
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const { content, stopReason, text } = await consumeTurn(stream);

          // Final (tool-free) turn → emit the answer and stop.
          if (stopReason !== 'tool_use' || !hasData) {
            if (text) controller.enqueue(encoder.encode(text));
            break;
          }

          // Run the requested tools, append assistant turn + tool results, loop.
          convo.push({ role: 'assistant', content });
          const toolResults = [];
          for (const b of content) {
            if (b.type !== 'tool_use') continue;
            const out = cap(runTool(b.name, b.input, dataset));
            const matched = (() => { try { return JSON.parse(out).matched ?? JSON.parse(out).groups ?? JSON.parse(out).returned; } catch { return undefined; } })();
            console.log(`[chat tool] ${b.name}(${JSON.stringify(b.input).slice(0, 160)}) → ${matched != null ? matched + ' rows' : out.slice(0, 60)}`);
            toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: out });
          }
          convo.push({ role: 'user', content: toolResults });

          const lastRound = round === MAX_ROUNDS - 2;
          stream = await client.messages.create({
            ...baseParams, messages: convo, stream: true,
            ...(lastRound ? {} : { tools: TOOLS }),
          });
        }
      } catch (err) {
        controller.enqueue(encoder.encode('\n\n⚠ ' + (err?.message || 'stream interrupted')));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(textStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

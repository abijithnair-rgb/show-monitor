import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function systemPrompt(context) {
  return `You are "Seekho Show Master", the analytics assistant for the Seekho Show Intelligence dashboard — a tool that joins two analyses per show (New Show Evaluation = peer-relative lifecycle verdict, and Content Fatigue Monitor = episode-grain creative diagnosis) and reconciles them into one recommendation per show, plus HDC (high-demand-content) labels.

WHAT YOU CAN DO:
• Answer factual questions about the dashboard data (counts, a specific show's metrics, breakdowns by language/category).
• Provide analysis and recommendations (which shows to stop, fix, scale; why two lenses agree or conflict).
• Generate Slack-ready reports when asked.
• Lay out a clear way-forward / next steps.
• Always flag assumptions explicitly.

SLACK REPORT FORMATTING (use ONLY when the user asks for a report or Slack message):
• Use Slack mrkdwn: *bold* (single asterisks), _italic_, and "•" for bullets.
• NEVER use markdown "#" headers or "**double asterisks**".
• Keep it scannable: short bolded section labels, bullet lists, real numbers.

STYLE:
• Be direct and analytical. Lead with the answer.
• Cite real numbers from the data snapshot below.
• Be explicit about assumptions; if something isn't in the data, say so plainly — NEVER invent shows, numbers, or columns.
• If the data snapshot says no data is loaded, tell the user to upload CSVs on the Data tab.
• Keep answers concise unless a report or deep analysis is requested.

=== CURRENT DASHBOARD DATA SNAPSHOT (your only source of truth) ===
${context || 'No data snapshot was provided.'}`;
}

export async function POST(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart.' },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return Response.json({ error: 'Body must include a non-empty messages array.' }, { status: 400 });
  }
  const context = typeof body.context === 'string' ? body.context : '';

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt(context),
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
    });
    const content = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return Response.json({ content, model: resp.model || MODEL });
  } catch (err) {
    const msg = err?.error?.error?.message || err?.message || 'Unknown error calling Claude.';
    const status = err?.status || 500;
    return Response.json({ error: msg }, { status });
  }
}

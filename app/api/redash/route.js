// Server-side proxy to Redash query results. The full results URLs (which embed
// the per-query API keys) live ONLY in server env vars — never sent to the browser,
// never in the repo. This also sidesteps CORS since the fetch is server→Redash.
//
// Env vars (set in Vercel → Settings → Environment Variables and in .env.local):
//   REDASH_COMBINED_URL = https://analytics.seekho.in/api/queries/<id>/results.csv?api_key=...
//   REDASH_RCA_URL      = https://analytics.seekho.in/api/queries/<id>/results.csv?api_key=...
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const URLS = {
  combined: () => process.env.REDASH_COMBINED_URL,
  rca: () => process.env.REDASH_RCA_URL,
};

export async function GET(req) {
  const which = new URL(req.url).searchParams.get('which');

  // No `which` → report which datasets are configured (so the UI can show status
  // without ever exposing the URLs/keys).
  if (!which) {
    return Response.json({
      configured: { combined: !!URLS.combined(), rca: !!URLS.rca() },
    });
  }

  const getUrl = URLS[which];
  if (!getUrl) return Response.json({ error: `Unknown dataset "${which}".` }, { status: 400 });
  const url = getUrl();
  if (!url) return Response.json({ error: `${which} is not configured on the server.` }, { status: 501 });

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      return Response.json({ error: `Redash returned HTTP ${res.status} for ${which}.` }, { status: 502 });
    }
    const text = await res.text();
    return new Response(text, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return Response.json({ error: err?.message || `Failed to reach Redash for ${which}.` }, { status: 502 });
  }
}

# Seekho Show Intelligence

A web app that joins two Seekho analyses on `show_id` and reconciles them into **one recommendation per show**:

- **Lifecycle lens** — New Show Evaluation v1.4 (peer-relative contribution % vs stop/weak/retain/strong bars; STOP/PROMOTE for experiments; decay detection).
- **Fatigue lens** — Content Fatigue Monitor v6 (episode-grain Hook/Pace/Ending failure modes, success rate, 6-day return, category reach, fatigue score).
- **HDC** — High-Demand-Content labels (L0–L6) per show over the last 7 days.

Everything runs **client-side in the browser** — CSVs are parsed locally and stored in IndexedDB. No backend, no data leaves the machine.

## Tabs
- **Data** — copy the embedded SQL, run in Redash, upload the resulting CSVs (Evaluation + Fatigue + optional HDC). "Try with sample data" to explore without running queries.
- **Explorer** — every show: lifecycle verdict, HDC rate + most-common label (7d), fatigue lens, unified call. Filter by language/category/status/recommendation; hero counts re-scope to filters.
- **Action Queue** — only shows needing a decision, grouped and prioritised.
- **Deep Dive** — full both-lens profile for one show: KPIs, contribution-vs-global 4-week chart, retention + failure-mode charts, HDC L0–L6 mix, last-10-episode table.
- **Guideline** — the reconciliation matrix.

## Local development
```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (what Vercel runs)
npm start        # serve the production build
```

Requires Node 18+.

## Project structure
```
sql/                 # the three BigQuery queries (edit these as plain .sql files)
  evaluation.sql     # New Show Evaluation v1.4
  fatigue.sql        # Content Fatigue Monitor v6
  hdc.sql            # HDC label query
lib/                 # pure logic, no React
  format.js          # formatters, LANG_NAMES, date helpers
  constants.js       # required columns, ACTION_META, TABS, UPLOAD_META
  idb.js             # IndexedDB get/set/del
  csv.js             # PapaParse + column validation
  model.js           # join + reconciliation engine (lifeClass/fatClass/reconcile/buildModel)
  hdc.js             # HDC 7-day index + diagnostics
  metrics.js         # successRate, globalBars, langAvgFat
  tips.js            # metric tooltip text
  sample.js          # built-in sample dataset
  render.js          # HTML-string builders for table rows / cards / KPIs
store/useStore.js    # zustand store (data, filters, persistence, hydrate)
components/          # Nav, Tooltip, FilterBar, Banners, UploadCard
  tabs/              # DataTab, ExplorerTab, ActionQueueTab, DeepDiveTab, GuidelineTab
  deepdive/charts.js # react-chartjs-2 charts (trajectory / retention / failure)
app/                 # Next.js App Router (layout.js, page.js, globals.css)
```

The `.sql` files are imported as raw strings (see `next.config.mjs`), so they stay editable and are shown via the **Copy SQL / View SQL** buttons on the Data tab.

## Editing the SQL
Just edit the files in `sql/`. They are the single source of truth for the Copy-SQL buttons. After changing a query, re-run it in Redash and re-upload the CSV.

## Deploy to Vercel
1. Push this folder to a GitHub repo:
   ```bash
   git add -A
   git commit -m "Initial commit"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. Go to https://vercel.com → **Add New → Project** → import the GitHub repo.
3. Framework preset auto-detects **Next.js**. No env vars needed. Click **Deploy**.
4. Every push to `main` redeploys automatically; share the `*.vercel.app` URL with the team.

## Notes
- All metrics are computed client-side from the uploaded CSVs, so they reflect whatever data you load. Re-run the queries to refresh.
- The HDC and fatigue 7-day windows are anchored to the current date (today−8 … today−2).
- No authentication — anyone with the URL can use the tool (it has no data of its own until a CSV is uploaded in their browser).

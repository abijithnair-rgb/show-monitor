'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex, buildAudienceIndex, buildRetentionIndex, retentionLangMedian, RETENTION_STATES } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import { ACTION_META } from '@/lib/constants';
import { esc, fmtDate, LANG_NAMES, num } from '@/lib/format';
import { actionChip, agreeBadge, kpiGrid, hdcCard, contribBar, last10Table } from '@/lib/render';
import { TrajectoryChart, RetentionChart, FailureDoughnut, AudienceSourceChart, RetentionTrendChart } from '@/components/deepdive/charts';
import PickupPanel from '@/components/PickupPanel';
import { snapshotFromData, metricLabel, VERDICT_META, canAssign } from '@/lib/ownership';

export default function DeepDiveTab() {
  const data = useStore((s) => s.data());
  const deepLang = useStore((s) => s.deepLang);
  const deepDiveId = useStore((s) => s.deepDiveId);
  const setDeepLang = useStore((s) => s.setDeepLang);
  const setDeepDiveId = useStore((s) => s.setDeepDiveId);

  const model = useMemo(() => buildModel(data), [data]);
  const langs = [...new Set(model.map((s) => s.language).filter(Boolean))].sort();
  const inLang = deepLang ? model.filter((s) => s.language === deepLang) : model;
  const shows = [...inLang].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const s = model.find((x) => x.id === deepDiveId);

  function onLangChange(v) {
    setDeepLang(v);
    if (v && deepDiveId) {
      const cur = model.find((x) => x.id === deepDiveId);
      if (!cur || cur.language !== v) setDeepDiveId(null);
    }
  }

  const bar = (
    <div className="flex flex-wrap gap-3 items-end mb-4">
      <label className="text-xs text-slate-500 flex flex-col gap-1">
        Language
        <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={deepLang} onChange={(e) => onLangChange(e.target.value)}>
          <option value="">All languages</option>
          {langs.map((l) => (
            <option key={l} value={l}>{LANG_NAMES[l] || l}</option>
          ))}
        </select>
      </label>
      <label className="text-xs text-slate-500 flex flex-col gap-1 flex-1 max-w-md">
        Show
        <select className="border border-slate-300 rounded-md px-3 py-2 text-sm" value={deepDiveId || ''} onChange={(e) => setDeepDiveId(e.target.value || null)}>
          <option value="">Choose a show…</option>
          {shows.map((sh) => (
            <option key={sh.id} value={sh.id}>{sh.title}</option>
          ))}
        </select>
      </label>
    </div>
  );

  return (
    <div>
      <h2 className="text-xl font-semibold mb-3">Deep Dive</h2>
      {bar}
      {!s ? (
        <div className="card p-8 text-center text-slate-400">Pick a language, then a show, to see both lenses side by side.</div>
      ) : (
        <DeepBody s={s} data={data} />
      )}
    </div>
  );
}

function DeepBody({ s, data }) {
  const ev = s.eval ? s.eval.cur : null;
  const fobj = data.fatRows ? buildFatIndex(data.fatRows).get(s.id) : null;
  const fs = fobj ? fobj.show : null;
  const hdc = data.hdcRows ? buildHdcIndex(data.hdcRows).get(s.id) : null;
  const recTone = { red: 'banner-red', amber: 'banner-amber', green: 'banner-yellow', grey: 'banner-yellow' }[(ACTION_META[s.rec.key] || {}).tone] || 'banner-yellow';

  // Experiment launcher state (top-right "Run experiment" / "Assign"). Shared
  // between the header button and the form rendered below the banner.
  const actionsConfigured = useStore((st) => st.actionsConfigured);
  const claim = useStore((st) => st.actions[String(s.id)]);
  const userName = useStore((st) => st.userName);
  const [expOpen, setExpOpen] = useState(null); // null | 'pickup' | 'assign'
  const canLaunch = actionsConfigured && !claim;

  const headHtml = `<span class="text-2xl font-bold">${esc(s.title)}</span>
    <span class="chip chip-blue">${esc(LANG_NAMES[s.language] || s.language)}</span>
    ${s.category ? `<span class="chip chip-purple">${esc(s.category)}</span>` : ''}
    ${s.life.isExp ? '<span class="chip chip-amber">experiment</span>' : ''}
    <span class="hint">#${esc(s.id)} · ${ev ? 'launched ' + fmtDate(ev.launch_date) : ''}</span>`;

  const bannerHtml = `<div class="flex items-center gap-2 mb-1">${actionChip(s.rec.key)} ${agreeBadge(s.rec.agreement)}</div>
    <div class="font-semibold">${esc(s.rec.headline)}</div>
    <div class="text-sm mt-1" style="opacity:.9">${esc(s.rec.detail)}</div>
    <div class="text-xs mt-2" style="opacity:.8">Lifecycle lens: <b>${esc(s.life.label)}</b>${s.life.decaying ? ' (declining)' : ''} &nbsp;·&nbsp; Fatigue lens: <b>${esc(s.fat.label)}</b>${s.fat.mode && s.fat.mode !== 'OK' ? ` (dominant: ${esc(s.fat.mode)})` : ''}</div>`;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap" dangerouslySetInnerHTML={{ __html: headHtml }} />
        {canLaunch && !expOpen && (
          <div className="flex gap-2 shrink-0">
            <button className="btn btn-primary text-sm" onClick={() => setExpOpen('pickup')}>Run experiment</button>
            {canAssign(userName) && <button className="btn btn-ghost text-sm" onClick={() => setExpOpen('assign')}>Assign</button>}
          </div>
        )}
      </div>
      <div className={`banner ${recTone} mb-4`} style={{ display: 'block' }} dangerouslySetInnerHTML={{ __html: bannerHtml }} />

      {/* Active experiment summary (read-only) or the launched form. */}
      {actionsConfigured && claim && (
        <div className="mb-4">
          <div className="font-semibold mb-2 text-sm">Active experiment</div>
          <PickupPanel s={s} snapshotNow={snapshotFromData(s, data)} readOnly />
        </div>
      )}
      {canLaunch && expOpen && (
        <div className="mb-4">
          <div className="font-semibold mb-2 text-sm">{expOpen === 'assign' ? 'Assign experiment' : 'Run experiment'}</div>
          <PickupPanel s={s} snapshotNow={snapshotFromData(s, data)} assign={expOpen === 'assign'} onClose={() => setExpOpen(null)} />
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4" dangerouslySetInnerHTML={{ __html: kpiGrid(s, data, fobj) }} />

      {data.hdcRows && <div dangerouslySetInnerHTML={{ __html: hdcCard(hdc, s, data.hdcRows) }} />}

      <div className="card p-4 mb-4">
        <div className="font-semibold mb-1">Lifecycle lens (New Show Evaluation) — contribution vs Global</div>
        {ev ? (
          <>
            <div dangerouslySetInnerHTML={{ __html: contribBar(ev, data.evalRows) }} />
            <div className="mt-3" style={{ position: 'relative', height: 220 }}>
              <TrajectoryChart ev={ev} evalRows={data.evalRows} />
            </div>
            <div className="hint mt-1">Contribution % over the last 4 calendar weeks vs the global {LANG_NAMES[s.language] || s.language} thresholds. Green dashed = retain bar, red dashed = stop bar.</div>
            <div className="text-sm text-slate-600 mt-2">{ev.decision_reason || ''}</div>
          </>
        ) : (
          <div className="text-sm text-slate-400">No lifecycle data for this show.</div>
        )}
      </div>

      <div className="card p-4 mb-4">
        <div className="font-semibold mb-2">Fatigue lens (Content Fatigue Monitor) — retention &amp; failure mode</div>
        {fs ? (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <div style={{ position: 'relative', height: 200 }}>
                  <RetentionChart fs={fs} />
                </div>
                <div className="hint text-center mt-1">Cumulative retention — % of starters still watching (Hook @30s / Mid @50% / End @70%)</div>
              </div>
              <div>
                <div style={{ position: 'relative', height: 200 }}>
                  <FailureDoughnut fs={fs} />
                </div>
                <div className="hint text-center mt-1">Failure-mode mix (last 10 ep)</div>
              </div>
            </div>
            <div className="text-sm text-slate-600 mt-3">{fs.show_remarks || ''}</div>
          </>
        ) : (
          <div className="text-sm text-slate-400">No fatigue/episode data for this show.</div>
        )}
      </div>

      {data.audRows && <AudienceCard aud={buildAudienceIndex(data.audRows).get(s.id)} />}

      {data.retRows && <RetentionCard retRows={data.retRows} showId={s.id} language={s.language} data={data} />}

      {fobj && fobj.eps && fobj.eps.length > 0 && <div dangerouslySetInnerHTML={{ __html: last10Table(fobj.eps) }} />}

      <ExperimentHistory s={s} />
    </div>
  );
}

// Concluded experiments — shown at the BOTTOM of the deep dive (history, not top).
function ExperimentHistory({ s }) {
  const configured = useStore((st) => st.actionsConfigured);
  const history = useStore((st) => st.history[String(s.id)]) || [];
  if (!configured || history.length === 0) return null;
  return (
    <div className="card p-4 mb-4">
      <div className="font-semibold mb-2">Experiment history ({history.length})</div>
      <div className="flex flex-col gap-2">
        {history.map((h, i) => {
          const vm = VERDICT_META[h.verdict] || VERDICT_META.failed;
          return (
            <div key={i} className="flex items-center gap-2 flex-wrap text-xs border-b border-slate-100 pb-2 last:border-0 last:pb-0">
              <span className={'chip ' + vm.chip}>{vm.label}</span>
              <span className="chip chip-purple">{metricLabel(h.metric)}</span>
              <span className="text-slate-600 font-medium">{h.by}</span>
              <span className="hint">
                {fmtDate(h.claimed_at)}{h.review_date ? ` → review ${fmtDate(h.review_date)}` : ''}{h.concluded_at ? ` · concluded ${fmtDate(h.concluded_at)}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AudienceCard({ aud }) {
  const [metric, setMetric] = useState('views');
  const hasData = aud && aud.dates && aud.dates.length > 0;
  return (
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="font-semibold">Daily audience by surface — where in the app plays started (last 30 days)</div>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs">
          {[['views', 'Views'], ['users', 'Unique viewers']].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setMetric(k)}
              className={`px-3 py-1.5 ${metric === k ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {hasData ? (
        <>
          <div style={{ position: 'relative', height: 260 }}>
            <AudienceSourceChart aud={aud} metric={metric} />
          </div>
          <div className="hint mt-1">
            {metric === 'views' ? 'Daily 5-second-qualified plays' : 'Daily unique viewers'} by in-app launch surface (Home, Player autoplay, Search, Category, Push, …). Surface = where in the app the play started, not the acquisition channel.
          </div>
        </>
      ) : (
        <div className="text-sm text-slate-400">No daily audience data for this show.</div>
      )}
    </div>
  );
}

function RetentionCard({ retRows, showId, language, data }) {
  const [showMedian, setShowMedian] = useState(false);
  const retIdx = useMemo(() => buildRetentionIndex(retRows), [retRows]);
  const ret = retIdx.get(showId);
  const hasData = ret && ret.dates && ret.dates.length > 0;
  // show_ids in the same language (for the reference median), from the model.
  const langShowIds = useMemo(() => {
    if (!hasData) return [];
    return buildModel(data).filter((x) => x.language === language).map((x) => x.id);
  }, [data, language, hasData]);
  const median = useMemo(
    () => (showMedian && hasData ? retentionLangMedian(retIdx, langShowIds, ret.dates) : null),
    [showMedian, hasData, retIdx, langShowIds, ret]
  );
  return (
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="font-semibold">Next-day return rate by viewer recency — weekly trend (paying users)</div>
        <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" checked={showMedian} onChange={(e) => setShowMedian(e.target.checked)} />
          {LANG_NAMES[language] || language} median (dashed)
        </label>
      </div>
      {hasData ? (
        <>
          <div style={{ position: 'relative', height: 280 }}>
            <RetentionTrendChart ret={ret} median={median} />
          </div>
          <div className="hint mt-1">
            Daily over the last week: of the paying users who watched this show on each reference day, the share who returned the next day — split by recency: New (no watch in 60d), Current (1–6d), Reactivated (7–29d), Resurrected (30–60d). Toggle adds the {LANG_NAMES[language] || language} median per state as dashed reference lines.
          </div>
        </>
      ) : (
        <div className="text-sm text-slate-400">No return-rate data for this show.</div>
      )}
    </div>
  );
}

'use client';
import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import { ACTION_META } from '@/lib/constants';
import { esc, fmtDate, LANG_NAMES } from '@/lib/format';
import { actionChip, agreeBadge, kpiGrid, hdcCard, contribBar, last10Table } from '@/lib/render';
import { TrajectoryChart, RetentionChart, FailureDoughnut } from '@/components/deepdive/charts';

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
      <div className="flex items-center gap-2 flex-wrap mb-2" dangerouslySetInnerHTML={{ __html: headHtml }} />
      <div className={`banner ${recTone} mb-4`} style={{ display: 'block' }} dangerouslySetInnerHTML={{ __html: bannerHtml }} />
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
                <div className="hint text-center mt-1">H123 retention checkpoints (Hook / Mid / End)</div>
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

      {fobj && fobj.eps && fobj.eps.length > 0 && <div dangerouslySetInnerHTML={{ __html: last10Table(fobj.eps) }} />}
    </div>
  );
}

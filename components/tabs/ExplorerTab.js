'use client';
import { useEffect, useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel, buildFatIndex } from '@/lib/model';
import { buildHdcIndex } from '@/lib/hdc';
import { successRate } from '@/lib/metrics';
import { ACTION_META } from '@/lib/constants';
import { LANG_NAMES } from '@/lib/format';
import { METRIC_TIPS } from '@/lib/tips';
import { explorerRow } from '@/lib/render';
import FilterBar, { applyFilters, sortModel } from '@/components/FilterBar';

const HERO = [
  { tone: 'red', label: 'Stop / urgent', color: '#991b1b', tipKey: 'hero_red' },
  { tone: 'amber', label: 'Fix / adjust', color: '#92400e', tipKey: 'hero_amber' },
  { tone: 'green', label: 'Promote / scale / hold', color: '#065f46', tipKey: 'hero_green' },
  { tone: 'grey', label: 'Watch / single-lens', color: '#475569', tipKey: 'hero_grey' },
];

export default function ExplorerTab() {
  const data = useStore((s) => s.data());
  const filters = useStore((s) => s.filters);
  const search = useStore((s) => s.search);
  const sortBy = useStore((s) => s.sortBy);
  const setSortBy = useStore((s) => s.setSortBy);
  const setFilter = useStore((s) => s.setFilter);
  const openDeepDive = useStore((s) => s.openDeepDive);
  const hdcRows = data.hdcRows;

  // Explorer has no agreement filter — clear any lingering value on entry.
  useEffect(() => {
    if (filters.agreement) setFilter('agreement', '');
  }, [filters.agreement, setFilter]);

  const model = useMemo(() => buildModel(data), [data]);

  // Per-show label-band share (% of last-7d videos in that band) and success
  // rate %, for the Explorer threshold filter (e.g. "L0 ≥ 40%", "SR ≤ 70%").
  const hdcIdx = useMemo(() => (hdcRows ? buildHdcIndex(hdcRows) : null), [hdcRows]);
  const fatIdx = useMemo(() => (data.fatRows ? buildFatIndex(data.fatRows) : null), [data.fatRows]);
  const metricPct = (s, band) => {
    if (band === 'SR') {
      const eps = fatIdx?.get(s.id)?.eps;
      const sr = eps ? successRate(eps, data.fatRows) : null;
      return sr && sr.n ? sr.pct : null;
    }
    const hd = hdcIdx?.get(s.id);
    if (!hd || !hd.supply) return null;
    return Math.round(((hd.labels[band] || 0) / hd.supply) * 1000) / 10; // one decimal
  };

  let filtered = applyFilters(model, { ...filters, agreement: '' }, search);
  // Apply the label/SR threshold filter (only when a band and X are set).
  const mBand = filters.metricBand;
  const mX = filters.metricX === '' || filters.metricX == null ? null : Number(filters.metricX);
  if (mBand && mX != null && !Number.isNaN(mX)) {
    filtered = filtered.filter((s) => {
      const v = metricPct(s, mBand);
      if (v == null) return false; // no data → can't satisfy a threshold
      return filters.metricOp === 'lte' ? v <= mX : v >= mX;
    });
  }
  const counts = { red: 0, amber: 0, green: 0, grey: 0 };
  filtered.forEach((s) => counts[(ACTION_META[s.rec.key] || { tone: 'grey' }).tone]++);
  const sorted = sortModel(filtered, sortBy);
  const scopeLabel = filters.language ? LANG_NAMES[filters.language] || filters.language : 'all languages';
  const bodyHtml = sorted.map((s) => explorerRow(s, hdcRows)).join('');

  const tipAttr = (key) => (METRIC_TIPS[key] ? { 'data-tip': METRIC_TIPS[key] } : {});

  function onBodyClick(e) {
    const tr = e.target.closest('[data-show]');
    if (tr) openDeepDive(tr.getAttribute('data-show'));
  }

  const colspan = hdcRows ? 8 : 6;

  return (
    <div>
      <div className="flex items-end justify-between mb-3">
        <div>
          <h2 className="text-xl font-semibold">Explorer</h2>
          <p className="text-sm text-slate-500">
            New Show Evaluation verdict leads; the Fatigue Monitor explains the cause and the reconciled call. Showing <b>{filtered.length}</b> of {model.length} shows · scope: <b>{scopeLabel}</b>.
          </p>
        </div>
      </div>
      <div className="flex gap-3 mb-4">
        {HERO.map((h) => (
          <div key={h.tone} className="kpi flex-1 cursor-pointer" {...tipAttr(h.tipKey)} onClick={() => setFilter('action', '')}>
            <div className="lbl">{h.label}</div>
            <div className="val" style={{ color: h.color }}>{counts[h.tone]}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        <FilterBar model={model} hideAgreement />
        {hdcRows && (
          <div className="flex gap-2 items-end">
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              Label / SR %
              <select
                className="border border-slate-300 rounded-md px-2 py-1 text-sm text-slate-800"
                value={filters.metricBand}
                onChange={(e) => setFilter('metricBand', e.target.value)}
              >
                <option value="">Off</option>
                {['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map((b) => <option key={b} value={b}>{b}</option>)}
                <option value="SR">SR</option>
              </select>
            </label>
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              &nbsp;
              <select
                className="border border-slate-300 rounded-md px-2 py-1 text-sm text-slate-800"
                value={filters.metricOp}
                onChange={(e) => setFilter('metricOp', e.target.value)}
              >
                <option value="gte">≥</option>
                <option value="lte">≤</option>
              </select>
            </label>
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              &nbsp;
              <input
                type="number" min="0" max="100" step="1" inputMode="numeric"
                placeholder="%"
                className="border border-slate-300 rounded-md px-2 py-1 text-sm w-20"
                value={filters.metricX}
                onChange={(e) => setFilter('metricX', e.target.value)}
              />
            </label>
          </div>
        )}
        <label className="text-xs text-slate-500 flex flex-col gap-1 ml-auto">
          Sort
          <select className="border border-slate-300 rounded-md px-2 py-1 text-sm" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="lifecycle">Lifecycle health (weakest first)</option>
            <option value="priority">Unified priority</option>
            <option value="contrib">Contribution % (high→low)</option>
            <option value="users">Audience size (high→low)</option>
          </select>
        </label>
      </div>
      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th {...tipAttr('show')}>Show</th>
              <th {...tipAttr('status')}>Status</th>
              <th {...tipAttr('lifecycle')} style={{ minWidth: 240 }}>Lifecycle verdict (NSE)</th>
              <th {...tipAttr('users')}>Users</th>
              {hdcRows && <th {...tipAttr('hdc_rate')}>HDC rate (7d)</th>}
              {hdcRows && <th {...tipAttr('mode_label')}>Most-common label (7d)</th>}
              <th {...tipAttr('fatigue_lens')}>Fatigue lens</th>
              <th {...tipAttr('unified')}>Unified call</th>
            </tr>
          </thead>
          {sorted.length ? (
            <tbody onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          ) : (
            <tbody>
              <tr>
                <td colSpan={colspan} className="text-center text-slate-400 py-6">No shows match.</td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

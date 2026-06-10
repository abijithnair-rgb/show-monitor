'use client';
import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { buildModel } from '@/lib/model';
import { ACTION_META } from '@/lib/constants';
import { actionChip, queueCard } from '@/lib/render';
import FilterBar, { applyFilters, sortModel } from '@/components/FilterBar';

const ACTIONABLE = new Set(['CONFIRMED_STOP', 'STOP_REVIEW', 'OVERPUBLISHING', 'FIXABLE_DECLINE', 'PROMOTE', 'PROMOTE_WITH_FIX', 'SCALE', 'TRIM_CADENCE', 'TUNE_HEALTHY', 'WATCH_AND_FIX']);

export default function ActionQueueTab() {
  const data = useStore((s) => s.data());
  const filters = useStore((s) => s.filters);
  const search = useStore((s) => s.search);
  const sortBy = useStore((s) => s.sortBy);
  const openDeepDive = useStore((s) => s.openDeepDive);

  const model = useMemo(() => buildModel(data), [data]);
  let m = applyFilters(model, filters, search).filter((s) => ACTIONABLE.has(s.rec.key));
  m = sortModel(m, sortBy);
  const groups = {};
  m.forEach((s) => {
    (groups[s.rec.key] = groups[s.rec.key] || []).push(s);
  });
  const orderKeys = Object.keys(ACTION_META).filter((k) => ACTIONABLE.has(k) && groups[k]);

  function onClick(e) {
    const card = e.target.closest('[data-show]');
    if (card) openDeepDive(card.getAttribute('data-show'));
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-1">Action Queue</h2>
      <p className="text-sm text-slate-500 mb-3">Shows that need a decision, most urgent first. Hold/healthy and single-lens shows live in the Explorer.</p>
      <FilterBar model={model} />
      {orderKeys.length ? (
        <div onClick={onClick}>
          {orderKeys.map((k) => (
            <div className="mb-5" key={k}>
              <div className="flex items-center gap-2 mb-2" dangerouslySetInnerHTML={{ __html: `${actionChip(k)}<span class="text-sm text-slate-500">${groups[k].length} show${groups[k].length > 1 ? 's' : ''}</span>` }} />
              <div className="grid md:grid-cols-2 gap-3" dangerouslySetInnerHTML={{ __html: groups[k].map((s) => queueCard(s)).join('') }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="card p-8 text-center text-slate-400">Nothing needs action right now. ✓</div>
      )}
    </div>
  );
}

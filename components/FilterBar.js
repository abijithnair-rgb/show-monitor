'use client';
import { useStore } from '@/store/useStore';
import { ACTION_META } from '@/lib/constants';
import { LANG_NAMES } from '@/lib/format';

// Controlled filter bar (real React inputs — no innerHTML, so search keeps focus).
export default function FilterBar({ model, hideAgreement }) {
  const filters = useStore((s) => s.filters);
  const search = useStore((s) => s.search);
  const setFilter = useStore((s) => s.setFilter);
  const setSearch = useStore((s) => s.setSearch);
  const resetFilters = useStore((s) => s.resetFilters);

  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  const langs = uniq(model.map((s) => s.language));
  const cats = uniq(model.map((s) => s.category));
  const bus = uniq(model.map((s) => s.bu));
  const stats = uniq(model.map((s) => s.status));
  const acts = [...new Set(model.map((s) => s.rec.key))];

  const Dd = ({ label, k, options, fmt }) => (
    <label className="text-xs text-slate-500 flex flex-col gap-1">
      {label}
      <select
        className="border border-slate-300 rounded-md px-2 py-1 text-sm text-slate-800"
        value={filters[k]}
        onChange={(e) => setFilter(k, e.target.value)}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>{fmt ? fmt(o) : o}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-wrap gap-3 items-end mb-3">
      <Dd label="Language" k="language" options={langs} fmt={(l) => LANG_NAMES[l] || l} />
      <Dd label="BU" k="bu" options={bus} />
      <Dd label="Category" k="category" options={cats} />
      <Dd label="Status" k="status" options={stats} fmt={(s) => s[0].toUpperCase() + s.slice(1)} />
      <Dd label="Recommendation" k="action" options={acts} fmt={(k) => (ACTION_META[k] || { label: k }).label} />
      {!hideAgreement && (
        <Dd label="Agreement" k="agreement" options={['aligned-positive', 'aligned-negative', 'conflict', 'partial', 'one-lens']} />
      )}
      <label className="text-xs text-slate-500 flex flex-col gap-1">
        Search
        <input
          value={search}
          placeholder="show / id"
          className="border border-slate-300 rounded-md px-2 py-1 text-sm"
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <button className="btn btn-ghost" onClick={resetFilters}>Clear</button>
    </div>
  );
}

// shared filter predicate (mirrors applyFilters)
export function applyFilters(model, filters, search) {
  let m = model;
  if (filters.language) m = m.filter((s) => s.language === filters.language);
  if (filters.bu) m = m.filter((s) => s.bu === filters.bu);
  if (filters.category) m = m.filter((s) => s.category === filters.category);
  if (filters.status) m = m.filter((s) => s.status === filters.status);
  if (filters.action) m = m.filter((s) => s.rec.key === filters.action);
  if (filters.agreement) m = m.filter((s) => s.rec.agreement === filters.agreement);
  if (search) {
    const q = search.toLowerCase();
    m = m.filter((s) => (s.title || '').toLowerCase().includes(q) || String(s.id).includes(q));
  }
  return m;
}

export function sortModel(m, by) {
  const users = (s) => Number(s.eval?.cur?.show_users) || 0;
  const contrib = (s) => {
    const v = s.eval?.cur?.l3w_current_contrib_pct;
    return v == null || v === '' || isNaN(+v) ? null : +v;
  };
  return [...m].sort((a, b) => {
    if (by === 'priority') return a.rec.priority - b.rec.priority || users(b) - users(a);
    if (by === 'users') return users(b) - users(a);
    if (by === 'contrib') return (contrib(b) ?? -1) - (contrib(a) ?? -1);
    return a.life.score - b.life.score || users(b) - users(a);
  });
}

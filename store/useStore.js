import { create } from 'zustand';
import { idbSet, idbGet, idbDel } from '@/lib/idb';
import { sampleData } from '@/lib/sample';

// Global app state (replaces the original mutable `state` object).
export const useStore = create((set, get) => ({
  evalRows: null, fatRows: null, hdcRows: null, snapRows: null, tsRows: null, metaRows: null, rcaRows: null,
  evalMeta: null, fatMeta: null, hdcMeta: null, snapMeta: null, tsMeta: null, metaMeta: null, rcaMeta: null,
  hydrated: false,

  tab: 'data',
  filters: { language: '', category: '', bu: '', status: '', action: '', agreement: '' },
  search: '',
  sortBy: 'lifecycle',
  deepDiveId: null,
  deepLang: '',

  // ---- derived ----
  hasData: () => !!(get().evalRows || get().fatRows),
  data: () => {
    const s = get();
    return {
      evalRows: s.evalRows, fatRows: s.fatRows, hdcRows: s.hdcRows, snapRows: s.snapRows, tsRows: s.tsRows, metaRows: s.metaRows, rcaRows: s.rcaRows,
      evalMeta: s.evalMeta, fatMeta: s.fatMeta, hdcMeta: s.hdcMeta, snapMeta: s.snapMeta, tsMeta: s.tsMeta, metaMeta: s.metaMeta, rcaMeta: s.rcaMeta,
    };
  },

  // ---- UI setters ----
  setTab: (tab) => set({ tab }),
  setFilter: (key, value) => set((st) => ({ filters: { ...st.filters, [key]: value } })),
  resetFilters: () => set({ filters: { language: '', category: '', bu: '', status: '', action: '', agreement: '' }, search: '' }),
  setSearch: (search) => set({ search }),
  setSortBy: (sortBy) => set({ sortBy }),
  setDeepDiveId: (deepDiveId) => set({ deepDiveId }),
  setDeepLang: (deepLang) => set({ deepLang }),
  openDeepDive: (id) => set({ deepDiveId: id, tab: 'deep' }),

  // ---- persistence ----
  persist: async () => {
    const s = get();
    await idbSet('eval', s.evalRows ? { rows: s.evalRows, meta: s.evalMeta } : null);
    await idbSet('fat', s.fatRows ? { rows: s.fatRows, meta: s.fatMeta } : null);
    await idbSet('hdc', s.hdcRows ? { rows: s.hdcRows, meta: s.hdcMeta } : null);
    await idbSet('snap', s.snapRows ? { rows: s.snapRows, meta: s.snapMeta } : null);
    await idbSet('ts', s.tsRows ? { rows: s.tsRows, meta: s.tsMeta } : null);
    await idbSet('meta', s.metaRows ? { rows: s.metaRows, meta: s.metaMeta } : null);
    await idbSet('rca', s.rcaRows ? { rows: s.rcaRows, meta: s.rcaMeta } : null);
  },

  hydrate: async () => {
    try {
      const e = await idbGet('eval'),
        f = await idbGet('fat'),
        hd = await idbGet('hdc'),
        sn = await idbGet('snap'),
        ts = await idbGet('ts'),
        mt = await idbGet('meta'),
        rc = await idbGet('rca');
      const patch = { hydrated: true };
      if (e && e.rows) { patch.evalRows = e.rows; patch.evalMeta = e.meta; }
      if (f && f.rows) { patch.fatRows = f.rows; patch.fatMeta = f.meta; }
      if (hd && hd.rows) { patch.hdcRows = hd.rows; patch.hdcMeta = hd.meta; }
      if (sn && sn.rows) { patch.snapRows = sn.rows; patch.snapMeta = sn.meta; }
      if (ts && ts.rows) { patch.tsRows = ts.rows; patch.tsMeta = ts.meta; }
      if (mt && mt.rows) { patch.metaRows = mt.rows; patch.metaMeta = mt.meta; }
      if (rc && rc.rows) { patch.rcaRows = rc.rows; patch.rcaMeta = rc.meta; }
      patch.tab = patch.evalRows || patch.fatRows ? 'explorer' : 'data';
      set(patch);
    } catch (err) {
      console.warn('idb load failed', err);
      set({ hydrated: true });
    }
  },

  // ---- data mutations ----
  setUpload: async (which, rows, meta) => {
    if (which === 'eval') set({ evalRows: rows, evalMeta: meta });
    else if (which === 'hdc') set({ hdcRows: rows, hdcMeta: meta });
    else if (which === 'snapshot') set({ snapRows: rows, snapMeta: meta });
    else if (which === 'rca') set({ rcaRows: rows, rcaMeta: meta });
    else set({ fatRows: rows, fatMeta: meta });
    await get().persist();
  },

  // Set all three datasets from a single combined upload (only non-empty buckets replace).
  setCombined: async ({ eval: ev, fat, hdc, ts, showmeta, meta }) => {
    const patch = {};
    if (ev && ev.length) { patch.evalRows = ev; patch.evalMeta = meta.eval; }
    if (fat && fat.length) { patch.fatRows = fat; patch.fatMeta = meta.fat; }
    if (hdc && hdc.length) { patch.hdcRows = hdc; patch.hdcMeta = meta.hdc; }
    if (ts && ts.length) { patch.tsRows = ts; patch.tsMeta = meta.ts; }
    if (showmeta && showmeta.length) { patch.metaRows = showmeta; patch.metaMeta = meta.showmeta; }
    set(patch);
    await get().persist();
  },

  loadSample: async () => {
    const S = sampleData();
    const mk = (name, arr) => ({ filename: name, uploadedAt: new Date().toISOString(), rowCount: arr.length, columnCount: Object.keys(arr[0]).length, parseErrors: 0 });
    set({
      evalRows: S.eval, evalMeta: mk('sample_eval.csv', S.eval),
      fatRows: S.fat, fatMeta: mk('sample_fatigue.csv', S.fat),
      hdcRows: S.hdc, hdcMeta: mk('sample_hdc.csv', S.hdc),
      tsRows: S.ts, tsMeta: S.ts && S.ts.length ? mk('sample_timespent.csv', S.ts) : null,
      metaRows: S.meta, metaMeta: S.meta && S.meta.length ? mk('sample_meta.csv', S.meta) : null,
      rcaRows: S.rca, rcaMeta: S.rca && S.rca.length ? mk('sample_rca.csv', S.rca) : null,
      tab: 'explorer',
    });
    await get().persist();
  },

  clearAll: async () => {
    set({ evalRows: null, fatRows: null, hdcRows: null, snapRows: null, tsRows: null, metaRows: null, rcaRows: null, evalMeta: null, fatMeta: null, hdcMeta: null, snapMeta: null, tsMeta: null, metaMeta: null, rcaMeta: null, tab: 'data' });
    await idbDel('eval');
    await idbDel('fat');
    await idbDel('hdc');
    await idbDel('snap');
    await idbDel('ts');
    await idbDel('meta');
    await idbDel('rca');
  },
}));

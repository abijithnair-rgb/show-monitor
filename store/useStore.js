import { create } from 'zustand';
import { idbSet, idbGet, idbDel } from '@/lib/idb';
import { sampleData } from '@/lib/sample';

// Global app state (replaces the original mutable `state` object).
export const useStore = create((set, get) => ({
  evalRows: null, fatRows: null, hdcRows: null, snapRows: null,
  evalMeta: null, fatMeta: null, hdcMeta: null, snapMeta: null,
  hydrated: false,

  tab: 'data',
  filters: { language: '', category: '', status: '', action: '', agreement: '' },
  search: '',
  sortBy: 'lifecycle',
  deepDiveId: null,
  deepLang: '',

  // ---- derived ----
  hasData: () => !!(get().evalRows || get().fatRows),
  data: () => {
    const s = get();
    return {
      evalRows: s.evalRows, fatRows: s.fatRows, hdcRows: s.hdcRows, snapRows: s.snapRows,
      evalMeta: s.evalMeta, fatMeta: s.fatMeta, hdcMeta: s.hdcMeta, snapMeta: s.snapMeta,
    };
  },

  // ---- UI setters ----
  setTab: (tab) => set({ tab }),
  setFilter: (key, value) => set((st) => ({ filters: { ...st.filters, [key]: value } })),
  resetFilters: () => set({ filters: { language: '', category: '', status: '', action: '', agreement: '' }, search: '' }),
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
  },

  hydrate: async () => {
    try {
      const e = await idbGet('eval'),
        f = await idbGet('fat'),
        hd = await idbGet('hdc'),
        sn = await idbGet('snap');
      const patch = { hydrated: true };
      if (e && e.rows) { patch.evalRows = e.rows; patch.evalMeta = e.meta; }
      if (f && f.rows) { patch.fatRows = f.rows; patch.fatMeta = f.meta; }
      if (hd && hd.rows) { patch.hdcRows = hd.rows; patch.hdcMeta = hd.meta; }
      if (sn && sn.rows) { patch.snapRows = sn.rows; patch.snapMeta = sn.meta; }
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
    else set({ fatRows: rows, fatMeta: meta });
    await get().persist();
  },

  // Set all three datasets from a single combined upload (only non-empty buckets replace).
  setCombined: async ({ eval: ev, fat, hdc, meta }) => {
    const patch = {};
    if (ev && ev.length) { patch.evalRows = ev; patch.evalMeta = meta.eval; }
    if (fat && fat.length) { patch.fatRows = fat; patch.fatMeta = meta.fat; }
    if (hdc && hdc.length) { patch.hdcRows = hdc; patch.hdcMeta = meta.hdc; }
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
      tab: 'explorer',
    });
    await get().persist();
  },

  clearAll: async () => {
    set({ evalRows: null, fatRows: null, hdcRows: null, snapRows: null, evalMeta: null, fatMeta: null, hdcMeta: null, snapMeta: null, tab: 'data' });
    await idbDel('eval');
    await idbDel('fat');
    await idbDel('hdc');
    await idbDel('snap');
  },
}));

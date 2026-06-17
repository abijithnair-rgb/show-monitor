import { create } from 'zustand';
import { idbSet, idbGet, idbDel } from '@/lib/idb';
import { sampleData } from '@/lib/sample';
import { fetchSheets, fetchRemote, remoteStatus } from '@/lib/remote';
import { fetchActions, claimAction, updateClaim, archiveAction, releaseAction } from '@/lib/actions';

// Global app state (replaces the original mutable `state` object).
export const useStore = create((set, get) => ({
  evalRows: null, fatRows: null, hdcRows: null, snapRows: null, tsRows: null, metaRows: null, rcaRows: null, audRows: null, retRows: null,
  evalMeta: null, fatMeta: null, hdcMeta: null, snapMeta: null, tsMeta: null, metaMeta: null, rcaMeta: null, audMeta: null, retMeta: null,
  hydrated: false,

  // Auto-sync: Redash proxy (keys server-side) is primary; Google-Sheet links optional.
  sheetCombinedUrl: '', sheetRcaUrl: '',
  remoteConfigured: { combined: false, rca: false },
  lastSyncAt: null, syncing: false, syncError: null,

  // Shared action-ownership board (Vercel KV). actions = { experimentId: claim }
  // (a show can hold several), history = { show_id: [concluded experiments] }.
  actions: {}, history: {}, actionsConfigured: false, userName: '',

  tab: 'data',
  // metricBand/metricOp/metricX: Explorer-only label/SR threshold filter
  // (e.g. "L0 ≥ 40%" or "SR ≤ 70%"). Empty band/X = inactive.
  filters: { language: '', category: '', bu: '', status: '', action: '', agreement: '', manager: '', metricBand: '', metricOp: 'gte', metricX: '' },
  search: '',
  sortBy: 'users',
  deepDiveId: null,
  deepLang: '',

  // Action Queue filters — in-memory only (survive tab switches, reset on a full
  // page refresh). Deliberately NOT persisted to IndexedDB.
  aqFilters: { search: '', sortBy: 'overdue', language: '', status: '', bu: '', category: '', recommendation: '', reason: '', confidence: '', fixArea: '', manager: '' },

  // ---- derived ----
  hasData: () => !!(get().evalRows || get().fatRows),
  data: () => {
    const s = get();
    return {
      evalRows: s.evalRows, fatRows: s.fatRows, hdcRows: s.hdcRows, snapRows: s.snapRows, tsRows: s.tsRows, metaRows: s.metaRows, rcaRows: s.rcaRows, audRows: s.audRows, retRows: s.retRows,
      evalMeta: s.evalMeta, fatMeta: s.fatMeta, hdcMeta: s.hdcMeta, snapMeta: s.snapMeta, tsMeta: s.tsMeta, metaMeta: s.metaMeta, rcaMeta: s.rcaMeta, audMeta: s.audMeta, retMeta: s.retMeta,
    };
  },

  // ---- UI setters ----
  setTab: (tab) => set({ tab }),
  setFilter: (key, value) => set((st) => ({ filters: { ...st.filters, [key]: value } })),
  resetFilters: () => set({ filters: { language: '', category: '', bu: '', status: '', action: '', agreement: '', manager: '', metricBand: '', metricOp: 'gte', metricX: '' }, search: '' }),
  setSearch: (search) => set({ search }),
  setSortBy: (sortBy) => set({ sortBy }),
  setDeepDiveId: (deepDiveId) => set({ deepDiveId }),
  setDeepLang: (deepLang) => set({ deepLang }),
  openDeepDive: (id) => set({ deepDiveId: id, tab: 'deep' }),
  setAqFilter: (key, value) => set((st) => ({ aqFilters: { ...st.aqFilters, [key]: value } })),
  resetAqFilters: () => set({ aqFilters: { search: '', sortBy: 'overdue', language: '', status: '', bu: '', category: '', recommendation: '', reason: '', confidence: '', fixArea: '', manager: '' } }),

  // All active experiments for a show (sorted oldest-first; [0] = "primary").
  claimsForShow: (showId) => Object.values(get().actions || {})
    .filter((c) => String(c.show_id) === String(showId))
    .sort((a, b) => String(a.claimed_at || '').localeCompare(String(b.claimed_at || ''))),

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
    await idbSet('aud', s.audRows ? { rows: s.audRows, meta: s.audMeta } : null);
    await idbSet('ret', s.retRows ? { rows: s.retRows, meta: s.retMeta } : null);
  },

  hydrate: async () => {
    try {
      const e = await idbGet('eval'),
        f = await idbGet('fat'),
        hd = await idbGet('hdc'),
        sn = await idbGet('snap'),
        ts = await idbGet('ts'),
        mt = await idbGet('meta'),
        rc = await idbGet('rca'),
        au = await idbGet('aud'),
        re = await idbGet('ret'),
        st = await idbGet('settings');
      const patch = { hydrated: true };
      if (st) {
        patch.sheetCombinedUrl = st.sheetCombinedUrl || '';
        patch.sheetRcaUrl = st.sheetRcaUrl || '';
        patch.lastSyncAt = st.lastSyncAt || null;
        patch.userName = st.userName || '';
      }
      if (e && e.rows) { patch.evalRows = e.rows; patch.evalMeta = e.meta; }
      if (f && f.rows) { patch.fatRows = f.rows; patch.fatMeta = f.meta; }
      if (hd && hd.rows) { patch.hdcRows = hd.rows; patch.hdcMeta = hd.meta; }
      if (sn && sn.rows) { patch.snapRows = sn.rows; patch.snapMeta = sn.meta; }
      if (ts && ts.rows) { patch.tsRows = ts.rows; patch.tsMeta = ts.meta; }
      if (mt && mt.rows) { patch.metaRows = mt.rows; patch.metaMeta = mt.meta; }
      if (rc && rc.rows) { patch.rcaRows = rc.rows; patch.rcaMeta = rc.meta; }
      if (au && au.rows) { patch.audRows = au.rows; patch.audMeta = au.meta; }
      if (re && re.rows) { patch.retRows = re.rows; patch.retMeta = re.meta; }
      patch.tab = patch.evalRows || patch.fatRows ? 'explorer' : 'data';
      set(patch);
      get().loadActions();
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
  setCombined: async ({ eval: ev, fat, hdc, ts, showmeta, aud, ret, meta }) => {
    const patch = {};
    if (ev && ev.length) { patch.evalRows = ev; patch.evalMeta = meta.eval; }
    if (fat && fat.length) { patch.fatRows = fat; patch.fatMeta = meta.fat; }
    if (hdc && hdc.length) { patch.hdcRows = hdc; patch.hdcMeta = meta.hdc; }
    if (ts && ts.length) { patch.tsRows = ts; patch.tsMeta = meta.ts; }
    if (showmeta && showmeta.length) { patch.metaRows = showmeta; patch.metaMeta = meta.showmeta; }
    if (aud && aud.length) { patch.audRows = aud; patch.audMeta = meta.aud; }
    if (ret && ret.length) { patch.retRows = ret; patch.retMeta = meta.ret; }
    set(patch);
    await get().persist();
  },

  // ---- Shared action-ownership board (Vercel KV) ----
  loadActions: async () => {
    try {
      const { configured, actions, history } = await fetchActions();
      set({ actionsConfigured: !!configured, actions: actions || {}, history: history || {} });
    } catch {
      set({ actionsConfigured: false });
    }
  },
  // Patch a single claim into the map by experiment id (null = removed).
  applyClaim: (id, claim) => set((st) => {
    const next = { ...st.actions };
    if (claim) next[String(claim.id ?? id)] = claim; else delete next[String(id)];
    return { actions: next };
  }),
  setUserName: async (name) => {
    set({ userName: String(name || '').trim() });
    await get().saveSettings();
  },
  // Thin ownership writes — call the API, patch the local map, throw on error so
  // the UI can manage busy/error state. Each returns the updated claim.
  // claimShow creates a NEW experiment for a show (server assigns the id).
  claimShow: async (showId, by, snapshot, extra) => {
    const { id, claim } = await claimAction(showId, by, snapshot, extra);
    get().applyClaim(id, claim);
    return claim;
  },
  // update / archive / release target a single experiment by its id.
  updateClaimFields: async (id, fields) => {
    const res = await updateClaim(id, fields);
    get().applyClaim(res.id ?? id, res.claim);
    return res.claim;
  },
  // Conclude the experiment → append to its show's history, clear the active claim.
  archiveShow: async (id, verdict, finalSnapshot, concludeNote) => {
    const { archived } = await archiveAction(id, verdict, finalSnapshot, concludeNote);
    set((st) => {
      const actions = { ...st.actions }; delete actions[String(id)];
      const history = { ...st.history };
      const sid = String(archived?.show_id ?? id);
      history[sid] = [archived, ...(history[sid] || [])];
      return { actions, history };
    });
  },
  releaseShow: async (id) => {
    await releaseAction(id);
    get().applyClaim(id, null);
  },

  // ---- Google-Sheet auto-sync ----
  saveSettings: async () => {
    const s = get();
    await idbSet('settings', { sheetCombinedUrl: s.sheetCombinedUrl, sheetRcaUrl: s.sheetRcaUrl, lastSyncAt: s.lastSyncAt, userName: s.userName });
  },
  setSheetUrl: async (which, url) => {
    set(which === 'rca' ? { sheetRcaUrl: url } : { sheetCombinedUrl: url });
    await get().saveSettings();
  },
  // Prefer Redash (server-configured); fall back to Google-Sheet links.
  autoSync: async ({ silent } = {}) => {
    const s = get();
    s.loadActions(); // refresh the shared ownership board alongside data sync
    const cfg = await s.checkRemote();
    if (cfg.combined || cfg.rca) return s.syncFromRedash({ silent });
    if (s.sheetCombinedUrl || s.sheetRcaUrl) return s.syncFromSheets({ silent });
  },

  // Ask the server which Redash datasets are configured (no keys exposed).
  checkRemote: async () => {
    const cfg = await remoteStatus();
    set({ remoteConfigured: cfg });
    return cfg;
  },

  // Pull combined + RCA from Redash via the server proxy and load them.
  syncFromRedash: async ({ silent } = {}) => {
    if (get().syncing) return;
    set({ syncing: true, syncError: null });
    try {
      const { combined, rca, errors } = await fetchRemote();
      if (combined) await get().setCombined(combined);
      if (rca) await get().setUpload('rca', rca.rows, rca.meta);
      const now = new Date().toISOString();
      // Stamp lastSync only if at least one dataset loaded; surface partial errors.
      const patch = { syncing: false, syncError: errors && errors.length ? errors.join(' · ') : null };
      if (combined || rca) patch.lastSyncAt = now;
      set(patch);
      await get().saveSettings();
      if (errors && errors.length && !silent && !(combined || rca)) throw new Error(errors.join(' · '));
    } catch (err) {
      set({ syncing: false, syncError: err.message || 'Redash sync failed.' });
      if (!silent) throw err;
    }
  },

  // Pull both published-CSV links and load them through the normal parse path.
  // `silent` avoids surfacing errors during the automatic on-load sync.
  syncFromSheets: async ({ silent } = {}) => {
    const s = get();
    if (!s.sheetCombinedUrl && !s.sheetRcaUrl) return;
    if (s.syncing) return;
    set({ syncing: true, syncError: null });
    try {
      const { combined, rca } = await fetchSheets({ combinedUrl: s.sheetCombinedUrl, rcaUrl: s.sheetRcaUrl });
      if (combined) await get().setCombined(combined);
      if (rca) await get().setUpload('rca', rca.rows, rca.meta);
      const now = new Date().toISOString();
      set({ lastSyncAt: now, syncing: false });
      await get().saveSettings();
    } catch (err) {
      set({ syncing: false, syncError: err.message || 'Sync failed.' });
      if (!silent) throw err;
    }
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
      audRows: S.aud, audMeta: S.aud && S.aud.length ? mk('sample_audience.csv', S.aud) : null,
      retRows: S.ret, retMeta: S.ret && S.ret.length ? mk('sample_retention.csv', S.ret) : null,
      tab: 'explorer',
    });
    await get().persist();
  },

  clearAll: async () => {
    set({ evalRows: null, fatRows: null, hdcRows: null, snapRows: null, tsRows: null, metaRows: null, rcaRows: null, audRows: null, retRows: null, evalMeta: null, fatMeta: null, hdcMeta: null, snapMeta: null, tsMeta: null, metaMeta: null, rcaMeta: null, audMeta: null, retMeta: null, tab: 'data' });
    await idbDel('eval');
    await idbDel('fat');
    await idbDel('hdc');
    await idbDel('snap');
    await idbDel('ts');
    await idbDel('meta');
    await idbDel('rca');
    await idbDel('aud');
    await idbDel('ret');
  },
}));

import { create } from 'zustand';
import type { AccountRecord } from '@shared/runEvents';
import type { SsoCheckResult } from '@shared/ipc';

const SSO_CHECK_STORAGE_KEY = 'gra-pool-sso-check-v1';

export type AccountListQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  sso?: string;
  alive?: string;
};

export type AccountListFacets = {
  all: number;
  hasSso: number;
  noSso: number;
  unchecked: number;
  alive: number;
  dead: number;
};

function loadSsoMapFromStorage(): Map<string, SsoCheckResult> {
  try {
    const raw = localStorage.getItem(SSO_CHECK_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, SsoCheckResult>;
    if (!parsed || typeof parsed !== 'object') return new Map();
    const map = new Map<string, SsoCheckResult>();
    for (const [id, r] of Object.entries(parsed)) {
      if (!id || !r || typeof r !== 'object') continue;
      if (typeof r.alive !== 'boolean') continue;
      map.set(id, {
        id: String(r.id || id),
        alive: r.alive,
        status: typeof r.status === 'number' ? r.status : 0,
        email: r.email,
        givenName: r.givenName,
        familyName: r.familyName,
        emailConfirmed: r.emailConfirmed,
        sessionTierId: r.sessionTierId,
        createTime: r.createTime,
        checkedAt: typeof r.checkedAt === 'string' ? r.checkedAt : new Date().toISOString(),
        error: r.error,
        botFlagSource: r.botFlagSource,
        isBotFlag1: r.isBotFlag1
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function persistSsoMap(map: Map<string, SsoCheckResult>) {
  try {
    const obj: Record<string, SsoCheckResult> = {};
    for (const [id, r] of map) {
      obj[id] = r;
    }
    localStorage.setItem(SSO_CHECK_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / private mode */
  }
}

/** 从账号记录上的 ssoCheck 字段构建结果（服务端落盘） */
function resultFromAccount(a: AccountRecord): SsoCheckResult | null {
  const c = a.ssoCheck;
  if (!c || typeof c.alive !== 'boolean') return null;
  return {
    id: a.id,
    alive: c.alive,
    status: typeof c.status === 'number' ? c.status : 0,
    email: c.email,
    givenName: c.givenName,
    familyName: c.familyName,
    emailConfirmed: c.emailConfirmed,
    sessionTierId: c.sessionTierId,
    createTime: c.createTime,
    checkedAt: typeof c.checkedAt === 'string' ? c.checkedAt : new Date().toISOString(),
    error: c.error,
    botFlagSource: c.botFlagSource,
    isBotFlag1: c.isBotFlag1
  };
}

/**
 * 合并本地缓存与服务端号池 ssoCheck：
 * - 同 id 取 checkedAt 更新的一方
 * - 分页模式下不删本地「本页以外」的缓存
 */
function mergeSsoMaps(
  local: Map<string, SsoCheckResult>,
  accounts: AccountRecord[],
  opts?: { pruneMissing?: boolean }
): Map<string, SsoCheckResult> {
  const prune = opts?.pruneMissing !== false;
  const keep = new Set(accounts.map((a) => a.id));
  const next = new Map<string, SsoCheckResult>();

  for (const [id, r] of local) {
    if (!prune || keep.has(id)) next.set(id, r);
  }

  for (const a of accounts) {
    const fromServer = resultFromAccount(a);
    if (!fromServer) continue;
    const prev = next.get(a.id);
    if (!prev) {
      next.set(a.id, fromServer);
      continue;
    }
    const tPrev = Date.parse(prev.checkedAt || '') || 0;
    const tSrv = Date.parse(fromServer.checkedAt || '') || 0;
    if (tSrv >= tPrev) next.set(a.id, fromServer);
  }

  return next;
}

function emptyFacets(): AccountListFacets {
  return { all: 0, hasSso: 0, noSso: 0, unchecked: 0, alive: 0, dead: 0 };
}

interface AccountsState {
  /** 当前页（或全量，取决于 lastQuery） */
  accounts: AccountRecord[];
  loading: boolean;
  /** 当前筛选后的总数（服务端 total） */
  listTotal: number;
  listPage: number;
  listPageSize: number;
  listTotalPages: number;
  facets: AccountListFacets;
  /** 最近一次分页查询参数 */
  lastQuery: AccountListQuery | null;
  /** true=当前 accounts 为全量 listAccounts */
  fullListMode: boolean;
  ssoMap: Map<string, SsoCheckResult>;
  /** 全量拉取（批量操作/Auth 筛选） */
  reload(): Promise<void>;
  /** 服务端分页拉取 */
  reloadPage(query?: AccountListQuery): Promise<void>;
  resync(): Promise<{ total: number; imported: number }>;
  remove(ids: string[]): Promise<{ deleted: number; remaining: number }>;
  importText(
    text: string,
    source?: string
  ): Promise<{
    totalLines: number;
    parsed: number;
    imported: number;
    skipped: number;
    invalid: number;
    remaining: number;
  }>;
  applyAccount(record: AccountRecord): void;
  applySsoResults(results: SsoCheckResult[]): void;
  pruneSsoMap(keepIds: Set<string>): void;
  clearSsoResults(): void;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: false,
  listTotal: 0,
  listPage: 1,
  listPageSize: 20,
  listTotalPages: 1,
  facets: emptyFacets(),
  lastQuery: null,
  fullListMode: true,
  ssoMap: loadSsoMapFromStorage(),

  reload: async () => {
    set({ loading: true });
    try {
      const accounts = await window.api.listAccounts();
      const ssoMap = mergeSsoMaps(get().ssoMap, accounts, { pruneMissing: true });
      persistSsoMap(ssoMap);
      let hasSso = 0;
      let unchecked = 0;
      let alive = 0;
      let dead = 0;
      for (const a of accounts) {
        if (String(a.sso || '').trim()) hasSso++;
        const c = a.ssoCheck;
        if (!c || typeof c.alive !== 'boolean') unchecked++;
        else if (c.alive) alive++;
        else dead++;
      }
      set({
        accounts,
        loading: false,
        ssoMap,
        listTotal: accounts.length,
        listPage: 1,
        listPageSize: accounts.length || 20,
        listTotalPages: 1,
        facets: {
          all: accounts.length,
          hasSso,
          noSso: accounts.length - hasSso,
          unchecked,
          alive,
          dead
        },
        lastQuery: null,
        fullListMode: true
      });
    } catch {
      set({ loading: false });
    }
  },

  reloadPage: async (query = {}) => {
    set({ loading: true });
    try {
      const api = window.api as {
        listAccountsPage?: (q?: AccountListQuery) => Promise<{
          items: AccountRecord[];
          total: number;
          page: number;
          pageSize: number;
          totalPages: number;
          facets?: AccountListFacets;
        }>;
        listAccounts: () => Promise<AccountRecord[]>;
      };
      if (!api.listAccountsPage) {
        await get().reload();
        return;
      }
      const page = await api.listAccountsPage({
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
        q: query.q || undefined,
        sso: query.sso || undefined,
        alive: query.alive || undefined
      });
      const accounts = page.items || [];
      const ssoMap = mergeSsoMaps(get().ssoMap, accounts, { pruneMissing: false });
      persistSsoMap(ssoMap);
      const facets = page.facets || {
        all: page.total,
        hasSso: 0,
        noSso: 0,
        unchecked: 0,
        alive: 0,
        dead: 0
      };
      set({
        accounts,
        loading: false,
        ssoMap,
        listTotal: page.total,
        listPage: page.page,
        listPageSize: page.pageSize,
        listTotalPages: page.totalPages,
        facets,
        lastQuery: {
          page: page.page,
          pageSize: page.pageSize,
          q: query.q,
          sso: query.sso,
          alive: query.alive
        },
        fullListMode: false
      });
    } catch {
      set({ loading: false });
    }
  },

  resync: async () => {
    set({ loading: true });
    try {
      const result = await window.api.resyncAccounts();
      const q = get().lastQuery;
      if (q && !get().fullListMode) {
        await get().reloadPage(q);
      } else {
        await get().reload();
      }
      return result;
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  remove: async (ids) => {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
    if (list.length === 0) {
      return { deleted: 0, remaining: get().listTotal || get().accounts.length };
    }
    const r = await window.api.deleteAccounts(list);
    const drop = new Set(list);
    const ssoMap = new Map(get().ssoMap);
    for (const id of drop) ssoMap.delete(id);
    persistSsoMap(ssoMap);
    set((state) => ({
      accounts: state.accounts.filter((a) => !drop.has(a.id)),
      ssoMap,
      listTotal: Math.max(0, (state.listTotal || state.accounts.length) - r.deleted),
      facets: {
        ...state.facets,
        all: Math.max(0, state.facets.all - r.deleted)
      }
    }));
    try {
      const q = get().lastQuery;
      if (q && !get().fullListMode) {
        await get().reloadPage(q);
      } else {
        await get().reload();
      }
    } catch {
      /* keep local filter */
    }
    return { deleted: r.deleted, remaining: r.remaining };
  },

  importText: async (text, source) => {
    const r = await window.api.importAccounts({ text, source });
    try {
      const q = get().lastQuery;
      if (q && !get().fullListMode) {
        await get().reloadPage({ ...q, page: 1 });
      } else {
        await get().reload();
      }
    } catch {
      /* ignore */
    }
    return r;
  },

  applyAccount: (record) => {
    const fromCheck = resultFromAccount(record);
    set((state) => {
      const byId = state.accounts.findIndex((a) => a.id === record.id);
      let accounts = state.accounts;
      let listTotal = state.listTotal;
      let facets = state.facets;
      if (byId >= 0) {
        const prev = state.accounts[byId]!;
        const merged: AccountRecord = {
          ...prev,
          ...record,
          email: String(record.email || '').trim() || prev.email,
          password: String(record.password || '').trim() || prev.password,
          sso: String(record.sso || '').trim() || prev.sso,
          ssoCheck: record.ssoCheck ?? prev.ssoCheck
        };
        accounts = state.accounts.slice();
        accounts[byId] = merged;
      } else if (record.sso && state.accounts.some((a) => a.sso && a.sso === record.sso)) {
        const si = state.accounts.findIndex((a) => a.sso && a.sso === record.sso);
        if (si >= 0) {
          const prev = state.accounts[si]!;
          accounts = state.accounts.slice();
          accounts[si] = {
            ...prev,
            ...record,
            id: prev.id,
            email: String(record.email || '').trim() || prev.email,
            ssoCheck: record.ssoCheck ?? prev.ssoCheck
          };
          if (fromCheck) fromCheck.id = prev.id;
        } else if (state.fullListMode || state.listPage <= 1) {
          accounts = [record, ...state.accounts];
          listTotal = state.listTotal + 1;
          facets = { ...state.facets, all: state.facets.all + 1 };
        }
      } else if (state.fullListMode || state.listPage <= 1) {
        // 分页模式：仅第 1 页插入新号，避免打乱其它页
        accounts = [record, ...state.accounts];
        listTotal = state.listTotal + 1;
        facets = {
          ...state.facets,
          all: state.facets.all + 1,
          hasSso: state.facets.hasSso + (String(record.sso || '').trim() ? 1 : 0)
        };
      } else {
        // 非首页：只更新计数，不插列表
        listTotal = state.listTotal + 1;
        facets = {
          ...state.facets,
          all: state.facets.all + 1,
          hasSso: state.facets.hasSso + (String(record.sso || '').trim() ? 1 : 0)
        };
      }

      let ssoMap = state.ssoMap;
      if (fromCheck) {
        ssoMap = new Map(state.ssoMap);
        const mapId = byId >= 0 ? record.id : fromCheck.id || record.id;
        ssoMap.set(mapId, { ...fromCheck, id: mapId });
        persistSsoMap(ssoMap);
      }
      return { accounts, ssoMap, listTotal, facets };
    });
  },

  applySsoResults: (results) => {
    if (!results?.length) return;
    const ssoMap = new Map(get().ssoMap);
    for (const r of results) {
      if (!r?.id) continue;
      ssoMap.set(r.id, r);
    }
    persistSsoMap(ssoMap);
    set((state) => ({
      ssoMap,
      accounts: state.accounts.map((a) => {
        const r = ssoMap.get(a.id);
        if (!r) return a;
        return {
          ...a,
          email:
            !String(a.email || '').trim() && r.email ? String(r.email) : a.email,
          ssoCheck: {
            alive: r.alive,
            status: r.status,
            checkedAt: r.checkedAt,
            email: r.email,
            givenName: r.givenName,
            familyName: r.familyName,
            emailConfirmed: r.emailConfirmed,
            sessionTierId: r.sessionTierId,
            createTime: r.createTime,
            error: r.error,
            botFlagSource: r.botFlagSource,
            isBotFlag1: r.isBotFlag1
          }
        };
      })
    }));
  },

  pruneSsoMap: (keepIds) => {
    const prev = get().ssoMap;
    let changed = false;
    const ssoMap = new Map(prev);
    for (const id of prev.keys()) {
      if (!keepIds.has(id)) {
        ssoMap.delete(id);
        changed = true;
      }
    }
    if (!changed) return;
    persistSsoMap(ssoMap);
    set({ ssoMap });
  },

  clearSsoResults: () => {
    persistSsoMap(new Map());
    set({ ssoMap: new Map() });
  }
}));

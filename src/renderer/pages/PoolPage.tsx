import { useEffect, useMemo, useRef, useState } from 'react';
import { Search,
  Bot,
  CheckSquare,
  CloudUpload,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileDown,
  FileUp,
  KeyRound,
  ListChecks,
  RefreshCcw,
  ShieldCheck,
  Square,
  Trash2,
  Wand2,
  X
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { FilterBar, FilterSegmentGroup } from '@renderer/components/ui/FilterSegmentGroup';
import { Switch } from '@renderer/components/ui/Switch';
import { PaginationBar } from '@renderer/components/ui/PaginationBar';
import { AccountDetailDrawer } from '@renderer/components/domain/AccountDetailDrawer';
import { BotFlagBadge } from '@renderer/components/domain/BotFlagBadge';
import { NsfwBadge } from '@renderer/components/domain/NsfwBadge';
import { PushChannelBadge } from '@renderer/components/domain/PushChannelBadge';
import {
  DEFAULT_PAGE_SIZE,
  isPageSize,
  loadStoredPageSize,
  type PageSize
} from '@renderer/components/ui/PaginationBar';
import { useAccountsStore } from '@renderer/store/accountsStore';
import { getQuery, getQueryInt, oneOf, patchQuery } from '@renderer/lib/urlQuery';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useRunStore } from '@renderer/store/runStore';
import { useToastStore } from '@renderer/store/toastStore';
import { cn } from '@renderer/lib/cn';
import {
  loadEmailPrivacyMask,
  maskEmail,
  saveEmailPrivacyMask
} from '@renderer/lib/maskEmail';
import { readBotFlagFromSso } from '@renderer/lib/botFlag';
import { buildSsoHashMap } from '@renderer/lib/ssoHash';
import { fmtBeijing, fmtBeijingTime } from '@renderer/lib/time';
import type { AccountRecord } from '@shared/runEvents';
import type { CpaAuthBatchResultItem, SsoCheckResult } from '@shared/ipc';
import { ssoCheckVerdict } from '@shared/ssoCheckVerdict';

const PAGE_SIZE_KEY = 'gra-pool-page-size';
const AUTH_FILTER_KEY = 'gra-pool-auth-filter';
const ALIVE_FILTER_KEY = 'gra-pool-alive-filter';
const SSO_FILTER_KEY = 'gra-pool-sso-filter';
const MINT_CHUNK = 5;
/** SSO 验活分块：每块请求服务端（服务端内并发 5） */
const VERIFY_CHUNK = 25;

/** Auth 转换筛选 */
type AuthFilter = 'all' | 'unconverted' | 'converted';
/** 验活状态筛选 */
type AliveFilter = 'all' | 'unchecked' | 'alive' | 'dead' | 'unknown';
/** 是否含 SSO 筛选（分页/列表基于此） */
type SsoFilter = 'all' | 'has_sso' | 'no_sso';

function loadAuthFilter(): AuthFilter {
  const fromUrl = oneOf(getQuery('auth'), ['all', 'unconverted', 'converted'] as const, '' as AuthFilter | '');
  if (fromUrl) return fromUrl;
  try {
    const v = localStorage.getItem(AUTH_FILTER_KEY);
    if (v === 'unconverted' || v === 'converted' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

function loadAliveFilter(): AliveFilter {
  const fromUrl = oneOf(
    getQuery('alive'),
    ['all', 'unchecked', 'alive', 'dead', 'unknown'] as const,
    '' as AliveFilter | ''
  );
  if (fromUrl) return fromUrl;
  try {
    const v = localStorage.getItem(ALIVE_FILTER_KEY);
    if (v === 'unchecked' || v === 'alive' || v === 'dead' || v === 'unknown' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

function loadSsoFilter(): SsoFilter {
  const fromUrl = oneOf(getQuery('sso'), ['all', 'has_sso', 'no_sso'] as const, '' as SsoFilter | '');
  if (fromUrl) return fromUrl;
  try {
    const v = localStorage.getItem(SSO_FILTER_KEY);
    if (v === 'has_sso' || v === 'no_sso' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

function normEmail(email: string | undefined | null): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(filename: string, text: string) {
  const blob = new Blob([text + (text ? '\n' : '')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type MintProgress = {
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  banned: number;
  current?: string;
  running: boolean;
};

/** SSO 批量验活进度 */
type VerifyProgress = {
  total: number;
  done: number;
  alive: number;
  dead: number;
  unknown: number;
  current?: string;
  running: boolean;
  /** all=当前筛选；unchecked/unknown/dead=智能复检 */
  recheck: 'all' | 'unchecked' | 'unknown' | 'dead';
};

type VerifyRecheck = VerifyProgress['recheck'];

export function PoolPage() {
  const accounts = useAccountsStore((s) => s.accounts);
  const loading = useAccountsStore((s) => s.loading);
  const reload = useAccountsStore((s) => s.reload);
  const reloadPage = useAccountsStore((s) => s.reloadPage);
  const resync = useAccountsStore((s) => s.resync);
  const remove = useAccountsStore((s) => s.remove);
  const importText = useAccountsStore((s) => s.importText);
  const ssoMap = useAccountsStore((s) => s.ssoMap);
  const applySsoResults = useAccountsStore((s) => s.applySsoResults);
  const listTotal = useAccountsStore((s) => s.listTotal);
  const listPage = useAccountsStore((s) => s.listPage);
  const listTotalPages = useAccountsStore((s) => s.listTotalPages);
  const facets = useAccountsStore((s) => s.facets);
  const fullListMode = useAccountsStore((s) => s.fullListMode);
  const phase = useRunStore((s) => s.status.phase);
  const push = useToastStore((s) => s.push);
  const settings = useSettingsStore((s) => s.data);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(() => getQueryInt('page', 1));
  const [pageSize, setPageSize] = useState<PageSize>(() => {
    const fromUrl = Number(getQuery('ps'));
    if (isPageSize(fromUrl)) return fromUrl;
    return loadStoredPageSize(PAGE_SIZE_KEY, DEFAULT_PAGE_SIZE);
  });
  const [verifying, setVerifying] = useState(false);
  const [verifyProg, setVerifyProg] = useState<VerifyProgress | null>(null);
  const verifyAbortRef = useRef<AbortController | null>(null);
  const [pushingG2a, setPushingG2a] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState('');
  const [importSource, setImportSource] = useState('paste');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** 详情抽屉完整记录（列表轻字段无密钥时按 id 拉取） */
  const [detailAccount, setDetailAccount] = useState<AccountRecord | null>(null);
  const [mintProg, setMintProg] = useState<MintProgress | null>(null);
  const [emailMasked, setEmailMasked] = useState(() => loadEmailPrivacyMask());
  /** 补签 Auth 时跳过 bot_flag_source=1（默认关，localStorage 记忆；开=蓝） */
  const [skipBotFlag1, setSkipBotFlag1] = useState(() => {
    try {
      const v = localStorage.getItem('gra-skip-bot-flag1');
      if (v === null) return false;
      return v === '1' || v === 'true';
    } catch {
      return false;
    }
  });
  /** CPA auth 目录中已存在的邮箱（小写），用于「已转换」标签 */
  const [authEmails, setAuthEmails] = useState<Set<string>>(() => new Set());
  /**
   * 邮箱 / ssoHash → 已转通道集合（A=pkce / B=device）。
   * 用于卡片标签 Auth A / Auth B / Auth AB。
   */
  const [authEmailChannels, setAuthEmailChannels] = useState<Map<string, Set<'A' | 'B'>>>(
    () => new Map()
  );
  const [authHashChannels, setAuthHashChannels] = useState<Map<string, Set<'A' | 'B'>>>(
    () => new Map()
  );
  /**
   * 邮箱 / ssoHash → Auth 侧 bot_flag（badge-index 轻量解析）。
   * SSO JWT 无 claim 时回退展示，与 Auth 页一致。
   */
  const [authEmailBotFlags, setAuthEmailBotFlags] = useState<
    Map<string, { botFlagSource: number | string | null; isBotFlag1: boolean }>
  >(() => new Map());
  const [authHashBotFlags, setAuthHashBotFlags] = useState<
    Map<string, { botFlagSource: number | string | null; isBotFlag1: boolean }>
  >(() => new Map());
  /** auth 文件内 sso 的 SHA-256 集合（无邮箱时交叉匹配） */
  const [authSsoHashes, setAuthSsoHashes] = useState<Set<string>>(() => new Set());
  /** 号池账号 id → ssoHash（异步预计算） */
  const [accountSsoHashes, setAccountSsoHashes] = useState<Map<string, string>>(
    () => new Map()
  );
  const [authFilter, setAuthFilter] = useState<AuthFilter>(() => loadAuthFilter());
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>(() => loadAliveFilter());
  const [ssoFilter, setSsoFilter] = useState<SsoFilter>(() => loadSsoFilter());
  const [searchQuery, setSearchQuery] = useState(() => getQuery('q'));

  // 筛选/页码同步到 URL（刷新可恢复）；切到号池时清 Auth 专用 key
  useEffect(() => {
    patchQuery({
      tab: 'pool',
      page: page > 1 ? page : null,
      ps: pageSize !== DEFAULT_PAGE_SIZE ? pageSize : null,
      q: searchQuery.trim() || null,
      sso: ssoFilter === 'all' ? null : ssoFilter,
      alive: aliveFilter === 'all' ? null : aliveFilter,
      auth: authFilter === 'all' ? null : authFilter,
      meta: null,
      status: null,
      push: null
    });
  }, [page, pageSize, searchQuery, ssoFilter, aliveFilter, authFilter]);

  // 浏览器前进/后退：从 URL 恢复筛选
  useEffect(() => {
    const onPop = () => {
      setPage(getQueryInt('page', 1));
      const ps = Number(getQuery('ps'));
      if (isPageSize(ps)) setPageSize(ps);
      setSearchQuery(getQuery('q'));
      setSsoFilter(oneOf(getQuery('sso'), ['all', 'has_sso', 'no_sso'] as const, 'all'));
      setAliveFilter(
        oneOf(getQuery('alive'), ['all', 'unchecked', 'alive', 'dead'] as const, 'all')
      );
      setAuthFilter(
        oneOf(getQuery('auth'), ['all', 'unconverted', 'converted'] as const, 'all')
      );
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const reloadAuthEmails = async () => {
    try {
      const api = window.api as {
        getAuthBadgeIndex?: () => Promise<{
          emails: string[];
          ssoHashes: string[];
          emailChannels: Record<string, ('A' | 'B')[]>;
          hashChannels: Record<string, ('A' | 'B')[]>;
          emailBotFlags: Record<
            string,
            { botFlagSource: number | string | null; isBotFlag1: boolean }
          >;
          hashBotFlags: Record<
            string,
            { botFlagSource: number | string | null; isBotFlag1: boolean }
          >;
        }>;
        listCpaAuth: () => Promise<{
          items: Array<{
            email?: string;
            ssoHash?: string | null;
            mintChannel?: 'A' | 'B' | null;
            botFlagSource?: number | string | null;
            isBotFlag1?: boolean;
          }>;
        }>;
      };

      // 仅用轻量索引；禁止回退 listCpaAuth 全量（会拖垮 Auth 目录）
      if (!api.getAuthBadgeIndex) {
        console.warn('[PoolPage] getAuthBadgeIndex unavailable; skip auth badges');
        return;
      }
      const r = await api.getAuthBadgeIndex();
      const nextEmails = new Set((r.emails || []).map((e) => normEmail(e)).filter(Boolean));
      const nextHashes = new Set(
        (r.ssoHashes || []).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean)
      );
      const nextEmailCh = new Map<string, Set<'A' | 'B'>>();
      const nextHashCh = new Map<string, Set<'A' | 'B'>>();
      for (const [k, arr] of Object.entries(r.emailChannels || {})) {
        const key = normEmail(k);
        if (!key) continue;
        nextEmailCh.set(key, new Set((arr || []).filter((c) => c === 'A' || c === 'B')));
      }
      for (const [k, arr] of Object.entries(r.hashChannels || {})) {
        const key = String(k || '').trim().toLowerCase();
        if (!key) continue;
        nextHashCh.set(key, new Set((arr || []).filter((c) => c === 'A' || c === 'B')));
      }
      const nextEmailFlags = new Map(
        Object.entries(r.emailBotFlags || {}).map(([k, v]) => [normEmail(k) || k, v])
      );
      const nextHashFlags = new Map(
        Object.entries(r.hashBotFlags || {}).map(([k, v]) => [
          String(k || '').trim().toLowerCase(),
          v
        ])
      );
      setAuthEmails(nextEmails);
      setAuthSsoHashes(nextHashes);
      setAuthEmailChannels(nextEmailCh);
      setAuthHashChannels(nextHashCh);
      setAuthEmailBotFlags(nextEmailFlags);
      setAuthHashBotFlags(nextHashFlags);
    } catch {
      /* auth 目录不可用时保持旧集合 */
    }
  };

  const toggleEmailPrivacy = () => {
    setEmailMasked((prev) => {
      const next = !prev;
      saveEmailPrivacyMask(next);
      return next;
    });
  };

  const doImport = async () => {
    const text = importDraft.trim();
    if (!text) {
      push({ tone: 'warn', title: '请粘贴或选择文件' });
      return;
    }
    setImporting(true);
    try {
      const r = await importText(text, importSource || 'paste');
      push({
        tone: r.imported > 0 ? 'ok' : 'warn',
        title: 'SSO 导入完成',
        description: `新增 ${r.imported} · 跳过 ${r.skipped} · 无效 ${r.invalid} · 剩余 ${r.remaining}`
      });
      if (r.imported > 0) {
        setImportOpen(false);
        setImportDraft('');
        setImportSource('paste');
      }
    } catch (err) {
      push({
        tone: 'danger',
        title: '导入失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setImporting(false);
    }
  };

  const onPickImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      setImportDraft(text);
      setImportSource(file.name || 'file');
      setImportOpen(true);
    } catch (err) {
      push({
        tone: 'danger',
        title: '读取文件失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const fetchList = async (opts?: { page?: number; pageSize?: PageSize }) => {
    const p = opts?.page ?? page;
    const ps = opts?.pageSize ?? pageSize;
    await reloadPage({
      page: p,
      pageSize: ps,
      q: searchQuery.trim() || undefined,
      sso: ssoFilter === 'all' ? undefined : ssoFilter,
      alive: aliveFilter === 'all' ? undefined : aliveFilter,
      auth: authFilter === 'all' ? undefined : authFilter
    });
  };

  const [poolLoadError, setPoolLoadError] = useState<string | null>(null);

  const doReload = async (scanHistory = false) => {
    try {
      if (scanHistory) {
        const r = await resync();
        if (r.imported > 0) {
          push({
            tone: 'ok',
            title: '已导入历史',
            description: `新增 ${r.imported} 条，合计 ${r.total}`
          });
        }
      } else {
        await fetchList();
      }
      setPoolLoadError(null);
      try {
        await reloadAuthEmails();
      } catch (authErr) {
        // Auth 目录很大时可能慢/失败，不阻断号池主列表
        console.warn('[PoolPage] reloadAuthEmails failed', authErr);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPoolLoadError(msg);
      push({
        tone: 'danger',
        title: '加载 SSO 失败',
        description: msg
      });
    } finally {
      setLastRefresh(new Date().toISOString());
    }
  };

  // 筛选/页码变化：拉服务端当前页（失败不回退全量）
  useEffect(() => {
    const t = window.setTimeout(() => {
      void fetchList()
        .then(() => {
          setPoolLoadError(null);
          return reloadAuthEmails();
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setPoolLoadError(msg);
        })
        .finally(() => {
          setLastRefresh(new Date().toISOString());
        });
    }, searchQuery.trim() ? 280 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, ssoFilter, aliveFilter, authFilter, searchQuery]);

  useEffect(() => {
    if (phase === 'done') void doReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 注册运行中：轻量轮询当前页（不全量）
  useEffect(() => {
    if (phase !== 'running' && phase !== 'starting') return;
    const id = window.setInterval(() => {
      void fetchList().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, page, pageSize, ssoFilter, aliveFilter, authFilter, searchQuery]);

  // 号池 id 签名（列表无 sso 全文；hash 仅在详情 hydrate 后用）
  const accountsHashKey = useMemo(
    () => accounts.map((a) => a.id).join('|'),
    [accounts]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const map = await buildSsoHashMap(accounts);
      if (!cancelled) setAccountSsoHashes(map);
    })();
    return () => {
      cancelled = true;
    };
    // accountsHashKey 避免 accounts 引用抖动导致全量重跑；buildSsoHashMap 内部仍有 per-id 缓存
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsHashKey]);

  const isAuthConverted = (a: AccountRecord) => {
    const e = normEmail(a.email);
    if (e && authEmails.has(e)) return true;
    const h = accountSsoHashes.get(a.id);
    if (h && authSsoHashes.has(h)) return true;
    return false;
  };

  /** 已转通道：A / B / AB / 未转(null) */
  const authChannelOf = (a: AccountRecord): 'A' | 'B' | 'AB' | null => {
    const merged = new Set<'A' | 'B'>();
    const e = normEmail(a.email);
    if (e) {
      const s = authEmailChannels.get(e);
      if (s) s.forEach((c) => merged.add(c));
    }
    const h = accountSsoHashes.get(a.id);
    if (h) {
      const s = authHashChannels.get(h);
      if (s) s.forEach((c) => merged.add(c));
    }
    if (merged.size === 0) {
      // 兼容：仅命中旧集合但无通道 map 时，视为 A
      if (isAuthConverted(a)) return 'A';
      return null;
    }
    if (merged.has('A') && merged.has('B')) return 'AB';
    if (merged.has('B')) return 'B';
    return 'A';
  };

  /** 匹配到的 Auth bot_flag（邮箱优先，其次 ssoHash） */
  const authBotFlagOf = (
    a: AccountRecord
  ): { botFlagSource: number | string | null; isBotFlag1: boolean } | null => {
    const e = normEmail(a.email);
    if (e) {
      const f = authEmailBotFlags.get(e);
      if (f && f.botFlagSource != null && f.botFlagSource !== '') return f;
    }
    const h = accountSsoHashes.get(a.id);
    if (h) {
      const f = authHashBotFlags.get(h);
      if (f && f.botFlagSource != null && f.botFlagSource !== '') return f;
    }
    return null;
  };

  const aliveStatusOf = (a: AccountRecord): 'unchecked' | 'alive' | 'dead' | 'unknown' => {
    const r = ssoMap.get(a.id);
    if (!r) return ssoCheckVerdict(a.ssoCheck);
    return ssoCheckVerdict({ alive: r.alive, status: r.status });
  };

  // 服务端分页：accounts 已是当前页（含 auth 筛选）
  const filteredAccounts = accounts;
  const poolTotal = facets.all || listTotal || accounts.length;
  const convertedCount = facets.authConverted ?? 0;
  const unconvertedCount =
    facets.authUnconverted ?? Math.max(0, poolTotal - convertedCount);

  const uncheckedCount = facets.unchecked;
  const aliveOnlyCount = facets.alive;
  const deadOnlyCount = facets.dead;
  const unknownOnlyCount = (facets as { unknown?: number }).unknown ?? 0;

  // 始终服务端分页（Auth 也已服务端筛选）
  const serverPaged = !fullListMode;
  const totalForPager = serverPaged ? listTotal : filteredAccounts.length;
  const totalPages = serverPaged
    ? Math.max(1, listTotalPages)
    : Math.max(1, Math.ceil(totalForPager / pageSize) || 1);
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageAccounts = serverPaged
    ? accounts
    : filteredAccounts.slice(pageStart, pageStart + pageSize);
  const rangeFrom = totalForPager === 0 ? 0 : pageStart + 1;
  const rangeTo = Math.min(pageStart + pageSize, totalForPager);

  const resetPage = () => setPage(1);
  const changePageSize = (size: PageSize) => {
    setPageSize(size);
    setPage(1);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      /* ignore */
    }
  };

  const changeAuthFilter = (f: AuthFilter) => {
    setAuthFilter(f);
    resetPage();
    try {
      localStorage.setItem(AUTH_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  const changeAliveFilter = (f: AliveFilter) => {
    setAliveFilter(f);
    resetPage();
    try {
      localStorage.setItem(ALIVE_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  const changeSsoFilter = (f: SsoFilter) => {
    setSsoFilter(f);
    resetPage();
    try {
      localStorage.setItem(SSO_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  // 列表/筛选变化时清理无效选中（分页：只保留本页 + 仍存在的跨页已选）
  useEffect(() => {
    const pageIds = new Set(pageAccounts.map((a) => a.id));
    // 服务端分页时不强制清掉其它页的选中；仅在全量筛选列表上清理
    if (serverPaged) return;
    const ids = new Set(filteredAccounts.map((a) => a.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    void pageIds;
  }, [filteredAccounts, pageAccounts, serverPaged]);

  const ssoCount = facets.hasSso;
  const noSsoCount = facets.noSso;
  const aliveCount = aliveOnlyCount;

  const allSelected =
    !serverPaged &&
    filteredAccounts.length > 0 &&
    selected.size === filteredAccounts.length;
  const pageAllSelected =
    pageAccounts.length > 0 && pageAccounts.every((a) => selected.has(a.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 全选：全量模式=筛选结果；分页模式=仅本页（避免假全选） */
  const selectAll = () => {
    if (serverPaged) {
      selectPage();
      return;
    }
    if (filteredAccounts.length === 0) return;
    setSelected(
      allSelected ? new Set() : new Set(filteredAccounts.map((a) => a.id))
    );
  };

  /** 本页：仅当前页 */
  const selectPage = () => {
    if (pageAccounts.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) {
        for (const a of pageAccounts) next.delete(a.id);
      } else {
        for (const a of pageAccounts) next.add(a.id);
      }
      return next;
    });
  };

  /** 合并导出：email | password | sso（无 SSO 时第三段为空） */
  const exportAccounts = (
    records: { email?: string; password?: string; sso?: string }[],
    note?: string
  ) => {
    if (records.length === 0) {
      push({ tone: 'warn', title: '没有可导出的账号' });
      return;
    }
    const withSso = records.filter((r) => r.sso).length;
    const text = records
      .map((r) => `${r.email || ''} | ${r.password || ''} | ${r.sso || ''}`)
      .join('\n');
    download(`grok-accounts-${stamp()}.txt`, text);
    push({
      tone: 'ok',
      title: '已导出账号',
      description: `${records.length} 条（含 SSO ${withSso}）${note ? ` · ${note}` : ''}`
    });
  };

  const exportByScope = async (scope: 'page' | 'filter' = 'filter') => {
    try {
      if (selected.size > 0) {
        exportAccounts(
          accounts.filter((a) => selected.has(a.id)),
          '已选'
        );
        return;
      }
      const r = await resolveActionTargets({
        scope,
        requireSso: false,
        limit: 2000
      });
      if (r.truncated) {
        push({
          tone: 'warn',
          title: `匹配 ${r.total} 条，本次导出前 ${r.targets.length}`,
          description: '导出上限 2000'
        });
      }
      exportAccounts(
        r.targets,
        r.scope === 'filter' ? '筛后全部' : r.scope === 'page' ? '本页' : undefined
      );
    } catch (err) {
      push({
        tone: 'danger',
        title: '导出失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  /** 导出验活 CSV：email,password,sso,verdict,alive,status,checkedAt,error */
  const exportSsoCheckCsv = async (scope: 'page' | 'filter' = 'filter') => {
    try {
      type Row = {
        id: string;
        email: string;
        password: string;
        sso: string;
        ssoCheck?: import('@shared/runEvents').AccountSsoCheck;
      };
      let rows: Row[] = [];
      let note = '';
      if (selected.size > 0) {
        rows = accounts
          .filter((a) => selected.has(a.id))
          .map((a) => ({
            id: a.id,
            email: a.email || '',
            password: a.password || '',
            sso: a.sso || '',
            ssoCheck: a.ssoCheck
          }));
        note = '已选';
      } else {
        const r = await resolveActionTargets({
          scope,
          requireSso: false,
          limit: 2000
        });
        const byId = new Map(accounts.map((a) => [a.id, a]));
        rows = r.targets.map((t) => {
          const full = byId.get(t.id);
          return {
            id: t.id,
            email: t.email || full?.email || '',
            password: t.password || full?.password || '',
            sso: t.sso || full?.sso || '',
            ssoCheck: t.ssoCheck || full?.ssoCheck
          };
        });
        note =
          r.scope === 'filter' ? '筛后全部' : r.scope === 'page' ? '本页' : r.scope;
        if (r.truncated) {
          push({
            tone: 'warn',
            title: `匹配 ${r.total} 条，本次导出前 ${r.targets.length}`,
            description: '导出上限 2000'
          });
        }
      }
      if (rows.length === 0) {
        push({ tone: 'warn', title: '没有可导出的验活记录' });
        return;
      }
      const esc = (v: unknown) => {
        const s = v == null ? '' : String(v);
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const header = [
        'email',
        'password',
        'sso',
        'verdict',
        'alive',
        'status',
        'checkedAt',
        'error',
        'botFlagSource',
        'isBotFlag1'
      ];
      const lines = [header.join(',')];
      let withCheck = 0;
      for (const row of rows) {
        const mem = ssoMap.get(row.id);
        const check = mem
          ? {
              alive: mem.alive,
              status: mem.status,
              checkedAt: mem.checkedAt,
              error: mem.error,
              botFlagSource: mem.botFlagSource,
              isBotFlag1: mem.isBotFlag1
            }
          : row.ssoCheck;
        const verdict = ssoCheckVerdict(
          check
            ? { alive: check.alive, status: Number(check.status || 0) }
            : null
        );
        if (check) withCheck += 1;
        const aliveStr =
          check?.alive === true
            ? 'true'
            : check?.alive === false
              ? 'false'
              : check
                ? 'null'
                : '';
        lines.push(
          [
            esc(row.email),
            esc(row.password),
            esc(row.sso),
            esc(verdict),
            esc(aliveStr),
            esc(check?.status ?? ''),
            esc(check?.checkedAt ?? ''),
            esc(check?.error ?? ''),
            esc(check?.botFlagSource ?? ''),
            esc(
              check?.isBotFlag1 === true
                ? 'true'
                : check?.isBotFlag1 === false
                  ? 'false'
                  : ''
            )
          ].join(',')
        );
      }
      download(`grok-sso-check-${stamp()}.csv`, lines.join('\n'));
      push({
        tone: 'ok',
        title: '已导出验活 CSV',
        description: `${rows.length} 条（含验活快照 ${withCheck}）${note ? ` · ${note}` : ''}`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '导出验活失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const applyResults = (results: SsoCheckResult[]) => {
    applySsoResults(results);
  };

  type ActionTarget = {
    id: string;
    email: string;
    password: string;
    sso: string;
    createdAt?: string;
    ssoCheck?: import('@shared/runEvents').AccountSsoCheck;
  };

  const accountHasSso = (a: AccountRecord) =>
    a.hasSso === true || Boolean(String(a.sso || '').trim());

  /** 列表轻字段无密钥时，按 id 拉完整记录 */
  const hydrateTargets = async (list: ActionTarget[]): Promise<ActionTarget[]> => {
    const need = list.filter((a) => !String(a.sso || '').trim() && !String(a.password || '').trim());
    if (need.length === 0) return list;
    const api = window.api as {
      getAccount?: (id: string) => Promise<AccountRecord>;
    };
    if (!api.getAccount) return list;
    const map = new Map<string, ActionTarget>();
    await Promise.all(
      need.map(async (a) => {
        try {
          const full = await api.getAccount!(a.id);
          map.set(a.id, {
            id: full.id,
            email: full.email || a.email || '',
            password: full.password || '',
            sso: full.sso || '',
            createdAt: full.createdAt || a.createdAt
          });
        } catch {
          map.set(a.id, a);
        }
      })
    );
    return list.map((a) => map.get(a.id) || a);
  };

  /** 当前筛选参数（与服务端 match/paged 一致） */
  const filterQuery = () => ({
    q: searchQuery.trim() || undefined,
    sso: ssoFilter === 'all' ? undefined : ssoFilter,
    alive: aliveFilter === 'all' ? undefined : aliveFilter,
    auth: authFilter === 'all' ? undefined : authFilter
  });

  /**
   * 解析操作目标：
   * - 有勾选：本页已选（密钥可能需 hydrate）
   * - 分页且无勾选：scope=page 用本页；scope=filter 用服务端 match 全量筛选
   * - 全量模式：用 filteredAccounts
   */
  const resolveActionTargets = async (opts?: {
    scope?: 'page' | 'filter';
    requireSso?: boolean;
    limit?: number;
    /** 覆盖验活筛选：unchecked | unknown | dead | alive */
    aliveOverride?: string;
  }): Promise<{
    targets: ActionTarget[];
    scope: 'selected' | 'page' | 'filter' | 'local';
    total: number;
    truncated: boolean;
  }> => {
    const requireSso = opts?.requireSso === true;
    const limit = opts?.limit ?? 500;
    if (selected.size > 0) {
      const list = accounts
        .filter((a) => selected.has(a.id))
        .filter((a) => (requireSso ? accountHasSso(a) : true))
        .map((a) => ({
          id: a.id,
          email: a.email || '',
          password: a.password || '',
          sso: a.sso || '',
          createdAt: a.createdAt,
          ssoCheck: a.ssoCheck
        }));
      const targets = await hydrateTargets(list);
      return { targets, scope: 'selected', total: targets.length, truncated: false };
    }

    const wantFilter = opts?.scope === 'filter' || (opts?.scope !== 'page' && serverPaged);
    // 显式 page：只本页
    if (opts?.scope === 'page' || (!wantFilter && serverPaged)) {
      const list = accounts
        .filter((a) => (requireSso ? accountHasSso(a) : true))
        .map((a) => ({
          id: a.id,
          email: a.email || '',
          password: a.password || '',
          sso: a.sso || '',
          createdAt: a.createdAt,
          ssoCheck: a.ssoCheck
        }));
      const targets = await hydrateTargets(list);
      return { targets, scope: 'page', total: targets.length, truncated: false };
    }

    // 筛后全部：服务端 match（自带密钥）
    if (serverPaged) {
      const api = window.api as {
        matchAccounts?: (q?: {
          q?: string;
          sso?: string;
          alive?: string;
          auth?: string;
          limit?: number;
          requireSso?: boolean;
        }) => Promise<{
          items: ActionTarget[];
          total: number;
          returned: number;
          truncated: boolean;
          limit: number;
        }>;
      };
      if (!api.matchAccounts) {
        const list = accounts
          .filter((a) => (requireSso ? accountHasSso(a) : true))
          .map((a) => ({
            id: a.id,
            email: a.email || '',
            password: a.password || '',
            sso: a.sso || '',
            createdAt: a.createdAt
          }));
        const targets = await hydrateTargets(list);
        return { targets, scope: 'page', total: targets.length, truncated: false };
      }
      const fq = filterQuery();
      const r = await api.matchAccounts({
        ...fq,
        alive:
          opts?.aliveOverride && opts.aliveOverride !== 'all'
            ? opts.aliveOverride
            : fq.alive,
        limit,
        requireSso
      });
      return {
        targets: r.items || [],
        scope: 'filter',
        total: r.total,
        truncated: r.truncated
      };
    }

    const list = filteredAccounts
      .filter((a) => (requireSso ? accountHasSso(a) : true))
      .slice(0, limit)
      .map((a) => ({
        id: a.id,
        email: a.email || '',
        password: a.password || '',
        sso: a.sso || '',
        createdAt: a.createdAt
      }));
    const targets = await hydrateTargets(list);
    return {
      targets,
      scope: 'local',
      total: filteredAccounts.length,
      truncated: filteredAccounts.length > targets.length
    };
  };

  const cancelVerify = () => {
    verifyAbortRef.current?.abort();
  };

  const targetVerdict = (row: { id: string }): ReturnType<typeof ssoCheckVerdict> => {
    const fromMap = ssoMap.get(row.id);
    if (fromMap) return ssoCheckVerdict(fromMap);
    const acc = accounts.find((a) => a.id === row.id);
    return ssoCheckVerdict(acc?.ssoCheck);
  };

  const verifyBatch = async (
    scope: 'page' | 'filter' = 'filter',
    opts?: { recheck?: VerifyRecheck }
  ) => {
    // 进行中再点主按钮 = 取消
    if (verifying) {
      cancelVerify();
      return;
    }

    const recheck: VerifyRecheck = opts?.recheck || 'all';
    const ac = new AbortController();
    verifyAbortRef.current = ac;
    setVerifying(true);
    setVerifyProg({
      total: 0,
      done: 0,
      alive: 0,
      dead: 0,
      unknown: 0,
      running: true,
      recheck
    });

    try {
      const { targets, truncated, total, scope: used } = await resolveActionTargets({
        scope: selected.size > 0 ? 'page' : scope,
        requireSso: true,
        limit: 500,
        aliveOverride: recheck === 'all' ? undefined : recheck
      });

      let list = targets;
      // 已选 / 本页 / 本地列表：客户端按 recheck 再筛
      if (
        recheck !== 'all' &&
        (selected.size > 0 || used === 'page' || used === 'selected' || used === 'local')
      ) {
        list = targets.filter((a) => targetVerdict(a) === recheck);
      }

      if (list.length === 0) {
        const tip =
          recheck === 'unchecked'
            ? '没有未验活的账号'
            : recheck === 'unknown'
              ? '没有验活未知的账号'
              : recheck === 'dead'
                ? '没有验活失效的账号'
                : '没有可验活的账号';
        push({ tone: 'warn', title: tip });
        setVerifyProg(null);
        return;
      }
      if (truncated && recheck === 'all') {
        push({
          tone: 'warn',
          title: `匹配 ${total} 条，本次只验前 ${list.length}`,
          description: '可缩小筛选后再试'
        });
      }

      const missingEmailBefore = list.filter((a) => !String(a.email || '').trim()).length;
      setVerifyProg({
        total: list.length,
        done: 0,
        alive: 0,
        dead: 0,
        unknown: 0,
        running: true,
        recheck,
        current: list[0]?.email || list[0]?.id
      });

      let alive = 0;
      let deadN = 0;
      let unknownN = 0;
      let emailsFilled = 0;
      let cancelled = false;
      const allResults: SsoCheckResult[] = [];

      for (let i = 0; i < list.length; i += VERIFY_CHUNK) {
        if (ac.signal.aborted) {
          cancelled = true;
          break;
        }
        const chunk = list.slice(i, i + VERIFY_CHUNK);
        setVerifyProg((p) =>
          p
            ? {
                ...p,
                current: chunk[0]?.email || chunk[0]?.id,
                running: true
              }
            : p
        );
        try {
          const results = await window.api.checkSso(
            chunk.map((a) => ({ id: a.id, sso: a.sso }))
          );
          applyResults(results);
          allResults.push(...results);
          for (const r of results) {
            if (r.alive === true) alive++;
            else if (r.alive === false) deadN++;
            else unknownN++;
          }
          const filled =
            typeof (results as { emailsFilled?: number }).emailsFilled === 'number'
              ? (results as { emailsFilled?: number }).emailsFilled!
              : results.filter((r) => {
                  const before = chunk.find((x) => x.id === r.id);
                  return (
                    before &&
                    !String(before.email || '').trim() &&
                    Boolean(String(r.email || '').trim())
                  );
                }).length;
          emailsFilled += filled;
        } catch (err) {
          if (ac.signal.aborted) {
            cancelled = true;
            break;
          }
          throw err;
        }

        const done = Math.min(i + chunk.length, list.length);
        setVerifyProg({
          total: list.length,
          done,
          alive,
          dead: deadN,
          unknown: unknownN,
          running: done < list.length && !ac.signal.aborted,
          recheck,
          current: chunk[chunk.length - 1]?.email || chunk[chunk.length - 1]?.id
        });
        if (ac.signal.aborted) {
          cancelled = true;
          break;
        }
      }

      try {
        await fetchList();
      } catch {
        /* applySsoResults 已写内存 */
      }

      const emailHint =
        emailsFilled > 0
          ? ` · 补邮箱 ${emailsFilled}` +
            (missingEmailBefore > emailsFilled
              ? `（${missingEmailBefore - emailsFilled} 条验活未返回邮箱）`
              : '（便于 Auth 按 email 回填 sso）')
          : missingEmailBefore > 0 && allResults.length > 0
            ? ' · 无邮箱号未补全（验活未返回 email 或已失效）'
            : '';
      const scopeHint =
        used === 'filter' ? ' · 筛后全部' : used === 'page' ? ' · 本页' : used === 'selected' ? ' · 已选' : '';
      const recheckHint =
        recheck === 'unchecked'
          ? ' · 仅未验'
          : recheck === 'unknown'
            ? ' · 仅未知'
            : recheck === 'dead'
              ? ' · 仅失效'
              : '';

      if (cancelled) {
        push({
          tone: 'warn',
          title: '验活已取消',
          description: `已完成 ${allResults.length}/${list.length} · 存活 ${alive} · 失效 ${deadN} · 未知 ${unknownN}${scopeHint}${recheckHint}${emailHint}`
        });
        setVerifyProg((p) => (p ? { ...p, running: false } : p));
      } else {
        push({
          tone: unknownN > 0 || deadN > 0 ? 'warn' : 'ok',
          title: '验活完成',
          description: `存活 ${alive} · 失效 ${deadN} · 未知 ${unknownN} / ${allResults.length}${scopeHint}${recheckHint}（已写入账号库 + 本机缓存）${emailHint}`
        });
        setVerifyProg({
          total: list.length,
          done: list.length,
          alive,
          dead: deadN,
          unknown: unknownN,
          running: false,
          recheck
        });
      }
      window.setTimeout(() => setVerifyProg(null), 4000);
    } catch (err) {
      push({ tone: 'danger', title: '批量验活失败', description: String(err) });
      setVerifyProg(null);
    } finally {
      setVerifying(false);
      verifyAbortRef.current = null;
    }
  };
  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) {
      push({ tone: 'warn', title: '请先勾选要删除的账号' });
      return;
    }
    if (!window.confirm(`确认删除 ${ids.length} 个账号？\n（仅删 SSO 列表记录，不删历史文件）`)) {
      return;
    }
    setDeleting(true);
    try {
      const r = await remove(ids);
      setSelected(new Set());
      push({
        tone: 'ok',
        title: '已删除',
        description: `删除 ${r.deleted} · 剩余 ${r.remaining}`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '删除失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setDeleting(false);
    }
  };

  /** 号池 SSO → 预检存活后 CPA auth 补 mint；分块并显示进度 */
  const mintAuthFromSso = async (scope: 'page' | 'filter' = 'filter') => {
    let targets: ActionTarget[] = [];
    try {
      const r = await resolveActionTargets({
        scope: selected.size > 0 ? 'page' : scope,
        requireSso: true,
        limit: 200
      });
      targets = r.targets;
      if (targets.length === 0) {
        push({ tone: 'warn', title: '没有可 mint 的 SSO' });
        return;
      }
      if (r.truncated) {
        push({
          tone: 'warn',
          title: `匹配 ${r.total} 条，本次只补签前 ${targets.length}`,
          description: '补签单次上限 200'
        });
      }
    } catch (err) {
      push({
        tone: 'danger',
        title: '加载筛选失败',
        description: err instanceof Error ? err.message : String(err)
      });
      return;
    }

    setMintProg({
      total: targets.length,
      done: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      banned: 0,
      running: true,
      current: targets[0]?.email || ''
    });

    let ok = 0;
    let failed = 0;
    let skipped = 0;
    let banned = 0;
    let probeDead = 0;
    let probeOk = 0;
    let noXai = 0;
    const allResults: CpaAuthBatchResultItem[] = [];

    try {
      for (let i = 0; i < targets.length; i += MINT_CHUNK) {
        const chunk = targets.slice(i, i + MINT_CHUNK);
        setMintProg((p) =>
          p
            ? {
                ...p,
                current: chunk[0]?.email || chunk[0]?.sso?.slice(0, 12) || '',
                running: true
              }
            : p
        );
        const r = await window.api.mintCpaAuthFromSso({
          items: chunk.map((a) => ({ sso: a.sso, email: a.email })),
          concurrency: Math.min(3, chunk.length),
          skipBotFlag1
        });
        allResults.push(...(r.results || []));
        ok += r.ok || 0;
        failed += r.failed || 0;
        skipped += r.skipped ?? r.results.filter((x) => x.skipped).length;
        banned += r.banned ?? r.results.filter((x) => x.verdict === 'banned').length;
        const botSkip =
          r.botFlagSkipped ?? r.results.filter((x) => x.verdict === 'bot_flag').length;
        skipped += 0; // keep skipped as server total
        probeDead += r.results.filter((x) => x.probeAction === 'dead' || x.probeDeleted).length;
        probeOk += r.results.filter((x) => x.probeAction === 'ok').length;
        noXai += r.results.filter((x) => x.ok && x.xai === false).length;
        // bot flag 计入 skipped 已由 r.skipped 包含
        void botSkip;

        const done = Math.min(i + chunk.length, targets.length);
        setMintProg({
          total: targets.length,
          done,
          ok,
          failed,
          skipped,
          banned,
          current: chunk[chunk.length - 1]?.email || '',
          running: done < targets.length
        });
      }

      const botFlagN = allResults.filter((x) => x.verdict === 'bot_flag').length;
      const remoteOkN = allResults.filter((x) => x.remoteOk === true).length;
      const remoteFailN = allResults.filter((x) => x.remoteOk === false).length;
      const remoteErrSample = allResults.find((x) => x.remoteOk === false)?.remoteError;
      const parts = [
        `成功 ${ok}`,
        `失败 ${failed}`,
        skipped ? `预检跳过 ${skipped}` : '',
        botFlagN ? `bot_flag=1 跳过 ${botFlagN}` : '',
        banned ? `封禁 ${banned}` : '',
        probeOk ? `CPA测活OK ${probeOk}` : '',
        probeDead ? `CPA测活挂 ${probeDead}` : '',
        noXai ? `无 xai ${noXai}` : ok > 0 ? '均含 xai' : '',
        remoteOkN ? `远程推送OK ${remoteOkN}` : '',
        remoteFailN
          ? `远程失败 ${remoteFailN}${remoteErrSample ? `（${remoteErrSample.slice(0, 80)}）` : ''}`
          : ''
      ].filter(Boolean);
      push({
        tone:
          failed > 0 || banned > 0 || probeDead > 0 || remoteFailN > 0
            ? 'warn'
            : ok > 0
              ? 'ok'
              : 'warn',
        title: 'SSO 补签 Auth 完成',
        description: parts.join(' · ')
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '补签 Auth 失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setMintProg((p) =>
        p
          ? {
              ...p,
              running: false,
              done: p.total,
              ok,
              failed,
              skipped,
              banned
            }
          : null
      );
      // 进度条保留几秒再收起
      window.setTimeout(() => setMintProg(null), 4000);
    }
  };

  const g2aReady = Boolean(
    (settings?.pushSsoToGrok2api === true ||
      settings?.autoPushSsoToGrok2api === true ||
      (settings?.pushSsoToGrok2api === undefined &&
        settings?.autoPushSsoToGrok2api === undefined &&
        settings?.grok2apiAutoUpload === true)) &&
      String(settings?.grok2apiUrl || '').trim() &&
      String(settings?.grok2apiUsername || '').trim() &&
      String(settings?.grok2apiPassword || '').trim()
  );

  /** 号池 SSO → grok2api（需推送设置开启 SSO→grok2api） */
  const pushG2aFromSso = async (scope: 'page' | 'filter' = 'filter') => {
    let targets: ActionTarget[] = [];
    try {
      const r = await resolveActionTargets({
        scope: selected.size > 0 ? 'page' : scope,
        requireSso: true,
        limit: 100
      });
      targets = r.targets;
      if (targets.length === 0) {
        push({ tone: 'warn', title: '没有可推送的 SSO' });
        return;
      }
      if (r.truncated) {
        push({
          tone: 'warn',
          title: `匹配 ${r.total} 条，本次只推前 ${targets.length}`,
          description: '推送单次上限 100'
        });
      }
    } catch (err) {
      push({
        tone: 'danger',
        title: '加载筛选失败',
        description: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    if (!g2aReady) {
      push({
        tone: 'warn',
        title: '未配置 SSO→grok2api',
        description: '请在设置「推送设置」开启 SSO→grok2api 允许/自动，并填写 grok2api 地址与账号'
      });
      return;
    }
    if (targets.length > 100) {
      push({ tone: 'warn', title: '单次最多 100 个', description: '请缩小选择范围后再试' });
      return;
    }
    setPushingG2a(true);
    try {
      const CHUNK = 8;
      let ok = 0;
      let failed = 0;
      let skipped = 0;
      let remoteUrl = '';
      for (let i = 0; i < targets.length; i += CHUNK) {
        const chunk = targets.slice(i, i + CHUNK);
        const r = await window.api.pushSsoToGrok2api({
          items: chunk.map((a) => ({ sso: a.sso, email: a.email, id: a.id })),
          concurrency: 1
        });
        ok += r.ok || 0;
        failed += r.failed || 0;
        skipped += r.skipped || 0;
        if (r.remoteUrl) remoteUrl = r.remoteUrl;
      }
      push({
        tone: failed > 0 ? 'warn' : 'ok',
        title: '推送 G2A 完成',
        description: `成功 ${ok} · 失败 ${failed}${skipped ? ` · 跳过 ${skipped}` : ''}${
          remoteUrl ? ` · ${remoteUrl}` : ''
        }`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '推送 G2A 失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setPushingG2a(false);
    }
  };

  const picked = accounts.filter((a) => selected.has(a.id));

  // 打开详情时拉完整密钥（列表分页不再下发 password/sso）
  useEffect(() => {
    if (!openId) {
      setDetailAccount(null);
      return;
    }
    let cancelled = false;
    const light = accounts.find((a) => a.id === openId) ?? null;
    setDetailAccount(light);
    const needsFull =
      light &&
      !String(light.password || '').trim() &&
      !String(light.sso || '').trim() &&
      (light.hasPassword === true || light.hasSso === true || light.hasPassword == null);
    if (!needsFull) return;
    const api = window.api as { getAccount?: (id: string) => Promise<AccountRecord> };
    if (!api.getAccount) return;
    void api
      .getAccount(openId)
      .then((full) => {
        if (!cancelled) setDetailAccount(full);
      })
      .catch(() => {
        /* 保留 light */
      });
    return () => {
      cancelled = true;
    };
  }, [openId, accounts]);
  const minting = !!mintProg?.running;
  const verifyPct =
    verifyProg && verifyProg.total > 0
      ? Math.min(100, Math.round((verifyProg.done / verifyProg.total) * 100))
      : 0;
  const busy = verifying || minting || deleting || importing || pushingG2a;
  const hasActiveFilter =
    authFilter !== 'all' ||
    aliveFilter !== 'all' ||
    ssoFilter !== 'all' ||
    Boolean(searchQuery.trim());

  const mintPct =
    mintProg && mintProg.total > 0
      ? Math.min(100, Math.round((mintProg.done / mintProg.total) * 100))
      : 0;

  return (
    <div className="space-y-5">
      <section className="rounded-[16px] border border-border bg-card p-2 shadow-[var(--ios-shadow)] sm:p-3">
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          <PoolMetric label="账号总量" value={String(poolTotal)} Icon={Database} />
          <PoolMetric label="含 SSO" value={String(ssoCount)} Icon={KeyRound} />
          <PoolMetric label="验活存活" value={aliveCount ? String(aliveCount) : '--'} Icon={ShieldCheck} />
          <PoolMetric
            label="最近时间"
            value={accounts[0] ? fmtBeijing(accounts[0].createdAt, false) : '--'}
            Icon={RefreshCcw}
          />
        </div>
      </section>

      {poolLoadError ? (
        <div className="rounded-[16px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px]">
          <div className="font-semibold text-destructive">号池加载失败</div>
          <p className="mt-1 break-all text-muted-foreground">{poolLoadError}</p>
          <Button
            type="button"
            size="sm"
            className="mt-2"
            onClick={() => void doReload(false)}
            disabled={loading}
          >
            <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            重试
          </Button>
        </div>
      ) : null}


      {verifyProg && (
        <div className="rounded-[16px] border border-sky-500/30 bg-sky-500/5 px-4 py-3 shadow-[var(--ios-shadow)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold tracking-tight">
                {verifyProg.running ? 'SSO 验活进行中' : 'SSO 验活已完成'}
                {verifyProg.recheck === 'unchecked'
                  ? ' · 仅未验'
                  : verifyProg.recheck === 'unknown'
                    ? ' · 仅未知'
                    : verifyProg.recheck === 'dead'
                      ? ' · 仅失效'
                      : ''}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {verifyProg.done}/{verifyProg.total}
                {verifyProg.current ? ` · 当前 ${verifyProg.current}` : ''}
                {` · 存活 ${verifyProg.alive} · 失效 ${verifyProg.dead} · 未知 ${verifyProg.unknown}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {verifyProg.running ? (
                <Button size="sm" variant="secondary" onClick={cancelVerify} title="取消剩余分块">
                  取消
                </Button>
              ) : null}
              <span className="chip tabular-nums">{verifyPct}%</span>
            </div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                verifyProg.running ? 'bg-sky-500' : 'bg-emerald-500'
              )}
              style={{ width: `${verifyPct}%` }}
            />
          </div>
        </div>
      )}
      {mintProg && (
        <div className="rounded-[16px] border border-primary/30 bg-primary/5 px-4 py-3 shadow-[var(--ios-shadow)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold tracking-tight">
                {mintProg.running ? '补签 Auth 进行中' : '补签 Auth 已完成'}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {mintProg.done}/{mintProg.total}
                {mintProg.current ? ` · 当前 ${mintProg.current}` : ''}
                {` · 成功 ${mintProg.ok} · 失败 ${mintProg.failed}`}
                {mintProg.skipped ? ` · 跳过 ${mintProg.skipped}` : ''}
                {mintProg.banned ? ` · 封禁 ${mintProg.banned}` : ''}
              </p>
            </div>
            <span className="chip tabular-nums">{mintPct}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                mintProg.running ? 'bg-primary' : 'bg-emerald-500'
              )}
              style={{ width: `${mintPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="ios-group">
        <div className="space-y-2.5 border-b border-border/70 px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-[17px] font-semibold tracking-[-0.02em]">账号列表</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {selected.size > 0 ? `已选 ${selected.size} 项` : '未选择'}
                {hasActiveFilter
                  ? ` · 筛选 ${totalForPager}/${poolTotal}`
                  : ` · 共 ${poolTotal}`}
                {serverPaged ? ' · 服务端分页' : fullListMode ? ' · 全量' : ''}
                {lastRefresh ? ` · 刷新于 ${fmtBeijingTime(lastRefresh)}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={toggleEmailPrivacy}
                title={emailMasked ? '显示完整邮箱' : '遮蔽邮箱（仅前5位）'}
              >
                {emailMasked ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                {emailMasked ? '显示邮箱' : '遮蔽邮箱'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void doReload(true)}
                disabled={loading || busy}
                title="重新扫描 SSO 历史并刷新列表"
              >
                <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                刷新
              </Button>
            </div>
          </div>

          {/* 筛选：统一分段胶囊轨 */}
          <FilterBar
            hasActive={hasActiveFilter}
            onClear={() => {
              changeSsoFilter('all');
              changeAuthFilter('all');
              changeAliveFilter('all');
              setSearchQuery('');
            }}
          >
            <div className="relative w-full min-w-[12rem] max-w-xs sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  resetPage();
                }}
                placeholder="搜索邮箱 / SSO / ID…"
                className="h-8 w-full rounded-full border border-border/70 bg-background/80 py-1 pl-8 pr-3 text-[12px] tracking-tight placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                spellCheck={false}
              />
            </div>
            <FilterSegmentGroup
              label="SSO"
              value={ssoFilter}
              onChange={changeSsoFilter}
              options={[
                { id: 'all', label: '全部', count: poolTotal, title: '不限制是否有 SSO' },
                { id: 'has_sso', label: '有SSO', count: ssoCount, title: '含 SSO，可验活/补签 Auth' },
                { id: 'no_sso', label: '无SSO', count: noSsoCount, title: '无 SSO 的账号' }
              ]}
            />
            <FilterSegmentGroup
              label="Auth"
              value={authFilter}
              onChange={changeAuthFilter}
              options={[
                {
                  id: 'all',
                  label: '全部',
                  count: poolTotal,
                  title: '不限制 Auth 转换状态'
                },
                {
                  id: 'unconverted',
                  label: '未转',
                  count: unconvertedCount,
                  title: '尚未转 Auth（服务端按 email/ssoHash 匹配）'
                },
                {
                  id: 'converted',
                  label: '已转',
                  count: convertedCount,
                  title: '已匹配 Auth（email 或 SSO 哈希）'
                }
              ]}
            />
            <FilterSegmentGroup
              label="验活"
              value={aliveFilter}
              onChange={changeAliveFilter}
              options={[
                { id: 'all', label: '全部', count: poolTotal, title: '不限制验活状态' },
                { id: 'unchecked', label: 'None', count: uncheckedCount, title: '尚未验活', tone: 'muted' },
                { id: 'alive', label: 'Live', count: aliveOnlyCount, title: '验活存活', tone: 'ok' },
                { id: 'dead', label: 'Dead', count: deadOnlyCount, title: '验活失效(401/403)', tone: 'danger' },
                { id: 'unknown', label: 'Unkn', count: unknownOnlyCount, title: '验活未知(网络/超时/429等)', tone: 'muted' }
              ]}
            />
          </FilterBar>

          {/* 操作：一行优先折行，标签仅宽屏显示 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 hidden text-[10px] font-semibold tracking-wide text-primary xl:inline">选择</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={selectAll}
                disabled={(serverPaged ? pageAccounts.length === 0 : filteredAccounts.length === 0) || busy}
                title={
                  serverPaged
                    ? '分页模式下「全选」= 本页（避免假全选）'
                    : '选择当前筛选结果全部'
                }
              >
                {allSelected || (serverPaged && pageAllSelected) ? (
                  <CheckSquare className="h-3.5 w-3.5" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
                {allSelected || (serverPaged && pageAllSelected)
                  ? serverPaged
                    ? '取消本页'
                    : '取消全选'
                  : serverPaged
                    ? '本页全选'
                    : '全选'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={selectPage}
                disabled={pageAccounts.length === 0 || busy}
                title="仅选择当前分页"
              >
                <ListChecks className="h-3.5 w-3.5" />
                {pageAllSelected ? '取消本页' : '本页'}
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <span className="mr-0.5 hidden text-[10px] font-semibold tracking-wide text-primary sm:inline">业务</span>
              <Button
                size="sm"
                variant={verifying ? 'danger' : 'primary'}
                onClick={() =>
                  verifying
                    ? cancelVerify()
                    : void verifyBatch(selected.size > 0 ? 'page' : 'filter')
                }
                disabled={
                  (!verifying && busy) ||
                  (!verifying &&
                    (serverPaged
                      ? totalForPager === 0 && pageAccounts.length === 0
                      : filteredAccounts.length === 0))
                }
                title={
                  verifying
                    ? '取消剩余验活分块'
                    : selected.size > 0
                      ? '验活已选（分块进度，可取消）'
                      : serverPaged
                        ? '验活当前筛选下全部匹配（最多 500，分块进度）'
                        : '验活当前列表（分块进度，可取消）'
                }
              >
                <ShieldCheck className={cn('h-3.5 w-3.5', verifying && 'animate-pulse')} />
                {verifying
                  ? `取消 ${verifyProg?.done ?? 0}/${verifyProg?.total ?? 0}`
                  : selected.size > 0
                    ? `验活(${selected.size})`
                    : serverPaged
                      ? hasActiveFilter
                        ? `验活筛选(${totalForPager})`
                        : `验活全部(${poolTotal})`
                      : hasActiveFilter
                        ? `验活(${filteredAccounts.length})`
                        : '验活全部'}
              </Button>
              {serverPaged && selected.size === 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void verifyBatch('page')}
                  disabled={busy || pageAccounts.length === 0}
                  title="仅验活当前页（分块进度）"
                >
                  验活本页
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void verifyBatch(selected.size > 0 ? 'page' : 'filter', { recheck: 'unchecked' })
                }
                disabled={busy}
                title="仅验尚未验活的账号（None）"
              >
                仅未验{uncheckedCount > 0 ? `(${uncheckedCount})` : ''}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void verifyBatch(selected.size > 0 ? 'page' : 'filter', { recheck: 'unknown' })
                }
                disabled={busy}
                title="仅复检验活未知（网络/超时/429 等）"
              >
                复检Unkn{unknownOnlyCount > 0 ? `(${unknownOnlyCount})` : ''}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void verifyBatch(selected.size > 0 ? 'page' : 'filter', { recheck: 'dead' })
                }
                disabled={busy}
                title="仅复检验活失效（401/403）"
              >
                复检Dead{deadOnlyCount > 0 ? `(${deadOnlyCount})` : ''}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void mintAuthFromSso(selected.size > 0 ? 'page' : 'filter')}
                disabled={
                  busy ||
                  (serverPaged
                    ? totalForPager === 0 && pageAccounts.length === 0
                    : filteredAccounts.length === 0)
                }
                title={
                  skipBotFlag1
                    ? '预检存活 + 跳过 bot_flag=1 后 mint；筛后全部最多 200'
                    : '预检存活后 mint；筛后全部最多 200'
                }
              >
                <Wand2 className={cn('h-3.5 w-3.5', minting && 'animate-pulse')} />
                {minting
                  ? `Mint ${mintProg?.done ?? 0}/${mintProg?.total ?? 0}`
                  : selected.size > 0
                    ? `补签 Auth(${picked.filter((a) => a.sso).length})`
                    : serverPaged
                      ? hasActiveFilter
                        ? `补签筛选`
                        : '补签全部'
                      : hasActiveFilter
                        ? `补签 Auth(${filteredAccounts.filter((a) => a.sso).length})`
                        : '补签 Auth'}
              </Button>
              <Button
                variant={skipBotFlag1 ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  setSkipBotFlag1((v) => {
                    const next = !v;
                    try {
                      localStorage.setItem('gra-skip-bot-flag1', next ? '1' : '0');
                    } catch {
                      /* ignore */
                    }
                    return next;
                  });
                }}
                title={
                  skipBotFlag1
                    ? '已开启：补签 Auth 跳过 Bot（bot_flag=1）· 点击关闭'
                    : '已关闭：补签 Auth 不跳过 Bot · 点击开启（开启为蓝色）'
                }
              >
                <Bot className="h-3.5 w-3.5" />
                跳过 Bot
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 hidden text-[10px] font-semibold tracking-wide text-primary xl:inline">
                导入导出
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setImportOpen(true)}
                disabled={busy}
                title="粘贴或上传 SSO 导入列表"
              >
                <FileUp className="h-3.5 w-3.5" />
                导入SSO
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.log,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  e.target.value = '';
                  void onPickImportFile(f);
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void exportByScope(selected.size > 0 ? 'page' : 'filter')}
                disabled={
                  busy ||
                  (serverPaged
                    ? totalForPager === 0 && pageAccounts.length === 0
                    : filteredAccounts.length === 0)
                }
                title={
                  picked.length > 0
                    ? `导出已选账号（email|password|sso，共 ${picked.length}）`
                    : serverPaged
                      ? '导出当前筛选全部（服务端，最多 2000）'
                      : hasActiveFilter
                        ? '导出当前筛选账号'
                        : '导出账号：email | password | sso'
                }
              >
                <FileDown className="h-3.5 w-3.5" />
                {picked.length > 0
                  ? `导出(${picked.length})`
                  : serverPaged
                    ? hasActiveFilter
                      ? `导出筛选(${totalForPager})`
                      : `导出全部(${poolTotal})`
                    : hasActiveFilter
                      ? '导出筛选'
                      : '导出账号'}
              </Button>
                            <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void exportSsoCheckCsv(selected.size > 0 ? 'page' : 'filter')
                }
                disabled={
                  busy ||
                  (serverPaged
                    ? totalForPager === 0 && pageAccounts.length === 0
                    : filteredAccounts.length === 0)
                }
                title="导出验活 CSV：email,password,sso,verdict,alive,status,checkedAt,error"
              >
                <FileDown className="h-3.5 w-3.5" />
                导出验活
              </Button>
{serverPaged && selected.size === 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void exportByScope('page')}
                  disabled={busy || pageAccounts.length === 0}
                  title="仅导出当前页"
                >
                  导出本页
                </Button>
              ) : null}
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void deleteSelected()}
                disabled={busy || selected.size === 0}
                title="从列表删除已选"
              >
                <Trash2 className={cn('h-3.5 w-3.5', deleting && 'animate-pulse')} />
                {deleting ? '删除中…' : `删除(${selected.size})`}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {poolTotal === 0 && accounts.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          还没有账号。到「注册机」跑一轮任务即可出现在这里。
        </div>
      ) : totalForPager === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          <p>
            当前筛选下没有账号。
            {ssoFilter === 'no_sso'
              ? ' 全部账号均含 SSO。'
              : ssoFilter === 'has_sso'
                ? ' 没有含 SSO 的账号。'
                : authFilter === 'converted'
                  ? ' 没有已转换 Auth 的账号。'
                  : authFilter === 'unconverted'
                    ? ' 没有未转换的账号。'
                    : aliveFilter === 'unchecked'
                      ? ' 没有未验活账号。'
                      : aliveFilter === 'alive'
                        ? ' 没有标记为存活的账号。'
                        : aliveFilter === 'dead'
                          ? ' 没有标记为失效的账号。'
                          : ''}
          </p>
          {hasActiveFilter && (
            <div className="mt-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  changeSsoFilter('all');
                  changeAuthFilter('all');
                  changeAliveFilter('all');
                }}
              >
                清空筛选
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pageAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                checked={selected.has(a.id)}
                ssoResult={ssoMap.get(a.id)}
                emailMasked={emailMasked}
                authConverted={isAuthConverted(a)}
                authChannel={authChannelOf(a)}
                authBotFlag={authBotFlagOf(a)}
                onToggle={() => toggle(a.id)}
                onOpen={() => setOpenId(a.id)}
              />
            ))}
          </div>

          <PaginationBar
            page={currentPage}
            totalPages={totalPages}
            rangeFrom={rangeFrom}
            rangeTo={rangeTo}
            total={totalForPager}
            pageSize={pageSize}
            onChange={setPage}
            onPageSizeChange={changePageSize}
          />
        </>
      )}

      <AccountDetailDrawer
        account={detailAccount}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        ssoResult={openId ? ssoMap.get(openId) : undefined}
        onSsoResult={(r) => applyResults([r])}
      />

      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div
            className="absolute inset-0"
            onClick={() => !importing && setImportOpen(false)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-xl rounded-2xl border border-border bg-card p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-[16px] font-semibold tracking-tight">导入 SSO</h3>
                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                  每行一条，支持：
                  <br />
                  <code className="text-[11px]">email | password | sso</code>
                  <br />
                  <code className="text-[11px]">email----password----sso</code>
                  <br />
                  <code className="text-[11px]">纯 JWT</code> / <code className="text-[11px]">sso=...</code>
                  <br />
                  按 SSO 去重；# 开头行为注释。
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => !importing && setImportOpen(false)}
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={importDraft}
              onChange={(e) => setImportDraft(e.target.value)}
              rows={12}
              placeholder="粘贴 SSO 列表…"
              className="w-full resize-y rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] outline-none focus:border-primary"
              disabled={importing}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="h-3.5 w-3.5" />
                选择文件
              </Button>
              <div className="flex gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importing}
                  onClick={() => {
                    setImportOpen(false);
                    setImportDraft('');
                  }}
                >
                  取消
                </Button>
                <Button size="sm" disabled={importing || !importDraft.trim()} onClick={() => void doImport()}>
                  {importing ? '导入中…' : '确认导入'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountCard({
  account,
  checked,
  ssoResult,
  emailMasked,
  authConverted,
  authChannel,
  authBotFlag,
  onToggle,
  onOpen
}: {
  account: AccountRecord;
  checked: boolean;
  ssoResult?: SsoCheckResult;
  emailMasked: boolean;
  authConverted: boolean;
  /** A=PKCE / B=Device / AB=双通道 */
  authChannel: 'A' | 'B' | 'AB' | null;
  /** 匹配 Auth 文件的 bot_flag（SSO JWT 无 claim 时回退） */
  authBotFlag: { botFlagSource: number | string | null; isBotFlag1: boolean } | null;
  onToggle(): void;
  onOpen(): void;
}) {
  const [showPw, setShowPw] = useState(false);
  const [showSso, setShowSso] = useState(false);
  const push = useToastStore((s) => s.push);

  const copy = async (value: string, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      push({ tone: 'ok', title: `已复制${label}` });
    } catch {
      push({ tone: 'danger', title: '复制失败' });
    }
  };

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const emailDisplay = maskEmail(account.email, emailMasked, { empty: '(无邮箱)' });
  // 列表轻字段无 SSO 全文：优先验活 → Auth badge；有全文 sso 时再读 JWT
  const localFlag = account.sso ? readBotFlagFromSso(account.sso) : { botFlagSource: null, isBotFlag1: false };
  const hasSsoFlag =
    ssoResult != null &&
    ssoResult.botFlagSource !== undefined &&
    ssoResult.botFlagSource !== null &&
    ssoResult.botFlagSource !== '';
  const hasLocalFlag =
    Boolean(account.sso) &&
    localFlag.botFlagSource !== undefined &&
    localFlag.botFlagSource !== null &&
    localFlag.botFlagSource !== '';
  const hasAuthFlag =
    authBotFlag != null &&
    authBotFlag.botFlagSource !== undefined &&
    authBotFlag.botFlagSource !== null &&
    authBotFlag.botFlagSource !== '';
  let flagSource: number | string | null = null;
  let flagIs1 = false;
  let flagFrom: 'probe' | 'sso' | 'auth' | 'none' = 'none';
  if (hasSsoFlag) {
    flagSource = ssoResult!.botFlagSource as number | string;
    flagIs1 =
      ssoResult!.isBotFlag1 === true ||
      ssoResult!.botFlagSource === 1 ||
      ssoResult!.botFlagSource === '1';
    flagFrom = 'probe';
  } else if (hasLocalFlag) {
    flagSource = localFlag.botFlagSource;
    flagIs1 = localFlag.isBotFlag1;
    flagFrom = 'sso';
  } else if (hasAuthFlag) {
    flagSource = authBotFlag!.botFlagSource;
    flagIs1 = authBotFlag!.isBotFlag1;
    flagFrom = 'auth';
  }

  const hasPw =
    account.hasPassword === true || Boolean(String(account.password || '').trim());
  const hasSsoField =
    account.hasSso === true || Boolean(String(account.sso || '').trim());

  const ensureSecret = async (kind: 'password' | 'sso'): Promise<string> => {
    const cur = kind === 'password' ? account.password : account.sso;
    if (String(cur || '').trim()) return String(cur);
    const api = window.api as { getAccount?: (id: string) => Promise<AccountRecord> };
    if (!api.getAccount) return '';
    try {
      const full = await api.getAccount(account.id);
      return kind === 'password' ? String(full.password || '') : String(full.sso || '');
    } catch {
      return '';
    }
  };

  return (
    <div
      onClick={onOpen}
      className={cn(
        'flex cursor-pointer flex-col gap-3 rounded-[16px] border bg-card p-4 shadow-[var(--ios-shadow)] transition-colors hover:border-primary/40',
        checked ? 'border-primary/60 bg-primary/5' : 'border-border'
      )}
    >
      <div className="flex items-start gap-3">
        <Switch
          className="mt-0.5"
          size="sm"
          checked={checked}
          onChange={() => onToggle()}
          onClick={stop}
          aria-label={`选择 ${account.email || account.id}`}
        />
        <div className="min-w-0 flex-1">
          <div
            className="break-all text-sm font-semibold leading-5 tracking-tight"
            title={emailMasked && account.email ? '已遮蔽 · 点工具栏「显示邮箱」查看完整' : account.email || undefined}
          >
            {emailDisplay}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{fmtBeijing(account.createdAt)}</div>
          {/* tags：与邮箱左对齐（不顶到 Switch 列） */}
          <div
            className="mt-2 flex flex-wrap items-center gap-1.5 leading-none"
            onClick={stop}
          >
            <AuthConvertedBadge converted={authConverted} channel={authChannel} />
            <SsoBadge result={ssoResult} />
            <NsfwBadge
              status={
                account.nsfwStatus ??
                (account.nsfwAttempted
                  ? account.nsfwEnabled
                    ? 'ok'
                    : 'fail'
                  : 'none')
              }
              error={account.nsfwError}
            />
            <span
              className="inline-flex"
              title={
                flagFrom === 'auth'
                  ? 'bot_flag 来自匹配的 Auth 文件（SSO JWT 无 claim）'
                  : flagFrom === 'probe'
                    ? 'bot_flag 来自验活结果'
                    : flagFrom === 'sso'
                      ? 'bot_flag 来自 SSO JWT'
                      : undefined
              }
            >
              <BotFlagBadge flag={flagSource} is1={flagIs1} missing="muted" />
            </span>
            <PushChannelBadge
              channel="G2A"
              pushed={(account.ssoG2Status ?? 'none') === 'ok'}
              at={account.ssoG2At}
            />
          </div>
        </div>
      </div>

      <SecretRow
        label="密码"
        value={
          account.password
            ? account.password
            : hasPw
              ? showPw
                ? '（点复制或打开详情）'
                : '••••••••'
              : ''
        }
        reveal={showPw}
        onToggleReveal={() => setShowPw((v) => !v)}
        onCopy={() =>
          void ensureSecret('password').then((v) => {
            if (!v) push({ tone: 'warn', title: '无密码' });
            else void copy(v, '密码');
          })
        }
        onClick={stop}
      />
      <SecretRow
        label="SSO"
        value={
          account.sso
            ? account.sso
            : hasSsoField
              ? showSso
                ? '（点复制或打开详情）'
                : '••••••••'
              : ''
        }
        reveal={showSso}
        onToggleReveal={() => setShowSso((v) => !v)}
        onCopy={() =>
          void ensureSecret('sso').then((v) => {
            if (!v) push({ tone: 'warn', title: '无 SSO' });
            else void copy(v, 'SSO');
          })
        }
        onClick={stop}
        mono
      />
    </div>
  );
}

function SecretRow({
  label,
  value,
  reveal,
  onToggleReveal,
  onCopy,
  onClick,
  mono
}: {
  label: string;
  value: string;
  reveal: boolean;
  onToggleReveal(): void;
  onCopy(): void;
  onClick(e: React.MouseEvent): void;
  mono?: boolean;
}) {
  const display = !value
    ? '—'
    : reveal
      ? value
      : label === 'SSO'
        ? `${value.slice(0, 8)}…${value.slice(-6)}`
        : '••••••••';
  return (
    <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-2.5 py-1.5" onClick={onClick}>
      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12px]',
          mono && 'font-mono',
          !value && 'text-muted-foreground'
        )}
        title={reveal && value ? value : undefined}
      >
        {display}
      </span>
      {value ? (
        <>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            onClick={onToggleReveal}
            title={reveal ? '隐藏' : '显示'}
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            onClick={onCopy}
            title="复制"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </>
      ) : null}
    </div>
  );
}

function AuthConvertedBadge({
  converted,
  channel
}: {
  converted: boolean;
  channel?: 'A' | 'B' | 'AB' | null;
}) {
  if (converted || channel) {
    const tag =
      channel === 'AB' ? 'Auth AB' : channel === 'B' ? 'Auth B' : 'Auth A';
    const title =
      channel === 'AB'
        ? '已转双通道：A=PKCE + B=Device（两份 auth 互不影响）'
        : channel === 'B'
          ? '已转 Auth B（Device Flow）'
          : '已转 Auth A（Auth Code+PKCE）';
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center rounded-full bg-sky-500/15 px-2 text-[10px] font-medium leading-none text-sky-600 dark:text-sky-400"
        title={title}
      >
        {tag}
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-2 text-[10px] font-medium leading-none text-muted-foreground"
      title="未匹配：邮箱与 Auth 目录均无对应，且 SSO 哈希未命中（auth 需含 sso 字段）"
    >
      None
    </span>
  );
}

function SsoBadge({ result }: { result?: SsoCheckResult }) {
  // 测活 tag：4 字英文首字母大写 Live / Dead / None
  if (!result) {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-2 text-[10px] font-medium leading-none text-muted-foreground"
        title="尚未对本账号执行 SSO 验活；验活后会本地保存，切换页面不丢失"
      >
        None
      </span>
    );
  }
  const when = result.checkedAt ? ` · ${fmtBeijing(result.checkedAt)}` : '';
  const verdict = ssoCheckVerdict({ alive: result.alive, status: result.status });
  if (verdict === 'alive') {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center rounded-full bg-emerald-500/15 px-2 text-[10px] font-medium leading-none text-emerald-600 dark:text-emerald-400"
        title={`Live · 存活${when}`}
      >
        Live
      </span>
    );
  }
  if (verdict === 'unknown') {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center rounded-full bg-amber-500/15 px-2 text-[10px] font-medium leading-none text-amber-700 dark:text-amber-400"
        title={(result.error || 'Unkn · 未知(网络/超时/429等)') + when}
      >
        Unkn
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded-full bg-destructive/15 px-2 text-[10px] font-medium leading-none text-destructive"
      title={(result.error || 'Dead · 失效(401/403)') + when}
    >
      Dead
    </span>
  );
}

function PoolMetric({
  label,
  value,
  Icon
}: {
  label: string;
  value: string;
  Icon: typeof Database;
}) {
  return (
    <div className="min-w-0 rounded-[12px] border border-border/70 bg-muted/40 px-2.5 py-2.5 sm:px-3 sm:py-3">
      <div className="flex items-center justify-between gap-1.5">
        <p className="truncate text-[11px] text-muted-foreground sm:text-[12px]">{label}</p>
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80 sm:h-4 sm:w-4" />
      </div>
      <p className="mt-1.5 truncate text-[18px] font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-[22px]">
        {value}
      </p>
    </div>
  );
}

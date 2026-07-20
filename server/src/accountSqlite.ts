/**
 * 号池 SQLite 侧车（经 Python gra_store_cli → gra_store.sqlite accounts 表）。
 * 失败时返回 null，由 accountStore 回退 accounts.json。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AccountRecord } from '@shared/runEvents';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';

function runCli(
  cmd: string,
  body?: Record<string, unknown>
): { ok: boolean; data?: unknown; error?: string } | null {
  try {
    const rt = resolveRegisterRuntime({});
    if (!rt?.registerDir || !rt.pythonPath) return null;
    const script = join(rt.registerDir, 'gra_store_cli.py');
    if (!existsSync(script)) return null;
    const input = body ? JSON.stringify(body) : '';
    const r = spawnSync(rt.pythonPath, [script, cmd], {
      cwd: rt.registerDir,
      input,
      encoding: 'utf-8',
      // 万级号池 dump/replace 可能较慢
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        DATA_DIR: String(process.env.DATA_DIR || '/data'),
        PYTHONIOENCODING: 'utf-8'
      }
    });
    const text = String(r.stdout || '').trim();
    if (!text) {
      const err = String(r.stderr || r.error || '').trim();
      if (err) console.warn('[accountSqlite] empty stdout', cmd, err.slice(0, 200));
      return null;
    }
    const parsed = JSON.parse(text) as { ok?: boolean; data?: unknown; error?: string };
    return {
      ok: Boolean(parsed.ok),
      data: parsed.data,
      error: parsed.error
    };
  } catch (e) {
    console.warn('[accountSqlite] cli failed', cmd, e);
    return null;
  }
}

function isRecord(v: unknown): v is AccountRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.email === 'string' &&
    typeof o.password === 'string' &&
    typeof o.sso === 'string' &&
    typeof o.createdAt === 'string'
  );
}

export function sqliteAccountsAvailable(): boolean {
  const r = runCli('count_accounts');
  return Boolean(r?.ok);
}

export function sqliteCountAccounts(): number | null {
  const r = runCli('count_accounts');
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const n = Number((r.data as { count?: number }).count);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export function sqliteDumpAccounts(): AccountRecord[] | null {
  const r = runCli('dump_accounts');
  if (!r?.ok || !Array.isArray(r.data)) return null;
  return (r.data as unknown[]).filter(isRecord);
}

export function sqliteGetAccount(id: string): AccountRecord | null {
  const r = runCli('get_account', { id });
  if (!r?.ok) return null;
  if (r.data == null) return null;
  return isRecord(r.data) ? r.data : null;
}

export function sqliteReplaceAccounts(items: AccountRecord[]): boolean {
  const r = runCli('replace_accounts', { items });
  return Boolean(r?.ok);
}

export function sqliteUpsertAccount(account: AccountRecord): boolean {
  const r = runCli('upsert_account', { account });
  return Boolean(r?.ok);
}

/** 批量 upsert（一次 spawn + 一次事务） */
export function sqliteUpsertAccounts(items: AccountRecord[]): number | null {
  if (!items.length) return 0;
  const r = runCli('upsert_accounts', { items });
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const n = Number((r.data as { count?: number }).count);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export function sqliteDeleteAccounts(ids: string[]): number | null {
  const r = runCli('delete_accounts', { ids });
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const n = Number((r.data as { deleted?: number }).deleted);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** health 用：短缓存 count，避免 30s 轮询每次 spawn */
let countCache: { at: number; n: number | null } | null = null;
const COUNT_CACHE_TTL_MS = 20_000;

export function sqliteCountAccountsCached(): number | null {
  const now = Date.now();
  if (countCache && now - countCache.at < COUNT_CACHE_TTL_MS) {
    return countCache.n;
  }
  const n = sqliteCountAccounts();
  countCache = { at: now, n };
  return n;
}

export function invalidateSqliteCountCache(): void {
  countCache = null;
}

/** 启动时：JSON → SQLite 一次性迁移（仅当 SQLite 空且 JSON 有数据） */
export function migrateJsonToSqliteIfNeeded(
  jsonAccounts: AccountRecord[]
): { migrated: boolean; count: number; error?: string } {
  if (!jsonAccounts.length) return { migrated: false, count: 0 };
  const cnt = sqliteCountAccounts();
  if (cnt == null) return { migrated: false, count: 0, error: 'sqlite unavailable' };
  if (cnt > 0) return { migrated: false, count: cnt };
  const ok = sqliteReplaceAccounts(jsonAccounts);
  if (!ok) return { migrated: false, count: 0, error: 'replace failed' };
  console.log(`[accountSqlite] migrated ${jsonAccounts.length} accounts from accounts.json → SQLite`);
  return { migrated: true, count: jsonAccounts.length };
}

export type SqliteQueryPage = {
  items: AccountRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: {
    all: number;
    hasSso: number;
    noSso: number;
    unchecked: number;
    alive: number;
    dead: number;
    authConverted: number;
    authUnconverted: number;
  };
};

export type SqliteMatchResult = {
  items: {
    id: string;
    email: string;
    password: string;
    sso: string;
    createdAt: string;
  }[];
  total: number;
  returned: number;
  truncated: boolean;
  limit: number;
};

/** SQL 分页筛选（auth 交叉由 Node 传入 emails/hashes） */
export function sqliteQueryAccounts(opts: {
  page?: number;
  pageSize?: number;
  q?: string;
  sso?: string;
  alive?: string;
  auth?: string;
  authEmails?: string[];
  authHashes?: string[];
}): SqliteQueryPage | null {
  const r = runCli('query_accounts', {
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 20,
    q: opts.q || '',
    sso: opts.sso || 'all',
    alive: opts.alive || 'all',
    auth: opts.auth || 'all',
    authEmails: opts.authEmails || [],
    authHashes: opts.authHashes || []
  });
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const d = r.data as Record<string, unknown>;
  const items = Array.isArray(d.items) ? (d.items as unknown[]).filter(isRecord) : [];
  const facetsRaw = (d.facets && typeof d.facets === 'object' ? d.facets : {}) as Record<
    string,
    number
  >;
  return {
    items,
    total: Number(d.total) || 0,
    page: Number(d.page) || 1,
    pageSize: Number(d.pageSize) || 20,
    totalPages: Number(d.totalPages) || 1,
    facets: {
      all: Number(facetsRaw.all) || 0,
      hasSso: Number(facetsRaw.hasSso) || 0,
      noSso: Number(facetsRaw.noSso) || 0,
      unchecked: Number(facetsRaw.unchecked) || 0,
      alive: Number(facetsRaw.alive) || 0,
      dead: Number(facetsRaw.dead) || 0,
      authConverted: Number(facetsRaw.authConverted) || 0,
      authUnconverted: Number(facetsRaw.authUnconverted) || 0
    }
  };
}

export function sqliteMatchAccounts(opts: {
  q?: string;
  sso?: string;
  alive?: string;
  auth?: string;
  limit?: number;
  requireSso?: boolean;
  authEmails?: string[];
  authHashes?: string[];
}): SqliteMatchResult | null {
  const r = runCli('match_accounts', {
    q: opts.q || '',
    sso: opts.sso || 'all',
    alive: opts.alive || 'all',
    auth: opts.auth || 'all',
    limit: opts.limit ?? 500,
    requireSso: Boolean(opts.requireSso),
    authEmails: opts.authEmails || [],
    authHashes: opts.authHashes || []
  });
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const d = r.data as Record<string, unknown>;
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const items: SqliteMatchResult['items'] = [];
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    items.push({
      id: o.id,
      email: String(o.email || ''),
      password: String(o.password || ''),
      sso: String(o.sso || ''),
      createdAt: String(o.createdAt || '')
    });
  }
  return {
    items,
    total: Number(d.total) || 0,
    returned: Number(d.returned) || items.length,
    truncated: Boolean(d.truncated),
    limit: Number(d.limit) || opts.limit || 500
  };
}

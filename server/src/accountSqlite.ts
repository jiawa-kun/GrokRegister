/**
 * 号池 SQLite 侧车（Python gra_store）。
 * 优先长驻 worker（NDJSON）；失败回退 spawnSync CLI。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AccountRecord } from '@shared/runEvents';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';

type CliResult = { ok: boolean; data?: unknown; error?: string };

function resolvePaths(): { pythonPath: string; registerDir: string; worker: string; cli: string } | null {
  const rt = resolveRegisterRuntime({});
  if (!rt?.registerDir || !rt.pythonPath) return null;
  const worker = join(rt.registerDir, 'gra_store_worker.py');
  const cli = join(rt.registerDir, 'gra_store_cli.py');
  if (!existsSync(cli) && !existsSync(worker)) return null;
  return { pythonPath: rt.pythonPath, registerDir: rt.registerDir, worker, cli };
}

function envForPython(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATA_DIR: String(process.env.DATA_DIR || '/data'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1'
  };
}

/** ---------- 长驻 worker ---------- */
let workerProc: ChildProcessWithoutNullStreams | null = null;
let workerBuf = '';
let reqSeq = 1;
const pending = new Map<
  number,
  { resolve: (v: CliResult) => void; timer: ReturnType<typeof setTimeout> }
>();
let starting: Promise<boolean> | null = null;

function killWorker(): void {
  if (workerProc) {
    try {
      workerProc.stdin.write(JSON.stringify({ id: 0, cmd: 'quit', body: {} }) + '\n');
    } catch {
      /* ignore */
    }
    try {
      workerProc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  workerProc = null;
  workerBuf = '';
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error: 'worker killed' });
  }
  pending.clear();
}

function ensureWorker(): Promise<boolean> {
  if (workerProc && !workerProc.killed) return Promise.resolve(true);
  if (starting) return starting;
  starting = new Promise((resolve) => {
    const paths = resolvePaths();
    if (!paths || !existsSync(paths.worker)) {
      starting = null;
      resolve(false);
      return;
    }
    try {
      const proc = spawn(paths.pythonPath, [paths.worker], {
        cwd: paths.registerDir,
        env: envForPython(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      workerProc = proc;
      workerBuf = '';
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk: string) => {
        workerBuf += chunk;
        let idx: number;
        while ((idx = workerBuf.indexOf('\n')) >= 0) {
          const line = workerBuf.slice(0, idx).trim();
          workerBuf = workerBuf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as {
              id?: number;
              ok?: boolean;
              data?: unknown;
              error?: string;
            };
            const id = Number(msg.id);
            const wait = pending.get(id);
            if (wait) {
              clearTimeout(wait.timer);
              pending.delete(id);
              wait.resolve({
                ok: Boolean(msg.ok),
                data: msg.data,
                error: msg.error
              });
            }
          } catch {
            /* ignore bad line */
          }
        }
      });
      proc.stderr.on('data', (c: Buffer | string) => {
        const t = String(c || '').trim();
        if (t) console.warn('[accountSqlite:worker]', t.slice(0, 300));
      });
      proc.on('exit', () => {
        killWorker();
      });
      proc.on('error', () => {
        killWorker();
      });
      // ping
      const id = reqSeq++;
      const timer = setTimeout(() => {
        pending.delete(id);
        killWorker();
        starting = null;
        resolve(false);
      }, 8000);
      pending.set(id, {
        resolve: (r) => {
          starting = null;
          resolve(Boolean(r.ok));
        },
        timer
      });
      proc.stdin.write(JSON.stringify({ id, cmd: 'ping', body: {} }) + '\n');
    } catch {
      starting = null;
      resolve(false);
    }
  });
  return starting;
}

function runWorker(cmd: string, body?: Record<string, unknown>): Promise<CliResult | null> {
  return ensureWorker().then((ok) => {
    if (!ok || !workerProc) return null;
    const id = reqSeq++;
    return new Promise<CliResult | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, 120_000);
      pending.set(id, {
        resolve: (r) => resolve(r),
        timer
      });
      try {
        workerProc!.stdin.write(
          JSON.stringify({ id, cmd, body: body || {} }) + '\n'
        );
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  });
}

function runCliSync(cmd: string, body?: Record<string, unknown>): CliResult | null {
  try {
    const paths = resolvePaths();
    if (!paths || !existsSync(paths.cli)) return null;
    const input = body ? JSON.stringify(body) : '';
    const r = spawnSync(paths.pythonPath, [paths.cli, cmd], {
      cwd: paths.registerDir,
      input,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: envForPython()
    });
    const text = String(r.stdout || '').trim();
    if (!text) {
      const err = String(r.stderr || r.error || '').trim();
      if (err) console.warn('[accountSqlite] empty stdout', cmd, err.slice(0, 200));
      return null;
    }
    const parsed = JSON.parse(text) as CliResult;
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

/** 优先 worker，失败回退 spawnSync */
async function runCliAsync(
  cmd: string,
  body?: Record<string, unknown>
): Promise<CliResult | null> {
  try {
    const viaWorker = await runWorker(cmd, body);
    if (viaWorker) return viaWorker;
  } catch {
    /* fallthrough */
  }
  return runCliSync(cmd, body);
}

/** 热路径：优先长驻 worker，失败回退 spawnSync */
async function runCli(
  cmd: string,
  body?: Record<string, unknown>
): Promise<CliResult | null> {
  return runCliAsync(cmd, body);
}

// 进程启动后预热
void ensureWorker().catch(() => undefined);
process.on('exit', () => killWorker());
process.on('SIGTERM', () => killWorker());
process.on('SIGINT', () => killWorker());

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

export async function sqliteAccountsAvailable(): Promise<boolean> {
  const r = await runCli('count_accounts');
  return Boolean(r?.ok);
}

export async function sqliteCountAccounts(): Promise<number | null> {
  const r = await runCli('count_accounts');
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const n = Number((r.data as { count?: number }).count);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export async function sqliteDumpAccounts(): Promise<AccountRecord[] | null> {
  const r = await runCli('dump_accounts');
  if (!r?.ok || !Array.isArray(r.data)) return null;
  return (r.data as unknown[]).filter(isRecord);
}

export async function sqliteGetAccount(id: string): Promise<AccountRecord | null> {
  const r = await runCli('get_account', { id });
  if (!r?.ok) return null;
  if (r.data == null) return null;
  return isRecord(r.data) ? r.data : null;
}

export async function sqliteReplaceAccounts(items: AccountRecord[]): Promise<boolean> {
  const r = await runCli('replace_accounts', { items });
  return Boolean(r?.ok);
}

export async function sqliteUpsertAccount(account: AccountRecord): Promise<boolean> {
  const r = await runCli('upsert_account', { account });
  return Boolean(r?.ok);
}

export async function sqliteUpsertAccounts(items: AccountRecord[]): Promise<number | null> {
  if (!items.length) return 0;
  const r = await runCli('upsert_accounts', { items });
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const n = Number((r.data as { count?: number }).count);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export async function sqliteDeleteAccounts(ids: string[]): Promise<number | null> {
  const r = await runCli('delete_accounts', { ids });
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const n = Number((r.data as { deleted?: number }).deleted);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

let countCache: { at: number; n: number | null } | null = null;
const COUNT_CACHE_TTL_MS = 20_000;

export async function sqliteCountAccountsCached(): Promise<number | null> {
  const now = Date.now();
  if (countCache && now - countCache.at < COUNT_CACHE_TTL_MS) {
    return countCache.n;
  }
  const n = await sqliteCountAccounts();
  countCache = { at: now, n };
  return n;
}

export function invalidateSqliteCountCache(): void {
  countCache = null;
}

export async function migrateJsonToSqliteIfNeeded(
  jsonAccounts: AccountRecord[]
): Promise<{ migrated: boolean; count: number; error?: string }> {
  if (!jsonAccounts.length) return { migrated: false, count: 0 };
  const cnt = await sqliteCountAccounts();
  if (cnt == null) return { migrated: false, count: 0, error: 'sqlite unavailable' };
  if (cnt > 0) return { migrated: false, count: cnt };
  const ok = await sqliteReplaceAccounts(jsonAccounts);
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
    unknown: number;
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

export async function sqliteQueryAccounts(opts: {
  page?: number;
  pageSize?: number;
  q?: string;
  sso?: string;
  alive?: string;
  auth?: string;
  authEmails?: string[];
  authHashes?: string[];
}): Promise<SqliteQueryPage | null> {
  const r = await runCli('query_accounts', {
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
      unknown: Number(facetsRaw.unknown) || 0,
      authConverted: Number(facetsRaw.authConverted) || 0,
      authUnconverted: Number(facetsRaw.authUnconverted) || 0
    }
  };
}

export async function sqliteMatchAccounts(opts: {
  q?: string;
  sso?: string;
  alive?: string;
  auth?: string;
  limit?: number;
  requireSso?: boolean;
  authEmails?: string[];
  authHashes?: string[];
}): Promise<SqliteMatchResult | null> {
  const r = await runCli('match_accounts', {
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

/** 供将来 async 热路径使用 */
export { runCliAsync, ensureWorker, killWorker };

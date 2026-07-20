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

export function sqliteDeleteAccounts(ids: string[]): number | null {
  const r = runCli('delete_accounts', { ids });
  if (!r?.ok || !r.data || typeof r.data !== 'object') return null;
  const n = Number((r.data as { deleted?: number }).deleted);
  return Number.isFinite(n) ? Math.floor(n) : null;
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

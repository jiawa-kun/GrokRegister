/**
 * 账号记录存储。
 * registerBot 从 Python stdout 关联出 email/password/sso 后追加到这里。
 *
 * 落盘：DATA_DIR/accounts.json（Docker 默认 /data/accounts.json，挂载 ./data 持久化）。
 * 兼容：若新路径不存在，会尝试迁移 cwd/out/accounts.json，并从 SSO 目录导入历史 txt。
 * 验活结果写在每条 AccountRecord.ssoCheck 上，与号池同库持久化。
 */
import { promises as fsp, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AccountRecord, AccountSsoCheck } from '@shared/runEvents';
import { dataDir } from './settingsStore.js';
import {
  decryptSecretString,
  encryptSecretString,
  isEncryptedSecret,
  isSecretEncryptionAvailable,
  warnIfSecretEncryptionUnavailable
} from './secretCrypto.js';

function accountsDir(): string {
  return dataDir();
}

function accountsPath(): string {
  return join(accountsDir(), 'accounts.json');
}

/** 旧路径：曾误写到进程 cwd/out/accounts.json（容器内不持久） */
function legacyAccountsPath(): string {
  return resolve(process.cwd(), 'out', 'accounts.json');
}

function ssoDir(): string {
  if (process.env.SSO_DIR) return resolve(process.env.SSO_DIR);
  return join(dataDir(), 'sso');
}

function isAccountSsoCheck(v: unknown): v is AccountSsoCheck {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.alive === 'boolean' &&
    typeof o.status === 'number' &&
    typeof o.checkedAt === 'string'
  );
}

function isAccountRecord(v: unknown): v is AccountRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== 'string' ||
    typeof o.email !== 'string' ||
    typeof o.password !== 'string' ||
    typeof o.sso !== 'string' ||
    typeof o.createdAt !== 'string'
  ) {
    return false;
  }
  if (o.ssoCheck != null && !isAccountSsoCheck(o.ssoCheck)) {
    // 脏字段丢弃，仍保留账号
    delete o.ssoCheck;
  }
  return true;
}

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

let lock = Promise.resolve();

async function withAccountsLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let release!: () => void;
  lock = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function encryptRecordForDisk(record: AccountRecord): AccountRecord {
  return {
    ...record,
    password: record.password ? encryptSecretString(record.password) : record.password,
    sso: record.sso ? encryptSecretString(record.sso) : record.sso
  };
}

function decryptRecordForRuntime(record: AccountRecord): AccountRecord {
  return {
    ...record,
    password: record.password ? decryptSecretString(record.password, 'accounts.password') : record.password,
    sso: record.sso ? decryptSecretString(record.sso, 'accounts.sso') : record.sso
  };
}

/** accounts.json 内存缓存（mtime+size）；写路径刷新，外部改盘下次读失效 */
let accountsCache: {
  mtimeMs: number;
  size: number;
  records: AccountRecord[];
} | null = null;

/** facets 缓存：号池 mtime + auth 索引 mtime 未变则复用 */
let facetsCache: {
  accountsMtimeMs: number;
  accountsSize: number;
  authMtimeMs: number;
  facets: AccountListFacets;
} | null = null;

function invalidateAccountsCache(): void {
  accountsCache = null;
  facetsCache = null;
}

async function accountsFileStat(): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fsp.stat(accountsPath());
    return { mtimeMs: Number(st.mtimeMs) || 0, size: Number(st.size) || 0 };
  } catch {
    return null;
  }
}

function setAccountsCache(records: AccountRecord[], st?: { mtimeMs: number; size: number } | null): void {
  if (!st) {
    accountsCache = null;
    return;
  }
  accountsCache = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    // 浅拷贝数组与条目，避免调用方 mutate 污染缓存
    records: records.map((r) => ({ ...r, ssoCheck: r.ssoCheck ? { ...r.ssoCheck } : r.ssoCheck }))
  };
}

async function writeAll(all: AccountRecord[]): Promise<void> {
  const dir = accountsDir();
  await ensureDir(dir);
  const path = accountsPath();
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  warnIfSecretEncryptionUnavailable('accounts store');
  await fsp.writeFile(
    tmp,
    JSON.stringify(all.map(encryptRecordForDisk), null, 2),
    'utf-8'
  );
  await fsp.rename(tmp, path);
  try {
    const st = await fsp.stat(path);
    setAccountsCache(all, {
      mtimeMs: Number(st.mtimeMs) || 0,
      size: Number(st.size) || 0
    });
  } catch {
    invalidateAccountsCache();
  }
}

async function readJsonAccounts(path: string): Promise<AccountRecord[]> {
  if (!existsSync(path)) return [];
  try {
    const raw = await fsp.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAccountRecord).map(decryptRecordForRuntime);
  } catch {
    return [];
  }
}

async function encryptPlaintextAccountsIfNeeded(): Promise<void> {
  const path = accountsPath();
  if (!isSecretEncryptionAvailable() || !existsSync(path)) return;
  try {
    const raw = await fsp.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const hasPlainSecret = parsed.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      return (
        (typeof record.password === 'string' &&
          record.password &&
          !isEncryptedSecret(record.password)) ||
        (typeof record.sso === 'string' && record.sso && !isEncryptedSecret(record.sso))
      );
    });
    if (!hasPlainSecret) return;
    await writeAll(parsed.filter(isAccountRecord).map(decryptRecordForRuntime));
    console.log('[accountStore] encrypted plaintext account secrets in accounts.json');
  } catch (err) {
    console.error('[accountStore] account secret encryption migration failed', err);
  }
}

/** 从文件名解析近似创建时间（sso_YYYYMMDD_HHMMSS_*.txt） */
function createdAtFromSsoFilename(name: string): string {
  const m = name.match(/sso_(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/i);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  try {
    return new Date(statSync(join(ssoDir(), name)).mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function parseHistoryLine(line: string, fileName: string, lineIndex: number): AccountRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const base = {
    id: randomUUID(),
    runId: `import:${basename(fileName)}:${lineIndex}`,
    createdAt: createdAtFromSsoFilename(fileName)
  };

  // 标准输出：email | password | sso
  if (trimmed.includes(' | ')) {
    const parts = trimmed.split(' | ').map((p) => p.trim());
    if (parts.length >= 3) {
      const email = parts[0];
      const password = parts[1];
      const sso = parts.slice(2).join(' | ').replace(/^sso=/i, '');
      if (!email && !password && !sso) return null;
      return { ...base, email, password, sso };
    }
  }

  // 兼容旧导出：email----password----sso
  if (trimmed.includes('----')) {
    const parts = trimmed.split('----');
    if (parts.length >= 3) {
      const email = parts[0].trim();
      const password = parts[1].trim();
      const sso = parts.slice(2).join('----').trim().replace(/^sso=/i, '');
      if (!email && !password && !sso) return null;
      return { ...base, email, password, sso };
    }
  }

  // Plan C hybrid 曾写：email|password|sso（无空格）。勿把整行当纯 SSO。
  if (trimmed.includes('|') && !trimmed.includes(' | ')) {
    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length >= 3) {
      const email = parts[0];
      const password = parts[1];
      const sso = parts.slice(2).join('|').replace(/^sso=/i, '');
      // email 列应像邮箱；否则仍可能是别的格式
      const looksEmail = /@/.test(email) || !email;
      if (looksEmail && sso.length >= 8) {
        return { ...base, email: email || '', password: password || '', sso };
      }
    }
  }

  // 纯 SSO token（历史文件）
  const sso = trimmed.replace(/^sso=/i, '');
  // 若误把 email|pass|sso 整行当 sso，上面已拦截
  if (!sso || sso.length < 8 || sso.includes('|')) return null;
  return {
    ...base,
    email: '',
    password: '',
    sso
  };
}

/** 修复历史坏行：sso 字段里塞了 email|password|token 或 email | password | token */
export function repairAccountFields(a: AccountRecord): AccountRecord {
  const email = String(a.email || '').trim();
  const password = String(a.password || '').trim();
  let sso = String(a.sso || '').trim().replace(/^sso=/i, '');
  if (email && password && sso && !sso.includes('|') && !sso.includes(' | ')) {
    return a;
  }
  // sso 列被写成整行
  if ((!email || !password) && (sso.includes(' | ') || sso.includes('|'))) {
    let parts: string[] = [];
    if (sso.includes(' | ')) {
      parts = sso.split(' | ').map((p) => p.trim());
    } else {
      parts = sso.split('|').map((p) => p.trim());
    }
    if (parts.length >= 3 && (/@/.test(parts[0]) || !parts[0])) {
      const e = parts[0] || email;
      const p = parts[1] || password;
      const t = parts.slice(2).join(sso.includes(' | ') ? ' | ' : '|').replace(/^sso=/i, '');
      if (t.length >= 8) {
        return { ...a, email: e, password: p, sso: t };
      }
    }
  }
  return a;
}

function importFromSsoFiles(existing: AccountRecord[]): AccountRecord[] {
  const dir = ssoDir();
  if (!existsSync(dir)) return existing;

  const seenSso = new Set(
    existing.map((a) => a.sso.trim()).filter(Boolean)
  );
  const seenKey = new Set(
    existing
      .filter((a) => a.email && a.password)
      .map((a) => `${a.email}----${a.password}----${a.sso}`)
  );

  const added: AccountRecord[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.txt') || f.endsWith('.csv'));
  } catch {
    return existing;
  }

  for (const file of files) {
    let content = '';
    try {
      content = readFileSync(join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const rec = parseHistoryLine(line, file, idx);
      if (!rec) return;
      if (rec.sso && seenSso.has(rec.sso)) return;
      const key = `${rec.email}----${rec.password}----${rec.sso}`;
      if (rec.email && seenKey.has(key)) return;
      if (rec.sso) seenSso.add(rec.sso);
      if (rec.email) seenKey.add(key);
      added.push(rec);
    });
  }

  if (added.length === 0) return existing;
  return [...existing, ...added];
}

async function migrateLegacyIfNeeded(current: AccountRecord[]): Promise<AccountRecord[]> {
  if (current.length > 0) return current;
  const legacy = await readJsonAccounts(legacyAccountsPath());
  if (legacy.length === 0) return current;
  await writeAll(legacy);
  console.log(`[accountStore] migrated ${legacy.length} accounts from ${legacyAccountsPath()}`);
  return legacy;
}

async function readAll(): Promise<AccountRecord[]> {
  await ensureDir(accountsDir());
  const st = await accountsFileStat();
  if (
    accountsCache &&
    st &&
    accountsCache.mtimeMs === st.mtimeMs &&
    accountsCache.size === st.size
  ) {
    // 返回数组浅拷贝，允许调用方 push/filter 而不直接改缓存数组
    return accountsCache.records.map((r) => ({
      ...r,
      ssoCheck: r.ssoCheck ? { ...r.ssoCheck } : r.ssoCheck
    }));
  }

  let all = await readJsonAccounts(accountsPath());
  all = await migrateLegacyIfNeeded(all);

  // 若库空或明显少于历史 sso 文件可恢复项，尝试从 /data/sso 导入
  const merged = importFromSsoFiles(all);
  if (merged.length > all.length) {
    const gained = merged.length - all.length;
    await writeAll(merged);
    console.log(`[accountStore] imported ${gained} accounts from ${ssoDir()}`);
    return merged;
  }
  const stAfter = st || (await accountsFileStat());
  setAccountsCache(merged, stAfter);
  return merged;
}

/**
 * 写入号池。按 sso 去重：已存在则返回已有 id（不插新行）。
 * 调用方必须用返回的 id 做 ssoCheck / 事件推送，否则验活会写到「不存在的新 UUID」。
 */
export async function appendAccount(
  record: AccountRecord
): Promise<{ id: string; created: boolean }> {
  return withAccountsLock(async () => {
    const all = await readAll();
    const sso = String(record.sso || '').trim();
    if (sso) {
      const existing = all.find((a) => a.sso && a.sso === sso);
      if (existing) {
        // 可选补全空邮箱/密码（不覆盖已有）
        let touched = false;
        const email = String(record.email || '').trim();
        const password = String(record.password || '').trim();
        const patch: AccountRecord = { ...existing };
        if (email && !String(existing.email || '').trim()) {
          patch.email = email;
          touched = true;
        }
        if (password && !String(existing.password || '').trim()) {
          patch.password = password;
          touched = true;
        }
        if (touched) {
          const next = all.map((a) => (a.id === existing.id ? patch : a));
          await writeAll(next);
        }
        return { id: existing.id, created: false };
      }
    }
    all.push(record);
    await writeAll(all);
    return { id: record.id, created: true };
  });
}

/** 读号池 + 修复脏行 + 排序；不挂 NSFW/ZDR tags（筛选/match 用） */
async function loadAccountsBase(): Promise<AccountRecord[]> {
  const raw = await readAll();
  let dirty = false;
  const all = raw.map((a) => {
    const fixed = repairAccountFields(a);
    if (
      fixed !== a &&
      (fixed.email !== a.email || fixed.password !== a.password || fixed.sso !== a.sso)
    ) {
      dirty = true;
    }
    return fixed;
  });
  if (dirty) {
    try {
      await writeAll(all);
      console.log('[accountStore] repaired hybrid email|password|sso rows in accounts.json');
    } catch {
      /* ignore */
    }
  }
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 仅为给定记录挂 tags（分页当前页 / 全量 list 兼容） */
async function attachTagsToRecords(records: AccountRecord[]): Promise<AccountRecord[]> {
  if (!records.length) return records;
  try {
    const {
      loadAccountTags,
      lookupNsfwTag,
      nsfwStatusFromTag,
      zdrStatusFromTag,
      ssoHashHex
    } = await import('./accountTags.js');
    const tags = loadAccountTags();
    return records.map((a) => {
      const side = nsfwStatusFromTag(
        lookupNsfwTag(tags, {
          email: a.email,
          sso: a.sso,
          ssoHash: a.sso ? ssoHashHex(a.sso) : undefined
        })
      );
      const zdr = zdrStatusFromTag(
        lookupNsfwTag(tags, {
          email: a.email,
          sso: a.sso,
          ssoHash: a.sso ? ssoHashHex(a.sso) : undefined
        })
      );
      return {
        ...a,
        nsfwEnabled: side.nsfwEnabled,
        nsfwAttempted: side.nsfwAttempted,
        nsfwAt: side.nsfwAt,
        nsfwError: side.nsfwError,
        nsfwStatus: side.nsfwStatus,
        zdrClosed: zdr.zdrClosed,
        zdrAttempted: zdr.zdrAttempted,
        zdrAt: zdr.zdrAt,
        zdrError: zdr.zdrError,
        zdrStatus: zdr.zdrStatus
      } as AccountRecord;
    });
  } catch {
    return records;
  }
}

async function loadAccountsWithTags(): Promise<AccountRecord[]> {
  const all = await loadAccountsBase();
  return attachTagsToRecords(all);
}

export async function listAccounts(): Promise<AccountRecord[]> {
  return withAccountsLock(() => loadAccountsWithTags());
}

/** 无 tags 的号池快照（Auth 密码映射等轻量交叉用） */
export async function listAccountsLite(): Promise<AccountRecord[]> {
  return withAccountsLock(() => loadAccountsBase());
}

export type AccountListQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  /** all | has_sso | no_sso */
  sso?: string;
  /** all | unchecked | alive | dead */
  alive?: string;
  /** all | converted | unconverted — 与 Auth 目录 email/ssoHash 交叉 */
  auth?: string;
};

export type AccountListFacets = {
  /** 号池总量（未筛） */
  all: number;
  hasSso: number;
  noSso: number;
  unchecked: number;
  alive: number;
  dead: number;
  /** Auth 已转 / 未转（基于 email 或 sso hash） */
  authConverted: number;
  authUnconverted: number;
};

type AuthBadgeFlag = {
  botFlagSource: number | string | null;
  isBotFlag1: boolean;
};

type AuthIndex = {
  emails: Set<string>;
  ssoHashes: Set<string>;
  /** email → mint 通道 */
  emailChannels: Map<string, Set<'A' | 'B'>>;
  /** ssoHash → mint 通道 */
  hashChannels: Map<string, Set<'A' | 'B'>>;
  emailBotFlags: Map<string, AuthBadgeFlag>;
  hashBotFlags: Map<string, AuthBadgeFlag>;
};

function emptyAuthIndex(): AuthIndex {
  return {
    emails: new Set(),
    ssoHashes: new Set(),
    emailChannels: new Map(),
    hashChannels: new Map(),
    emailBotFlags: new Map(),
    hashBotFlags: new Map()
  };
}

let authIndexCache: { at: number; mtimeMs: number; index: AuthIndex } | null = null;
const AUTH_INDEX_TTL_MS = 30_000;

/** Auth 目录变更后调用，避免号池「已转」筛选用旧索引 */
export function invalidateAuthIndexCache(): void {
  authIndexCache = null;
  facetsCache = null;
}

function addAuthChannel(
  map: Map<string, Set<'A' | 'B'>>,
  key: string,
  ch: 'A' | 'B' | null
): void {
  if (!key || !ch) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(ch);
}

function preferAuthBotFlag(
  map: Map<string, AuthBadgeFlag>,
  key: string,
  flag: AuthBadgeFlag | null
): void {
  if (!key || !flag) return;
  if (flag.botFlagSource == null || flag.botFlagSource === '') return;
  const prev = map.get(key);
  if (prev?.isBotFlag1) return;
  if (flag.isBotFlag1 || !prev) map.set(key, flag);
}

function resolveMintChannelFromNameData(
  filename: string,
  data: Record<string, unknown>
): 'A' | 'B' | null {
  const raw = String(
    data.mint_channel || data.mintChannel || data.mint_mode || data.mintMode || ''
  )
    .trim()
    .toLowerCase();
  if (raw === 'pkce' || raw === 'a' || raw === 'auth_code') return 'A';
  if (raw === 'device' || raw === 'b' || raw === 'device_flow') return 'B';
  const base = filename.replace(/\.json$/i, '').toLowerCase();
  if (base.endsWith('-pkce') || base.endsWith('_pkce') || base.endsWith('-a')) return 'A';
  if (base.endsWith('-device') || base.endsWith('_device') || base.endsWith('-b')) return 'B';
  if (/^xai-/i.test(filename)) return 'A';
  return null;
}

async function authDirMtimeMs(): Promise<number> {
  // 与 cpaAuthStore.resolveAuthDir 一致：固定 DATA_DIR/auth
  const dir = join(dataDir(), 'auth');
  try {
    const st = await fsp.stat(dir);
    return Number(st.mtimeMs) || 0;
  } catch {
    return 0;
  }
}

/**
 * 轻量扫描 auth 目录（email / ssoHash / 通道 / bot_flag），
 * 避免 listCpaAuth 全量解析拖慢号池分页与徽章。
 */
async function scanAuthIndexLight(dir: string): Promise<AuthIndex> {
  const index = emptyAuthIndex();
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return index;
  }
  // 并发限制，避免一次打开成百上千文件打满句柄
  const jsonNames = names.filter((n) => n.endsWith('.json'));
  const concurrency = 24;
  let cursor = 0;
  const { readBotFlagFromAuthRecord } = await import('./jwtBotFlag.js');
  async function worker() {
    while (cursor < jsonNames.length) {
      const i = cursor++;
      const name = jsonNames[i]!;
      const full = join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (!st.isFile() || st.size > 2_000_000) continue;
        // 文件名 email：xai-foo@bar.com.json / xai-foo@bar.com-pkce.json
        const base = name.replace(/\.json$/i, '');
        const m = base.match(/^xai-(.+?)(?:-(pkce|device|a|b))?$/i);
        let fileEmail = '';
        if (m?.[1] && m[1].includes('@')) {
          fileEmail = m[1].trim().toLowerCase();
          index.emails.add(fileEmail);
        }
        const raw = await fsp.readFile(full, 'utf-8');
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }
        const em = String(data.email || data.Email || '')
          .trim()
          .toLowerCase();
        if (em) index.emails.add(em);
        const emailKey = em || fileEmail;
        const ch = resolveMintChannelFromNameData(name, data);
        if (emailKey) addAuthChannel(index.emailChannels, emailKey, ch);

        // 优先预计算 sso_hash，避免对长 JWT 再 sha256
        let hash = String(data.sso_hash || data.ssoHash || '')
          .trim()
          .toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(hash)) {
          let sso = '';
          if (typeof data.sso === 'string') sso = data.sso;
          else if (data.extra && typeof data.extra === 'object') {
            const s = (data.extra as Record<string, unknown>).sso;
            if (typeof s === 'string') sso = s;
          }
          sso = String(sso || '')
            .trim()
            .replace(/^sso=/i, '')
            .trim();
          hash = '';
          if (sso.length >= 8) {
            hash = createHash('sha256').update(sso, 'utf8').digest('hex');
          }
        }
        if (hash) {
          index.ssoHashes.add(hash);
          addAuthChannel(index.hashChannels, hash, ch);
        }
        // 徽章冷扫：侧车优先，无侧车不 decode JWT（默认 None）
        const bot = readBotFlagFromAuthRecord(data, { jwt: false });
        preferAuthBotFlag(index.emailBotFlags, emailKey, bot);
        preferAuthBotFlag(index.hashBotFlags, hash, bot);
      } catch {
        /* skip file */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jsonNames.length || 1) }, () => worker()));
  return index;
}

async function loadAuthIndex(): Promise<AuthIndex> {
  const now = Date.now();
  const mtimeMs = await authDirMtimeMs();
  // TTL 内且目录 mtime 未变才命中缓存（覆盖 Python 自动 mint 写文件的路径）
  if (
    authIndexCache &&
    now - authIndexCache.at < AUTH_INDEX_TTL_MS &&
    authIndexCache.mtimeMs === mtimeMs
  ) {
    return authIndexCache.index;
  }
  const dir = join(dataDir(), 'auth');
  let index = emptyAuthIndex();
  try {
    // 优先轻量扫描；失败再回退 listCpaAuth（兼容旧逻辑）
    index = await scanAuthIndexLight(dir);
  } catch {
    try {
      const { listCpaAuth } = await import('./cpaAuthStore.js');
      const { items } = await listCpaAuth();
      for (const it of items || []) {
        const e = String(it.email || '')
          .trim()
          .toLowerCase();
        if (e) index.emails.add(e);
        const h = String(it.ssoHash || '')
          .trim()
          .toLowerCase();
        if (h) index.ssoHashes.add(h);
        const ch =
          it.mintChannel === 'B' ? 'B' : it.mintChannel === 'A' ? 'A' : null;
        if (e) addAuthChannel(index.emailChannels, e, ch);
        if (h) addAuthChannel(index.hashChannels, h, ch);
        const flag: AuthBadgeFlag = {
          botFlagSource:
            it.botFlagSource !== undefined && it.botFlagSource !== null && it.botFlagSource !== ''
              ? it.botFlagSource
              : null,
          isBotFlag1: Boolean(it.isBotFlag1)
        };
        preferAuthBotFlag(index.emailBotFlags, e, flag);
        preferAuthBotFlag(index.hashBotFlags, h, flag);
      }
    } catch {
      /* auth 目录不可用时视为无已转 */
    }
  }
  authIndexCache = { at: now, mtimeMs, index };
  return index;
}

/** 号池徽章用轻量 Auth 索引（无 token / 无全量文件列表） */
export type AuthBadgeIndex = {
  emails: string[];
  ssoHashes: string[];
  emailChannels: Record<string, ('A' | 'B')[]>;
  hashChannels: Record<string, ('A' | 'B')[]>;
  emailBotFlags: Record<string, AuthBadgeFlag>;
  hashBotFlags: Record<string, AuthBadgeFlag>;
};

export async function getAuthBadgeIndex(): Promise<AuthBadgeIndex> {
  const index = await loadAuthIndex();
  const emailChannels: Record<string, ('A' | 'B')[]> = {};
  for (const [k, set] of index.emailChannels) {
    emailChannels[k] = Array.from(set);
  }
  const hashChannels: Record<string, ('A' | 'B')[]> = {};
  for (const [k, set] of index.hashChannels) {
    hashChannels[k] = Array.from(set);
  }
  const emailBotFlags: Record<string, AuthBadgeFlag> = {};
  for (const [k, v] of index.emailBotFlags) emailBotFlags[k] = v;
  const hashBotFlags: Record<string, AuthBadgeFlag> = {};
  for (const [k, v] of index.hashBotFlags) hashBotFlags[k] = v;
  return {
    emails: Array.from(index.emails),
    ssoHashes: Array.from(index.ssoHashes),
    emailChannels,
    hashChannels,
    emailBotFlags,
    hashBotFlags
  };
}

function isAuthConvertedAccount(
  a: AccountRecord,
  index: AuthIndex,
  ssoHashOf: (sso: string) => string
): boolean {
  const e = String(a.email || '')
    .trim()
    .toLowerCase();
  if (e && index.emails.has(e)) return true;
  const sso = String(a.sso || '').trim();
  if (!sso) return false;
  try {
    const h = ssoHashOf(sso).toLowerCase();
    return Boolean(h && index.ssoHashes.has(h));
  } catch {
    return false;
  }
}

export type AccountListPage = {
  items: AccountRecord[];
  /** 当前筛选后的条数 */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** 未筛选的全局分面（用于顶栏计数） */
  facets: AccountListFacets;
};

function matchAccountQuery(
  a: AccountRecord,
  opts: AccountListQuery,
  ctx?: {
    authIndex?: AuthIndex;
    ssoHashOf?: (sso: string) => string;
  }
): boolean {
  const ssoMode = String(opts.sso || 'all').trim().toLowerCase();
  const hasSso = Boolean(String(a.sso || '').trim());
  if (ssoMode === 'has_sso' && !hasSso) return false;
  if (ssoMode === 'no_sso' && hasSso) return false;

  const aliveMode = String(opts.alive || 'all').trim().toLowerCase();
  if (aliveMode === 'unchecked') {
    if (a.ssoCheck && typeof a.ssoCheck.alive === 'boolean') return false;
  } else if (aliveMode === 'alive') {
    if (!a.ssoCheck || a.ssoCheck.alive !== true) return false;
  } else if (aliveMode === 'dead') {
    if (!a.ssoCheck || a.ssoCheck.alive !== false) return false;
  }

  const authMode = String(opts.auth || 'all').trim().toLowerCase();
  if (authMode === 'converted' || authMode === 'unconverted') {
    const idx = ctx?.authIndex;
    const hashOf = ctx?.ssoHashOf;
    if (idx && hashOf) {
      const conv = isAuthConvertedAccount(a, idx, hashOf);
      if (authMode === 'converted' && !conv) return false;
      if (authMode === 'unconverted' && conv) return false;
    }
  }

  const q = String(opts.q || '').trim().toLowerCase();
  if (q) {
    const email = String(a.email || '').toLowerCase();
    const id = String(a.id || '').toLowerCase();
    if (email.includes(q) || id.includes(q)) return true;
    // 长查询才扫 SSO（避免每条对完整 JWT 做 includes）
    if (q.length >= 12) {
      const sso = String(a.sso || '')
        .replace(/^sso=/i, '')
        .trim()
        .toLowerCase();
      if (sso && sso.includes(q)) return true;
    }
    return false;
  }
  return true;
}

function buildFacets(
  all: AccountRecord[],
  authIndex?: AuthIndex,
  ssoHashOf?: (sso: string) => string
): AccountListFacets {
  let hasSso = 0;
  let unchecked = 0;
  let alive = 0;
  let dead = 0;
  let authConverted = 0;
  for (const a of all) {
    if (String(a.sso || '').trim()) hasSso++;
    const c = a.ssoCheck;
    if (!c || typeof c.alive !== 'boolean') unchecked++;
    else if (c.alive) alive++;
    else dead++;
    if (authIndex && ssoHashOf && isAuthConvertedAccount(a, authIndex, ssoHashOf)) {
      authConverted++;
    }
  }
  return {
    all: all.length,
    hasSso,
    noSso: all.length - hasSso,
    unchecked,
    alive,
    dead,
    authConverted,
    authUnconverted: Math.max(0, all.length - authConverted)
  };
}

/** 服务端筛选 + 分页（主库仍为 accounts.json；为规模化铺路） */
export async function queryAccounts(opts: AccountListQuery = {}): Promise<AccountListPage> {
  return withAccountsLock(async () => {
    // 筛选/facets 不需要 tags；仅当前页挂 NSFW/ZDR
    const all = await loadAccountsBase();
    const authIndex = await loadAuthIndex();
    let ssoHashOf = (sso: string) =>
      createHash('sha256').update(String(sso || '').trim(), 'utf8').digest('hex');
    try {
      const { hashSsoToken } = await import('./cpaAuthStore.js');
      ssoHashOf = (sso: string) => hashSsoToken(sso) || '';
    } catch {
      /* fallback sha256 above */
    }
    const accSt = await accountsFileStat();
    const authMt = await authDirMtimeMs();
    let facets: AccountListFacets;
    if (
      facetsCache &&
      accSt &&
      facetsCache.accountsMtimeMs === accSt.mtimeMs &&
      facetsCache.accountsSize === accSt.size &&
      facetsCache.authMtimeMs === authMt
    ) {
      facets = facetsCache.facets;
    } else {
      facets = buildFacets(all, authIndex, ssoHashOf);
      if (accSt) {
        facetsCache = {
          accountsMtimeMs: accSt.mtimeMs,
          accountsSize: accSt.size,
          authMtimeMs: authMt,
          facets
        };
      }
    }
    const filtered = all.filter((a) =>
      matchAccountQuery(a, opts, { authIndex, ssoHashOf })
    );
    // 单页上限与前端 PaginationBar 对齐（最大 2000）；默认 20
    const pageSize = Math.min(2000, Math.max(1, Math.floor(Number(opts.pageSize) || 20)));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
    const page = Math.min(totalPages, Math.max(1, Math.floor(Number(opts.page) || 1)));
    const start = (page - 1) * pageSize;
    const pageItems = filtered.slice(start, start + pageSize);
    return {
      items: await attachTagsToRecords(pageItems),
      total,
      page,
      pageSize,
      totalPages,
      facets
    };
  });
}

export type AccountMatchQuery = AccountListQuery & {
  /** 最多返回条数（默认 500，硬顶 2000） */
  limit?: number;
  /** 仅含 SSO 的账号（验活/补签用） */
  requireSso?: boolean;
};

export type AccountMatchItem = {
  id: string;
  email: string;
  password: string;
  sso: string;
  createdAt: string;
};

export type AccountMatchResult = {
  items: AccountMatchItem[];
  total: number;
  returned: number;
  truncated: boolean;
  limit: number;
};

/**
 * 按筛选返回匹配账号（用于「筛后全部」验活/导出/补签）。
 * 返回精简字段，不挂 tags。
 */
export async function matchAccounts(opts: AccountMatchQuery = {}): Promise<AccountMatchResult> {
  return withAccountsLock(async () => {
    const all = await loadAccountsBase();
    const authIndex = await loadAuthIndex();
    let ssoHashOf = (sso: string) =>
      createHash('sha256').update(String(sso || '').trim(), 'utf8').digest('hex');
    try {
      const { hashSsoToken } = await import('./cpaAuthStore.js');
      ssoHashOf = (sso: string) => hashSsoToken(sso) || '';
    } catch {
      /* fallback */
    }
    let filtered = all.filter((a) =>
      matchAccountQuery(a, opts, { authIndex, ssoHashOf })
    );
    if (opts.requireSso) {
      filtered = filtered.filter((a) => Boolean(String(a.sso || '').trim()));
    }
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(opts.limit) || 500)));
    const total = filtered.length;
    const slice = filtered.slice(0, limit);
    return {
      items: slice.map((a) => ({
        id: a.id,
        email: String(a.email || ''),
        password: String(a.password || ''),
        sso: String(a.sso || ''),
        createdAt: a.createdAt
      })),
      total,
      returned: slice.length,
      truncated: total > slice.length,
      limit
    };
  });
}

export async function migrateAccountSecretStorage(): Promise<void> {
  await withAccountsLock(encryptPlaintextAccountsIfNeeded);
}

/** 按 id 批量删除号池账号（仅写 accounts.json，不删 SSO 历史 txt） */
export async function deleteAccounts(
  ids: string[]
): Promise<{ deleted: number; requested: number; remaining: number }> {
  return withAccountsLock(async () => {
    const idSet = new Set(
      (Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean)
    );
    if (idSet.size === 0) {
      return { deleted: 0, requested: 0, remaining: (await readAll()).length };
    }
    const all = await readAll();
    const next = all.filter((a) => !idSet.has(a.id));
    const deleted = all.length - next.length;
    if (deleted > 0) {
      await writeAll(next);
    }
    return { deleted, requested: idSet.size, remaining: next.length };
  });
}

/**
 * 从粘贴/上传文本导入号池。
 * 支持行格式：
 *   email | password | sso
 *   email----password----sso
 *   sso=... 或纯 JWT
 * 按 sso（或 email+password+sso）去重。
 */
export async function importAccountsFromText(input: {
  text: string;
  source?: string;
}): Promise<{
  totalLines: number;
  parsed: number;
  imported: number;
  skipped: number;
  invalid: number;
  remaining: number;
}> {
  return withAccountsLock(async () => {
    const text = String(input?.text || '');
    const source = String(input?.source || 'paste').replace(/[^\w.\-@]/g, '_').slice(0, 80);
    const lines = text.split(/\r?\n/);
    let parsed = 0;
    let invalid = 0;
    const candidates: AccountRecord[] = [];
    const now = new Date().toISOString();

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.startsWith('#')) continue;
      const rec = parseHistoryLine(raw, source || 'import.txt', i + 1);
      if (!rec || !String(rec.sso || '').trim()) {
        // 无 sso 的行算无效（号池导入以 sso 为核心）
        if (raw.length > 0) invalid++;
        continue;
      }
      parsed++;
      candidates.push({
        ...rec,
        id: randomUUID(),
        runId: `import:${source}:${i + 1}`,
        createdAt: now
      });
    }

    if (candidates.length === 0) {
      const remaining = (await readAll()).length;
      return {
        totalLines: lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length,
        parsed: 0,
        imported: 0,
        skipped: 0,
        invalid,
        remaining
      };
    }

    const all = await readAll();
    const seenSso = new Set(all.map((a) => a.sso.trim()).filter(Boolean));
    const seenKey = new Set(
      all.map((a) => `${a.email}----${a.password}----${a.sso}`)
    );
    let imported = 0;
    let skipped = 0;
    for (const rec of candidates) {
      const sso = rec.sso.trim();
      if (sso && seenSso.has(sso)) {
        skipped++;
        continue;
      }
      const key = `${rec.email}----${rec.password}----${rec.sso}`;
      if (seenKey.has(key)) {
        skipped++;
        continue;
      }
      all.push(rec);
      if (sso) seenSso.add(sso);
      seenKey.add(key);
      imported++;
    }
    if (imported > 0) {
      await writeAll(all);
    }
    return {
      totalLines: lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length,
      parsed,
      imported,
      skipped,
      invalid,
      remaining: all.length
    };
  });
}

/** 手动触发从 SSO 目录重新扫描导入历史（号池刷新时可用） */
export async function resyncAccountsFromDisk(): Promise<{ total: number; imported: number }> {
  return withAccountsLock(async () => {
    const before = await readJsonAccounts(accountsPath());
    let all = await migrateLegacyIfNeeded(before);
    const beforeCount = all.length;
    all = importFromSsoFiles(all);
    if (all.length !== beforeCount) {
      await writeAll(all);
    }
    return { total: all.length, imported: Math.max(0, all.length - beforeCount) };
  });
}

/** 将批量验活结果写回 accounts.json（按 id 合并 ssoCheck） */
export async function applyAccountSsoChecks(
  results: Array<{
    id: string;
    alive: boolean;
    status: number;
    checkedAt: string;
    email?: string;
    givenName?: string;
    familyName?: string;
    emailConfirmed?: boolean;
    sessionTierId?: string;
    createTime?: string;
    error?: string;
    botFlagSource?: number | string | null;
    isBotFlag1?: boolean;
  }>
): Promise<{ updated: number; emailsFilled: number }> {
  return withAccountsLock(async () => {
    const list = Array.isArray(results) ? results : [];
    if (list.length === 0) return { updated: 0, emailsFilled: 0 };

    const byId = new Map<string, (typeof list)[number]>();
    for (const r of list) {
      const id = String(r?.id || '').trim();
      if (!id || typeof r.alive !== 'boolean') continue;
      byId.set(id, r);
    }
    if (byId.size === 0) return { updated: 0, emailsFilled: 0 };

    const all = await readAll();
    let updated = 0;
    let emailsFilled = 0;
    const next = all.map((a) => {
      const r = byId.get(a.id);
      if (!r) return a;
      const ssoCheck: AccountSsoCheck = {
        alive: r.alive,
        status: typeof r.status === 'number' ? r.status : 0,
        checkedAt:
          typeof r.checkedAt === 'string' && r.checkedAt
            ? r.checkedAt
            : new Date().toISOString(),
        email: r.email,
        givenName: r.givenName,
        familyName: r.familyName,
        emailConfirmed: r.emailConfirmed,
        sessionTierId: r.sessionTierId,
        createTime: r.createTime,
        error: r.error,
        botFlagSource: r.botFlagSource,
        isBotFlag1: r.isBotFlag1
      };
      updated++;
      // 验活若返回邮箱且号池无邮箱：按 SSO 补 email（便于后续 auth 回填）
      const prevEmail = String(a.email || '').trim();
      const fromCheck = typeof r.email === 'string' ? r.email.trim() : '';
      let email = a.email;
      if (!prevEmail && fromCheck) {
        email = fromCheck;
        emailsFilled++;
      }
      return { ...a, email, ssoCheck };
    });

    if (updated > 0) {
      await writeAll(next);
    }
    if (emailsFilled > 0) {
      console.log(
        `[accounts] sso 验活补全邮箱: ${emailsFilled} 条（号池无邮箱且 grok 返回 email）`
      );
    }
    return { updated, emailsFilled };
  });
}

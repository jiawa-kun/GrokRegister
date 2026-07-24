/**
 * CPA auth 文件列表、重签、SSO→CPA mint。
 * 列表直接读目录；重签/mint 调用 register/auth_service。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadSettings, dataDir, isSecretPlaceholder } from './settingsStore.js';
import { resolveHttpProxy } from './resolveHttpProxy.js';
import { probeCpaAuthFileNode } from './cpaProbe.js';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';
import { readBotFlagFromAuthRecord, readBotFlagFromToken } from './jwtBotFlag.js';
import { proxiedRequest, requestWithProxyFallback, errorMessage } from './httpClient.js';
import { broadcastAppEvent } from './appEvents.js';
import type { ReloginStage } from '@shared/runEvents.js';
import {
  getPythonJobPool,
  classifyAuthFailReason,
  classifyPushFailReason,
  summarizeFailReasons
} from './pythonJobPool.js';
import {
  loadAccountTagsAsync,
  lookupNsfwTag,
  zdrStatusFromTag,
  nsfwStatusFromTag,
  allPushStatusesFromTag,
  isPushOkFromTag,
  setPushTag
} from './accountTags.js';
import type { AccountTagEntry } from './accountTags.js';

/**
 * Normalize Admin secret pasted from sub2api UI.
 * Strips whitespace and accidental "Bearer " prefix.
 */
export function normalizeSub2apiAdminSecret(raw: string): string {
  let s = String(raw || '').trim();
  if (s.length >= 7 && s.slice(0, 7).toLowerCase() === 'bearer ') {
    s = s.slice(7).trim();
  }
  return s;
}

/**
 * 规范化 sub2api 服务根地址：去尾斜杠，剥掉误粘贴的 /api/v1 等路径。
 * 探活/推送会再拼 `/api/v1/admin/accounts`，双写路径会导致 404。
 */
export function normalizeSub2apiBaseUrl(raw: string): string {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  const suffixes = [
    '/api/v1/admin/accounts',
    '/api/v1/admin',
    '/api/v1',
    '/api'
  ];
  for (const suffix of suffixes) {
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length).replace(/\/+$/, '');
    }
  }
  return base;
}

/**
 * Wei-Shaw/sub2api Admin 鉴权（admin_auth.go）：
 * - Admin API Key（如 admin-...）→ x-api-key
 * - 管理员 JWT（三段 base64url）→ Authorization: Bearer <jwt>
 */
export function sub2apiAdminAuthHeaders(token: string): Record<string, string> {
  const tok = normalizeSub2apiAdminSecret(token);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!tok) return headers;
  const parts = tok.split('.');
  const isJwt = parts.length === 3 && parts.every((p) => p.length > 0);
  if (isJwt) {
    headers.Authorization = `Bearer ${tok}`;
  } else {
    headers['x-api-key'] = tok;
  }
  return headers;
}

export interface CpaAuthItem {
  filename: string;
  path: string;
  email: string;
  sub: string;
  expired: string;
  disabled: boolean;
  hasRefresh: boolean;
  mtime: number;
  /** 文件名以 xai- 开头 */
  xaiFilename: boolean;
  /** JSON 内 type === "xai" */
  xaiType: boolean;
  /** 综合：文件名或 type 任一满足视为带 xai 标识 */
  xai: boolean;
  authType: string;
  /** access_token/sso JWT 中的 bot_flag_source */
  botFlagSource?: number | string | null;
  isBotFlag1?: boolean;
  /** auth 内 sso 的 SHA-256（规范化后），不返回 sso 原文 */
  ssoHash?: string | null;
  hasSso?: boolean;
  /** mint 通道：A=pkce / B=device */
  mintChannel?: 'A' | 'B' | null;
  /** 上次测活结果（落盘 probe_action / probe_http） */
  probeAction?: string | null;
  probeHttp?: number | null;
  /** ISO 时间，上次测活写入时刻 */
  probeAt?: string | null;
  /** 号池同邮箱是否有密码（重登前置） */
  poolHasPassword?: boolean;
  /** NSFW：true 已开 / false 尝试失败 / null 未尝试 */
  nsfwEnabled?: boolean | null;
  nsfwAttempted?: boolean;
  nsfwAt?: string | null;
  nsfwError?: string | null;
  /** ok | fail | none */
  nsfwStatus?: 'ok' | 'fail' | 'none';
  /** ZDR：true=已关 / false=仍开或失败 / null=未尝试 */
  zdrClosed?: boolean | null;
  zdrAttempted?: boolean;
  zdrAt?: string | null;
  zdrError?: string | null;
  /** closed | open | none */
  zdrStatus?: 'closed' | 'open' | 'none';
  /** 推送状态：ok=成功 / fail=失败 / none=未推送 */
  ssoG2Status?: 'ok' | 'fail' | 'none';
  authCpaStatus?: 'ok' | 'fail' | 'none';
  authSub2apiStatus?: 'ok' | 'fail' | 'none';
  ssoG2At?: string | null;
  authCpaAt?: string | null;
  authSub2apiAt?: string | null;
  ssoG2Error?: string | null;
  authCpaError?: string | null;
  authSub2apiError?: string | null;
  /** 已成功推送到远程 CPA */
  pushedCpa?: boolean;
  pushedCpaAt?: string | null;
  /** 已成功推送到 sub2api (S2A) */
  pushedS2a?: boolean;
  pushedS2aAt?: string | null;
}

/** 规范化 SSO cookie / JWT 文本后做 SHA-256 hex */
export function normalizeSsoToken(sso: string): string {
  return String(sso || '')
    .trim()
    .replace(/^sso=/i, '')
    .trim();
}

export function hashSsoToken(sso: string): string | null {
  const token = normalizeSsoToken(sso);
  if (!token || token.length < 8) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}



/** 在 auth JSON 上写入推送成功标记（CPA / S2A） */
async function stampAuthPushFlags(
  jobs: { path?: string; filename?: string }[],
  flags: { pushedCpa?: boolean; pushedS2a?: boolean }
): Promise<void> {
  const now = new Date().toISOString();
  for (const job of jobs) {
    const fp = String(job.path || '').trim();
    if (!fp || !existsSync(fp)) continue;
    try {
      const raw = await fsp.readFile(fp, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (flags.pushedCpa) {
        data.pushed_cpa = true;
        data.pushedCpa = true;
        data.pushed_cpa_at = now;
        data.pushedCpaAt = now;
      }
      if (flags.pushedS2a) {
        data.pushed_s2a = true;
        data.pushedS2a = true;
        data.pushed_s2a_at = now;
        data.pushedS2aAt = now;
      }
      await fsp.writeFile(fp, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      /* ignore single file */
    }
  }
}

function extractSsoFromAuthData(data: Record<string, unknown>): string {
  const direct = data.sso;
  if (typeof direct === 'string' && direct.trim()) return direct;
  // 兼容嵌套 / extra
  const extra = data.extra;
  if (extra && typeof extra === 'object') {
    const s = (extra as Record<string, unknown>).sso;
    if (typeof s === 'string' && s.trim()) return s;
  }
  return '';
}

export interface CpaRemoteResult {
  ok: boolean;
  url?: string;
  name?: string;
  error?: string;
}

export interface CpaAuthBatchResultItem {
  filename?: string;
  email?: string;
  ok: boolean;
  error?: string;
  mode?: string;
  path?: string;
  xai?: boolean;
  xaiFilename?: boolean;
  xaiType?: boolean;
  /** mint 预检：alive | dead | banned | unknown | bot_flag */
  verdict?: string;
  skipped?: boolean;
  botFlagSource?: number | string | null;
  isBotFlag1?: boolean;
  /** cehuo 风格 CPA /responses 测活 */
  probeAction?: string;
  probeHttp?: number;
  probeDeleted?: boolean;
  /** Management API 远程推送结果（未配置时 undefined） */
  remoteOk?: boolean | null;
  remoteError?: string;
  remoteName?: string;
  /** 重签时从号池按 email 补了 SSO */
  ssoFromPool?: boolean;
  /** 失败原因：timeout|rate_limit|no_sso|no_refresh|refresh_dead|sso_dead|banned|bot_flag|network|probe_dead|python_error|unknown */
  failReason?: string;
}

function parseRemoteField(raw: unknown): {
  remoteOk?: boolean | null;
  remoteError?: string;
  remoteName?: string;
  remote?: CpaRemoteResult | null;
} {
  if (raw == null) {
    return { remoteOk: null, remote: null };
  }
  if (typeof raw !== 'object') {
    return { remoteOk: null, remote: null };
  }
  const o = raw as Record<string, unknown>;
  const ok = o.ok !== false && !o.error;
  const err = o.error != null ? String(o.error) : undefined;
  const name = o.name != null ? String(o.name) : undefined;
  const url = o.url != null ? String(o.url) : undefined;
  return {
    remoteOk: ok,
    remoteError: err,
    remoteName: name,
    remote: { ok, url, name, error: err }
  };
}

function resolveAuthDir(_configured?: string): string {
  // 已移除自定义 Auth 目录；仅 DATA_DIR/auth 或环境变量 AUTH_DIR / CPA_AUTH_DIR
  const env = (process.env.AUTH_DIR || process.env.CPA_AUTH_DIR || '').trim();
  if (env) return resolve(env);
  return join(dataDir(), 'auth');
}

function xaiFlags(filename: string, data: Record<string, unknown>) {
  const authType = String(data.type || '').trim();
  const xaiFilename = /^xai-/i.test(filename);
  const xaiType = authType.toLowerCase() === 'xai';
  return {
    authType,
    xaiFilename,
    xaiType,
    xai: xaiFilename || xaiType
  };
}

/** mint 通道：A=pkce / B=device（文件字段或文件名后缀） */
function resolveMintChannel(
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
  // 无后缀的旧文件：默认按 A（PKCE 单通道历史产出）
  if (/^xai-/i.test(filename)) return 'A';
  return null;
}

function assertInsideAuthDir(resolved: string, authRoot: string) {
  const root = resolve(authRoot);
  const target = resolve(resolved);
  const sep = process.platform === 'win32' ? '\\' : '/';
  const ok =
    target === root ||
    target.startsWith(root + sep) ||
    target.toLowerCase().startsWith(root.toLowerCase() + sep) ||
    target.toLowerCase() === root.toLowerCase();
  if (!ok) throw new Error('只能操作 auth 目录内的文件');
}

function runPythonJson(
  pythonPath: string,
  registerDir: string,
  code: string,
  args: string[],
  opts?: {
    /** 流式 stderr 行（重登进度等）；不阻塞 JSON 解析 */
    onStderrLine?: (line: string) => void;
  }
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, ['-c', code, ...args], {
      cwd: registerDir,
      env: { ...process.env },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let stderrBuf = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      const chunk = String(d);
      stderr += chunk;
      if (opts?.onStderrLine) {
        stderrBuf += chunk;
        const parts = stderrBuf.split(/\r?\n/);
        stderrBuf = parts.pop() ?? '';
        for (const line of parts) {
          const t = line.trim();
          if (t) opts.onStderrLine(t);
        }
      }
    });
    child.on('error', (err) => reject(err));
    child.on('close', (codeExit) => {
      if (opts?.onStderrLine && stderrBuf.trim()) {
        opts.onStderrLine(stderrBuf.trim());
        stderrBuf = '';
      }
      const line = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      if (line) {
        try {
          resolvePromise(JSON.parse(line) as Record<string, unknown>);
          return;
        } catch {
          /* fallthrough */
        }
      }
      if (codeExit !== 0) {
        reject(new Error(stderr.trim() || `python exit ${codeExit}`));
        return;
      }
      reject(new Error(stderr.trim() || 'python returned no JSON'));
    });
  });
}

function emitReloginProgress(input: {
  filename: string;
  email?: string;
  stage: ReloginStage;
  message?: string;
}): void {
  broadcastAppEvent({
    type: 'relogin_progress',
    filename: input.filename,
    email: input.email,
    stage: input.stage,
    message: input.message,
    ts: Date.now()
  });
}

/** 从 Python stderr 解析 stage=xxx */
function parseReloginStageLine(
  line: string
): { stage: ReloginStage; message: string } | null {
  const s = String(line || '').trim();
  if (!s) return null;
  // [relogin] stage=login msg=...
  const m = s.match(/stage\s*=\s*(queued|checking|login|mint|activate|probe|done|error)\b/i);
  if (m) {
    const stage = m[1].toLowerCase() as ReloginStage;
    const msgM = s.match(/\bmsg\s*=\s*(.+)$/i);
    return { stage, message: msgM ? msgM[1].trim() : s };
  }
  // 兼容 password_login / recover 文案
  if (/password_login|登录|login/i.test(s) && !/mint|activate|probe/i.test(s)) {
    return { stage: 'login', message: s };
  }
  if (/\bmint\b|sso.?→.?cpa|SSO→CPA|Auth Code/i.test(s)) {
    return { stage: 'mint', message: s };
  }
  if (/message|activate|激活|warm-?up|greeting/i.test(s)) {
    return { stage: 'activate', message: s };
  }
  if (/second_probe|二次|probe|测活/i.test(s)) {
    return { stage: 'probe', message: s };
  }
  if (/\[relogin\]\s*done/i.test(s)) {
    return { stage: 'done', message: s };
  }
  if (/\[relogin\]\s*start/i.test(s)) {
    return { stage: 'login', message: s };
  }
  return null;
}

async function readXaiAfter(path: string): Promise<{
  xai: boolean;
  xaiFilename: boolean;
  xaiType: boolean;
  authType: string;
}> {
  const name = basename(path);
  try {
    const data = JSON.parse(await fsp.readFile(path, 'utf-8')) as Record<string, unknown>;
    return xaiFlags(name, data);
  } catch {
    return { ...xaiFlags(name, {}), authType: '' };
  }
}

/** 号池：email(lower) → 是否有非空密码（重登前置）；不走 tags 全量 merge */
async function buildPoolPasswordMap(): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  try {
    const { listAccountsLite } = await import('./accountStore.js');
    const accounts = await listAccountsLite();
    for (const a of accounts) {
      const email = String(a.email || '').trim().toLowerCase();
      if (!email) continue;
      const has = Boolean(String(a.password || '').trim());
      if (has || !map.has(email)) map.set(email, has || Boolean(map.get(email)));
    }
  } catch {
    /* 无号池 */
  }
  return map;
}

/** 号池：email(lower) → 最新非空 SSO（重签缺 sso 时自动补） */
async function buildPoolEmailToSsoMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const created = new Map<string, string>();
  try {
    const { listAccountsLite } = await import('./accountStore.js');
    const accounts = await listAccountsLite();
    for (const a of accounts) {
      const email = String(a.email || '')
        .trim()
        .toLowerCase();
      const sso = normalizeSsoToken(String(a.sso || ''));
      if (!email || !sso || sso.length < 8) continue;
      const ca = String(a.createdAt || '');
      const prevCa = created.get(email) || '';
      if (!map.has(email) || ca > prevCa) {
        map.set(email, sso);
        created.set(email, ca);
      }
    }
  } catch {
    /* 无号池 */
  }
  return map;
}


let listCpaAuthCache: {
  at: number;
  mtimeMs: number;
  dir: string;
  items: CpaAuthItem[];
} | null = null;
const LIST_CPA_AUTH_TTL_MS = 20_000;

/** Auth 目录变更后清列表缓存（与号池 auth 索引失效一起调用） */
export function invalidateCpaAuthListCache(): void {
  listCpaAuthCache = null;
}

async function authDirMtimeMs(dir: string): Promise<number> {
  try {
    const st = await fsp.stat(dir);
    return Number(st.mtimeMs) || 0;
  } catch {
    return 0;
  }
}

export async function listCpaAuth(opts?: {
  force?: boolean;
}): Promise<{ dir: string; items: CpaAuthItem[] }> {
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  if (!existsSync(dir)) {
    listCpaAuthCache = null;
    return { dir, items: [] };
  }
  const mtimeMs = await authDirMtimeMs(dir);
  const now = Date.now();
  if (
    !opts?.force &&
    listCpaAuthCache &&
    listCpaAuthCache.dir === dir &&
    listCpaAuthCache.mtimeMs === mtimeMs &&
    now - listCpaAuthCache.at < LIST_CPA_AUTH_TTL_MS
  ) {
    return { dir, items: listCpaAuthCache.items };
  }

  const poolPw = await buildPoolPasswordMap();
  const { loadAccountTagsAsync } = await import('./accountTags.js');
  const accountTags = await loadAccountTagsAsync();
  const names = await fsp.readdir(dir);
  const jsonNames = names.filter((n) => n.endsWith('.json'));
  const items: CpaAuthItem[] = [];
  // 并发读目录，冷扫延迟对齐 badge-index
  const concurrency = 24;
  let cursor = 0;
  async function scanOne(name: string): Promise<CpaAuthItem | null> {
    const full = join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile() || st.size > 2_000_000) return null;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(await fsp.readFile(full, 'utf-8')) as Record<string, unknown>;
      } catch {
        data = {};
      }
      const flags = xaiFlags(name, data);
      // 列表冷扫：侧车优先，无侧车不 decode JWT
      const bot = readBotFlagFromAuthRecord(data, { jwt: false });
      const rawSso = extractSsoFromAuthData(data);
      // 优先预计算 sso_hash 字段，避免对长 JWT 再 sha256
      let ssoHash: string | null = null;
      const preHash = String(data.sso_hash || data.ssoHash || '')
        .trim()
        .toLowerCase();
      if (/^[a-f0-9]{64}$/.test(preHash)) {
        ssoHash = preHash;
      } else {
        ssoHash = hashSsoToken(rawSso);
      }
      const hasSso = Boolean((rawSso && rawSso.trim()) || ssoHash);
      // 0 是合法 None：禁止用 !bot.botFlagSource / || null 吞掉
      let botFlagSource: number | string | null =
        bot.botFlagSource !== undefined && bot.botFlagSource !== null && bot.botFlagSource !== ''
          ? bot.botFlagSource
          : null;
      // 有 sso 仍无 claim：默认 None(0)，Auth 列表显示绿 None
      if (botFlagSource == null && hasSso) {
        botFlagSource = 0;
      }
      // 持久化测活：auth JSON 内 probe_action / probe_http / probe_at
      const probeActionRaw = String(data.probe_action || data.probeAction || '').trim();
      const probeAction = probeActionRaw || null;
      let probeHttp: number | null = null;
      const httpRaw = data.probe_http ?? data.probeHttp;
      if (httpRaw != null && httpRaw !== '') {
        const n = Number(httpRaw);
        if (Number.isFinite(n) && n > 0) probeHttp = n;
      }
      const probeAtRaw = String(data.probe_at || data.probeAt || '').trim();
      const probeAt = probeAtRaw || null;
      const emailStr = String(data.email || '');
      const poolHasPassword = emailStr
        ? Boolean(poolPw.get(emailStr.trim().toLowerCase()))
        : false;
      const pushedCpa =
        data.pushed_cpa === true ||
        data.pushedCpa === true ||
        data.remote_pushed_cpa === true;
      const pushedCpaAt = String(
        data.pushed_cpa_at || data.pushedCpaAt || ''
      ).trim() || null;
      const pushedS2a =
        data.pushed_s2a === true ||
        data.pushedS2a === true ||
        data.remote_pushed_s2a === true;
      const pushedS2aAt = String(
        data.pushed_s2a_at || data.pushedS2aAt || ''
      ).trim() || null;
      // NSFW：侧车 account_tags（DATA_DIR 持久）优先；auth JSON 作回退
      // 重 mint 可能冲掉 auth 内字段，侧车才是真相源
      let nsfwEnabled: boolean | null = null;
      let nsfwAttempted = false;
      let nsfwAt: string | null = null;
      let nsfwError: string | null = null;
      const sideNsfw = nsfwStatusFromTag(
        lookupNsfwTag(accountTags, {
          email: emailStr,
          ssoHash: ssoHash || undefined
        })
      );
      if (sideNsfw.nsfwAttempted) {
        nsfwEnabled = sideNsfw.nsfwEnabled;
        nsfwAttempted = true;
        nsfwAt = sideNsfw.nsfwAt || null;
        nsfwError = sideNsfw.nsfwError || null;
      } else if (data.nsfw_attempted === true || data.nsfwAttempted === true) {
        nsfwAttempted = true;
        nsfwEnabled = data.nsfw_enabled === true || data.nsfwEnabled === true;
        nsfwAt = String(data.nsfw_at || data.nsfwAt || '').trim() || null;
        nsfwError = String(data.nsfw_error || data.nsfwError || '').trim() || null;
      }
      const nsfwStatus: 'ok' | 'fail' | 'none' = !nsfwAttempted
        ? 'none'
        : nsfwEnabled
          ? 'ok'
          : 'fail';
      // ZDR：auth JSON 优先，否则侧车
      let zdrClosed: boolean | null = null;
      let zdrAttempted = false;
      let zdrAt: string | null = null;
      let zdrError: string | null = null;
      if (data.zdr_attempted === true || data.zdrAttempted === true) {
        zdrAttempted = true;
        zdrClosed = data.zdr_closed === true || data.zdrClosed === true;
        zdrAt = String(data.zdr_at || data.zdrAt || '').trim() || null;
        zdrError = String(data.zdr_error || data.zdrError || '').trim() || null;
      } else {
        const sideZ = zdrStatusFromTag(
          lookupNsfwTag(accountTags, {
            email: emailStr,
            ssoHash: ssoHash || undefined
          })
        );
        zdrClosed = sideZ.zdrClosed;
        zdrAttempted = sideZ.zdrAttempted;
        zdrAt = sideZ.zdrAt || null;
        zdrError = sideZ.zdrError || null;
      }
      const zdrStatus: 'closed' | 'open' | 'none' = !zdrAttempted
        ? 'none'
        : zdrClosed
          ? 'closed'
          : 'open';
      const sideTag = lookupNsfwTag(accountTags, {
        email: emailStr,
        ssoHash: ssoHash || undefined
      });
      // auth JSON 内 push_* 字段作回退（侧车优先）
      const fileTag: AccountTagEntry = {
        push_sso_g2_ok: data.push_sso_g2_ok === true,
        push_sso_g2_attempted: data.push_sso_g2_attempted === true,
        push_sso_g2_at:
          typeof data.push_sso_g2_at === 'string' ? data.push_sso_g2_at : undefined,
        push_sso_g2_error:
          typeof data.push_sso_g2_error === 'string'
            ? data.push_sso_g2_error
            : undefined,
        push_auth_cpa_ok: data.push_auth_cpa_ok === true,
        push_auth_cpa_attempted: data.push_auth_cpa_attempted === true,
        push_auth_cpa_at:
          typeof data.push_auth_cpa_at === 'string' ? data.push_auth_cpa_at : undefined,
        push_auth_cpa_error:
          typeof data.push_auth_cpa_error === 'string'
            ? data.push_auth_cpa_error
            : undefined,
        push_auth_sub2api_ok: data.push_auth_sub2api_ok === true,
        push_auth_sub2api_attempted: data.push_auth_sub2api_attempted === true,
        push_auth_sub2api_at:
          typeof data.push_auth_sub2api_at === 'string'
            ? data.push_auth_sub2api_at
            : undefined,
        push_auth_sub2api_error:
          typeof data.push_auth_sub2api_error === 'string'
            ? data.push_auth_sub2api_error
            : undefined
      };
      const mergedPushTag: AccountTagEntry = { ...fileTag, ...(sideTag || {}) };
      const pushSt = allPushStatusesFromTag(mergedPushTag);
      return {
        filename: name,
        path: full,
        email: emailStr,
        sub: String(data.sub || ''),
        expired: String(data.expired || ''),
        disabled: Boolean(data.disabled),
        hasRefresh: Boolean(data.refresh_token),
        mtime: st.mtimeMs,
        botFlagSource,
        isBotFlag1: Boolean(bot.isBotFlag1),
        ssoHash,
        hasSso,
        mintChannel: resolveMintChannel(name, data),
        probeAction,
        probeHttp,
        probeAt,
        poolHasPassword,
        nsfwEnabled,
        nsfwAttempted,
        nsfwAt,
        nsfwError,
        nsfwStatus,
        pushedCpa,
        pushedCpaAt,
        pushedS2a,
        pushedS2aAt,
        zdrClosed,
        zdrAttempted,
        zdrAt,
        zdrError,
        zdrStatus,
        ssoG2Status: pushSt.ssoG2Status,
        authCpaStatus: pushSt.authCpaStatus,
        authSub2apiStatus: pushSt.authSub2apiStatus,
        ssoG2At: pushSt.ssoG2At || null,
        authCpaAt: pushSt.authCpaAt || null,
        authSub2apiAt: pushSt.authSub2apiAt || null,
        ssoG2Error: pushSt.ssoG2Error || null,
        authCpaError: pushSt.authCpaError || null,
        authSub2apiError: pushSt.authSub2apiError || null,
        ...flags
      };
    } catch {
      return null;
    }
  }
  async function worker() {
    while (cursor < jsonNames.length) {
      const i = cursor++;
      const name = jsonNames[i]!;
      const item = await scanOne(name);
      if (item) items.push(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jsonNames.length || 1) }, () => worker())
  );
  items.sort((a, b) => b.mtime - a.mtime);

  // 无 sso 时无法做号池 SSO 哈希匹配（仅靠 email）
  const missingSso = items.filter((i) => !i.hasSso);
  if (missingSso.length > 0) {
    const sample = missingSso
      .slice(0, 8)
      .map((i) => i.filename)
      .join(', ');
    const more = missingSso.length > 8 ? ` …等共 ${missingSso.length} 个` : '';
    console.warn(
      `[cpa-auth] ${missingSso.length} 个 auth 文件无 sso 字段，无法 hash 匹配号池` +
        `（仅靠 email）。可用「回填 SSO」从号池反写。示例: ${sample}${more}`
    );
  }

  listCpaAuthCache = { at: Date.now(), mtimeMs, dir, items };
  return { dir, items };
}

export type CpaAuthListQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  /** all | no_sso | no_email | need_fill */
  meta?: string;
  /** all | unprobed | 200 | 401 | 403 | other_err */
  status?: string;
  /** all | cpa_none | cpa_ok | cpa_fail | s2a_none | s2a_ok | s2a_fail */
  push?: string;
};

export type CpaAuthListFacets = {
  all: number;
  xai: number;
  noSso: number;
  noEmail: number;
  needFill: number;
  unprobed: number;
  http200: number;
  http401: number;
  http403: number;
  otherErr: number;
  cpaNone: number;
  cpaOk: number;
  cpaFail: number;
  s2aNone: number;
  s2aOk: number;
  s2aFail: number;
};

export type CpaAuthListPage = {
  dir: string;
  items: CpaAuthItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: CpaAuthListFacets;
};

function matchCpaAuthItem(i: CpaAuthItem, opts: CpaAuthListQuery): boolean {
  const meta = String(opts.meta || 'all').trim().toLowerCase();
  const hasSso = Boolean(i.hasSso);
  const hasEmail = Boolean(String(i.email || '').trim());
  if (meta === 'no_sso' && hasSso) return false;
  if (meta === 'no_email' && hasEmail) return false;
  if (meta === 'need_fill' && hasSso && hasEmail) return false;

  const status = String(opts.status || 'all').trim().toLowerCase();
  if (status !== 'all') {
    const http = Number(i.probeHttp || 0) || 0;
    const action = String(i.probeAction || '').trim();
    const probed = Boolean(action) || http > 0;
    if (status === 'unprobed') {
      if (probed) return false;
    } else if (status === '200') {
      if (http !== 200 && action !== 'ok') return false;
    } else if (status === '401') {
      if (http !== 401) return false;
    } else if (status === '403') {
      if (http !== 403) return false;
    } else if (status === 'other_err') {
      if (!probed) return false;
      if (http === 200 || action === 'ok' || http === 401 || http === 403) return false;
    }
  }

  const push = String(opts.push || 'all').trim().toLowerCase();
  if (push !== 'all') {
    const cpa = i.authCpaStatus ?? 'none';
    const s2a = i.authSub2apiStatus ?? 'none';
    if (push === 'cpa_none' && cpa !== 'none') return false;
    if (push === 'cpa_ok' && cpa !== 'ok') return false;
    if (push === 'cpa_fail' && cpa !== 'fail') return false;
    if (push === 's2a_none' && s2a !== 'none') return false;
    if (push === 's2a_ok' && s2a !== 'ok') return false;
    if (push === 's2a_fail' && s2a !== 'fail') return false;
  }

  const q = String(opts.q || '').trim().toLowerCase();
  if (q) {
    const email = String(i.email || '').toLowerCase();
    const fn = String(i.filename || '').toLowerCase();
    const sub = String(i.sub || '').toLowerCase();
    if (!email.includes(q) && !fn.includes(q) && !sub.includes(q)) return false;
  }
  return true;
}

function buildCpaAuthFacets(all: CpaAuthItem[]): CpaAuthListFacets {
  let xai = 0;
  let noSso = 0;
  let noEmail = 0;
  let needFill = 0;
  let unprobed = 0;
  let http200 = 0;
  let http401 = 0;
  let http403 = 0;
  let otherErr = 0;
  let cpaNone = 0;
  let cpaOk = 0;
  let cpaFail = 0;
  let s2aNone = 0;
  let s2aOk = 0;
  let s2aFail = 0;
  for (const i of all) {
    if (i.xai) xai++;
    const hasSso = Boolean(i.hasSso);
    const hasEmail = Boolean(String(i.email || '').trim());
    if (!hasSso) noSso++;
    if (!hasEmail) noEmail++;
    if (!hasSso || !hasEmail) needFill++;
    const http = Number(i.probeHttp || 0) || 0;
    const action = String(i.probeAction || '').trim();
    const probed = Boolean(action) || http > 0;
    if (!probed) unprobed++;
    else if (http === 200 || action === 'ok') http200++;
    else if (http === 401) http401++;
    else if (http === 403) http403++;
    else otherErr++;

    const cpa = i.authCpaStatus ?? 'none';
    const s2a = i.authSub2apiStatus ?? 'none';
    if (cpa === 'ok') cpaOk++;
    else if (cpa === 'fail') cpaFail++;
    else cpaNone++;
    if (s2a === 'ok') s2aOk++;
    else if (s2a === 'fail') s2aFail++;
    else s2aNone++;
  }
  return {
    all: all.length,
    xai,
    noSso,
    noEmail,
    needFill,
    unprobed,
    http200,
    http401,
    http403,
    otherErr,
    cpaNone,
    cpaOk,
    cpaFail,
    s2aNone,
    s2aOk,
    s2aFail
  };
}

/** 列表出口瘦身：UI 用状态枚举；省略 path/ssoHash/长 At 明细 */
function toCpaAuthListRow(i: CpaAuthItem): CpaAuthItem {
  const trimErr = (v?: string | null) => {
    const s = String(v || '').trim();
    if (!s) return null;
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  };
  return {
    filename: i.filename,
    path: '',
    email: i.email,
    sub: i.sub || '',
    expired: i.expired,
    disabled: i.disabled,
    hasRefresh: i.hasRefresh,
    mtime: i.mtime,
    xaiFilename: i.xaiFilename,
    xaiType: i.xaiType,
    xai: i.xai,
    authType: i.authType,
    botFlagSource: i.botFlagSource,
    isBotFlag1: i.isBotFlag1,
    // 列表不返回 ssoHash（交叉用 badge-index）；省带宽
    ssoHash: null,
    hasSso: i.hasSso,
    mintChannel: i.mintChannel,
    probeAction: i.probeAction,
    probeHttp: i.probeHttp,
    probeAt: null,
    poolHasPassword: i.poolHasPassword,
    nsfwEnabled: i.nsfwEnabled,
    nsfwAttempted: i.nsfwAttempted,
    nsfwAt: null,
    nsfwError: trimErr(i.nsfwError),
    nsfwStatus: i.nsfwStatus,
    zdrClosed: i.zdrClosed,
    zdrAttempted: i.zdrAttempted,
    zdrAt: null,
    zdrError: trimErr(i.zdrError),
    zdrStatus: i.zdrStatus,
    ssoG2Status: i.ssoG2Status,
    authCpaStatus: i.authCpaStatus,
    authSub2apiStatus: i.authSub2apiStatus,
    ssoG2At: null,
    authCpaAt: null,
    authSub2apiAt: null,
    ssoG2Error: trimErr(i.ssoG2Error),
    authCpaError: trimErr(i.authCpaError),
    authSub2apiError: trimErr(i.authSub2apiError)
  };
}

/** 服务端筛选 + 分页（底层 list 带 mtime 缓存） */
export async function queryCpaAuth(opts: CpaAuthListQuery = {}): Promise<CpaAuthListPage> {
  const { dir, items: all } = await listCpaAuth();
  const facets = buildCpaAuthFacets(all);
  const filtered = all.filter((i) => matchCpaAuthItem(i, opts));
  const pageSize = Math.min(2000, Math.max(1, Math.floor(Number(opts.pageSize) || 20)));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(opts.page) || 1)));
  const start = (page - 1) * pageSize;
  return {
    dir,
    items: filtered.slice(start, start + pageSize).map(toCpaAuthListRow),
    total,
    page,
    pageSize,
    totalPages,
    facets
  };
}

export type CpaAuthMatchQuery = CpaAuthListQuery & {
  /** 最多返回条数（默认 500，硬顶 2000） */
  limit?: number;
  /** 仅返回有 sso 的 */
  requireSso?: boolean;
  /** 仅返回缺 sso 的 */
  requireMissingSso?: boolean;
  /** 仅返回有邮箱的 */
  requireEmail?: boolean;
};

export type CpaAuthMatchItem = {
  filename: string;
  email: string;
  hasSso: boolean;
  hasRefresh: boolean;
  probeHttp?: number | null;
  probeAction?: string | null;
};

export type CpaAuthMatchResult = {
  dir: string;
  items: CpaAuthMatchItem[];
  total: number;
  returned: number;
  truncated: boolean;
  limit: number;
};

/**
 * 按筛选返回匹配 filename 列表（批量测活/重签/推送/导出用）。
 * 不返回完整 CpaAuthItem，避免大批量 JSON。
 */
export async function matchCpaAuth(opts: CpaAuthMatchQuery = {}): Promise<CpaAuthMatchResult> {
  const { dir, items: all } = await listCpaAuth();
  let filtered = all.filter((i) => matchCpaAuthItem(i, opts));
  if (opts.requireSso) {
    filtered = filtered.filter((i) => Boolean(i.hasSso));
  }
  if (opts.requireMissingSso) {
    filtered = filtered.filter((i) => !i.hasSso);
  }
  if (opts.requireEmail) {
    filtered = filtered.filter((i) => Boolean(String(i.email || '').trim()));
  }
  const limit = Math.min(2000, Math.max(1, Math.floor(Number(opts.limit) || 500)));
  const total = filtered.length;
  const slice = filtered.slice(0, limit);
  return {
    dir,
    items: slice.map((i) => ({
      filename: i.filename,
      email: String(i.email || ''),
      hasSso: Boolean(i.hasSso),
      hasRefresh: Boolean(i.hasRefresh),
      probeHttp: i.probeHttp ?? null,
      probeAction: i.probeAction ?? null
    })),
    total,
    returned: slice.length,
    truncated: total > slice.length,
    limit
  };
}

export interface BackfillCpaAuthSsoResult {
  dir: string;
  scanned: number;
  /** 已有 sso 且未 force 覆盖 */
  alreadyHasSso: number;
  /** 成功写入 sso */
  filled: number;
  /** 无邮箱 */
  skippedNoEmail: number;
  /** 号池无同邮箱 SSO */
  skippedNoMatch: number;
  failed: number;
  dryRun: boolean;
  results: Array<{
    filename: string;
    email: string;
    ok: boolean;
    action: 'filled' | 'already' | 'no_email' | 'no_match' | 'failed' | 'would_fill';
    error?: string;
  }>;
}

/**
 * 从号池按 email（忽略大小写）给 auth 目录回填顶层 sso。
 * 用于旧 mint 产物无 sso 字段、号池无邮箱时无法 hash 匹配的场景。
 */
export async function backfillCpaAuthSsoFromPool(input?: {
  /** 仅处理这些文件名；空=全部 .json */
  filenames?: string[];
  /** true 时已有 sso 也覆盖为号池最新匹配 */
  force?: boolean;
  /** 只统计不写盘 */
  dryRun?: boolean;
}): Promise<BackfillCpaAuthSsoResult> {
  const { listAccounts } = await import('./accountStore.js');
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  const force = Boolean(input?.force);
  const dryRun = Boolean(input?.dryRun);
  const filterNames = new Set(
    (Array.isArray(input?.filenames) ? input!.filenames : [])
      .map((f) => basename(String(f || '').trim()))
      .filter((f) => f.endsWith('.json'))
  );

  const { listAccountsLite } = await import('./accountStore.js');
  const accounts = await listAccountsLite();
  // email(lower) → 最佳 sso（有 sso 的优先，createdAt 新的优先）
  const emailToSso = new Map<string, { sso: string; createdAt: string }>();
  for (const a of accounts) {
    const email = String(a.email || '')
      .trim()
      .toLowerCase();
    const sso = normalizeSsoToken(a.sso);
    if (!email || !sso || sso.length < 8) continue;
    const prev = emailToSso.get(email);
    if (!prev || String(a.createdAt || '') > prev.createdAt) {
      emailToSso.set(email, { sso, createdAt: String(a.createdAt || '') });
    }
  }

  const empty: BackfillCpaAuthSsoResult = {
    dir,
    scanned: 0,
    alreadyHasSso: 0,
    filled: 0,
    skippedNoEmail: 0,
    skippedNoMatch: 0,
    failed: 0,
    dryRun,
    results: []
  };
  if (!existsSync(dir)) return empty;

  const names = await fsp.readdir(dir);
  const results: BackfillCpaAuthSsoResult['results'] = [];
  let scanned = 0;
  let alreadyHasSso = 0;
  let filled = 0;
  let skippedNoEmail = 0;
  let skippedNoMatch = 0;
  let failed = 0;

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (filterNames.size > 0 && !filterNames.has(name)) continue;
    const full = join(dir, name);
    scanned++;
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(await fsp.readFile(full, 'utf-8')) as Record<string, unknown>;
      } catch (e) {
        failed++;
        results.push({
          filename: name,
          email: '',
          ok: false,
          action: 'failed',
          error: e instanceof Error ? e.message : String(e)
        });
        continue;
      }

      const email = String(data.email || '')
        .trim()
        .toLowerCase();
      const existing = extractSsoFromAuthData(data);
      if (existing && !force) {
        alreadyHasSso++;
        results.push({
          filename: name,
          email: String(data.email || ''),
          ok: true,
          action: 'already'
        });
        continue;
      }
      if (!email) {
        skippedNoEmail++;
        results.push({
          filename: name,
          email: '',
          ok: false,
          action: 'no_email'
        });
        continue;
      }
      const hit = emailToSso.get(email);
      if (!hit) {
        skippedNoMatch++;
        results.push({
          filename: name,
          email: String(data.email || ''),
          ok: false,
          action: 'no_match'
        });
        continue;
      }

      if (dryRun) {
        filled++;
        results.push({
          filename: name,
          email: String(data.email || ''),
          ok: true,
          action: 'would_fill'
        });
        continue;
      }

      data.sso = hit.sso;
      const h = hashSsoToken(hit.sso);
      if (h) data.sso_hash = h;
      // 回填时补侧车 bot_flag，避免列表再 decode JWT
      try {
        const bot = readBotFlagFromAuthRecord(data);
        if (bot.botFlagSource != null && bot.botFlagSource !== '') {
          data.bot_flag_source = bot.botFlagSource;
        } else if (hit.sso) {
          data.bot_flag_source = 0;
        }
      } catch {
        if (hit.sso) data.bot_flag_source = 0;
      }
      const tmp = `${full}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      await fsp.rename(tmp, full);
      filled++;
      results.push({
        filename: name,
        email: String(data.email || ''),
        ok: true,
        action: 'filled'
      });
    } catch (e) {
      failed++;
      results.push({
        filename: name,
        email: '',
        ok: false,
        action: 'failed',
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  console.log(
    `[cpa-auth] backfill sso: scanned=${scanned} filled=${filled} already=${alreadyHasSso} ` +
      `noEmail=${skippedNoEmail} noMatch=${skippedNoMatch} failed=${failed} dryRun=${dryRun}`
  );

  return {
    dir,
    scanned,
    alreadyHasSso,
    filled,
    skippedNoEmail,
    skippedNoMatch,
    failed,
    dryRun,
    results
  };
}

export async function resignCpaAuth(input: {
  filename?: string;
  path?: string;
  sso?: string;
  /** 重签成功后是否推送到远程 CPA（默认 false） */
  pushRemote?: boolean;
  /**
   * 重签后 base_url 目标：
   * - "cli"（默认）→ https://cli-chat-proxy.grok.com/v1 满额度
   * - "api" → https://api.x.ai/v1 防风控更强、额度约 50%
   */
  baseUrlTarget?: 'cli' | 'api' | string;
}): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  let target = String(input.path || '').trim();
  if (!target && input.filename) {
    const name = basename(String(input.filename).trim());
    if (!name || name.includes('..') || !name.endsWith('.json')) {
      throw new Error('无效的 filename');
    }
    target = join(dir, name);
  }
  if (!target) throw new Error('缺少 path 或 filename');
  const resolved = resolve(target);
  assertInsideAuthDir(resolved, dir);
  if (!existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);

  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python 重签');

    // P4：入参无 sso 时读文件；仍无则按 email 从号池补 SSO
  let resolvedSso = String(input.sso || '').trim();
  let emailHint = '';
  try {
    const raw = await fsp.readFile(resolved, 'utf-8');
    const doc = JSON.parse(raw) as Record<string, unknown>;
    emailHint = String(doc.email || '').trim();
    if (!resolvedSso) {
      resolvedSso = extractSsoFromAuthData(doc);
    }
  } catch {
    /* ignore read */
  }
  let ssoFromPool = false;
  if (!resolvedSso && emailHint) {
    const poolSso = await buildPoolEmailToSsoMap();
    const hit = poolSso.get(emailHint.toLowerCase()) || '';
    if (hit) {
      resolvedSso = hit;
      ssoFromPool = true;
      console.log(
        `[cpa-auth] resign: filled sso from pool email=${emailHint.slice(0, 48)}`
      );
    }
  }

  const pushRemote = input.pushRemote === true;
  const baseUrlTarget = String(input.baseUrlTarget || 'cli').trim() || 'cli';
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from auth_service import resign_auth_file
path = sys.argv[1]
proxy = sys.argv[2] if len(sys.argv) > 2 else ""
sso = sys.argv[3] if len(sys.argv) > 3 else ""
push = (sys.argv[4] if len(sys.argv) > 4 else "0") == "1"
base_target = sys.argv[5] if len(sys.argv) > 5 else "cli"
# 重签强制 delete_on_dead=False，避免点重签后文件被 probe 删掉
r = resign_auth_file(
    path,
    sso=sso,
    proxy=proxy,
    push_remote=push,
    delete_on_dead=False,
    base_url_target=base_target,
)
print(json.dumps(r, ensure_ascii=False))
`.trim();

  const proxy = resolveHttpProxy(settings, 'cpaAuth');
  let r: Record<string, unknown>;
  const poolEnabled = settings.pythonPoolEnabled !== false;
  const poolSize = Math.min(
    4,
    Math.max(1, Number(settings.pythonPoolSize) || Number(settings.cpaResignConcurrency) || 2)
  );
  const poolTimeoutMs = Math.min(
    600_000,
    Math.max(10_000, (Number(settings.pythonPoolTimeoutSec) || 180) * 1000)
  );
  try {
    if (!poolEnabled) throw new Error('python pool disabled');
    const pool = getPythonJobPool(
      runtime.pythonPath,
      runtime.registerDir,
      poolSize,
      poolTimeoutMs
    );
    r = await pool.run({
      op: 'resign',
      path: resolved,
      sso: resolvedSso,
      proxy,
      pushRemote,
      baseUrlTarget
    });
  } catch (poolErr) {
    if (poolEnabled) {
      console.warn(
        '[cpa-auth] resign pool failed, fallback spawn:',
        poolErr instanceof Error ? poolErr.message : poolErr
      );
    }
    r = await runPythonJson(runtime.pythonPath, runtime.registerDir, code, [
      resolved,
      proxy,
      resolvedSso,
      pushRemote ? '1' : '0',
      baseUrlTarget
    ]);
  }

  const outPath = String(r.path || resolved);
  const flags = await readXaiAfter(outPath);
  const remote = parseRemoteField(r.remote);
  const mode = r.mode ? String(r.mode) : undefined;
  // 统一日志：mode=refresh | sso | none（password_relogin 走 relogin）
  console.log(
    `[cpa-auth] resign mode=${mode || '?'} file=${basename(outPath)} ` +
      `ok=${r.ok !== false && !r.error} proxy=${proxy ? 'yes' : 'no'}` +
      (r.error ? ` err=${String(r.error).slice(0, 120)}` : '')
  );
  return {
    ...r,
    filename: r.filename || basename(outPath),
    mode,
    ssoFromPool,
    ...flags,
    remoteOk: remote.remoteOk,
    remoteError: remote.remoteError,
    remoteName: remote.remoteName,
    remote: remote.remote
  };
}

export async function resignCpaAuthBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
  /** 重签成功后推送远程（默认 false） */
  pushRemote?: boolean;
  /** cli | api — 写入 base_url */
  baseUrlTarget?: 'cli' | 'api' | string;
  /** 每完成一条回调（NDJSON 流） */
  onItem?: (item: CpaAuthBatchResultItem) => void | Promise<void>;
  /** 客户端断开/取消时停止领取新任务 */
  isAborted?: () => boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  remoteOk?: number;
  remoteFailed?: number;
  ssoFromPool?: number;
  failReasons?: Record<string, number>;
  cancelled?: boolean;
  results: CpaAuthBatchResultItem[];
}> {
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename?: string; path?: string }[] = [];
  for (const f of names) {
    if (String(f || '').trim()) jobs.push({ filename: String(f).trim() });
  }
  for (const p of paths) {
    if (String(p || '').trim()) jobs.push({ path: String(p).trim() });
  }
  if (jobs.length === 0) throw new Error('缺少 filenames 或 paths');
  if (jobs.length > 200) throw new Error('单次批量重签最多 200 个');

  const settings = await loadSettings();
  // 并发上限：设置 cpaResignConcurrency（默认 2）硬顶 3，防 accounts.x.ai 限流
  const confCap = Math.min(
    3,
    Math.max(1, Number(settings.cpaResignConcurrency) || 2)
  );
  const concurrency = Math.min(
    confCap,
    Math.max(1, Number(input.concurrency) || confCap)
  );
  const pushRemote = input.pushRemote === true;
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;
  const gapMs = concurrency >= 3 ? 180 : concurrency === 2 ? 80 : 0;

  const emitItem = async (item: CpaAuthBatchResultItem) => {
    if (!item.ok && !item.failReason) {
      item.failReason = classifyAuthFailReason(item);
    }
    results.push(item);
    if (input.onItem) {
      try {
        await input.onItem(item);
      } catch {
        /* 流写失败不阻断 */
      }
    }
  };

  async function worker() {
    while (idx < jobs.length) {
      if (input.isAborted?.()) break;
      const i = idx++;
      const job = jobs[i];
      try {
        if (input.isAborted?.()) break;
        if (gapMs > 0 && i > 0) {
          await new Promise((r) => setTimeout(r, gapMs));
        }
        const r = await resignCpaAuth({ ...job, pushRemote, baseUrlTarget: input.baseUrlTarget });
        const probeObj =
          r.probe && typeof r.probe === 'object'
            ? (r.probe as Record<string, unknown>)
            : null;
        const itemOk = r.ok !== false && !r.error;
        const probeHttp = probeObj
          ? Number(probeObj.http_status || 0) || undefined
          : undefined;
        const probeAction = probeObj ? String(probeObj.action || '') : undefined;
        const errStr = r.error ? String(r.error) : undefined;
        const modeStr = r.mode ? String(r.mode) : undefined;
        await emitItem({
          filename: String(r.filename || job.filename || ''),
          email: String(r.email || ''),
          ok: itemOk,
          error: errStr,
          mode: modeStr,
          path: r.path ? String(r.path) : undefined,
          xai: Boolean(r.xai),
          xaiFilename: Boolean(r.xaiFilename),
          xaiType: Boolean(r.xaiType),
          probeAction,
          probeHttp,
          probeDeleted: Boolean(r.deleted) || Boolean(probeObj?.deleted),
          remoteOk:
            typeof r.remoteOk === 'boolean'
              ? r.remoteOk
              : r.remoteOk === null
                ? null
                : undefined,
          remoteError: r.remoteError ? String(r.remoteError) : undefined,
          remoteName: r.remoteName ? String(r.remoteName) : undefined,
          ssoFromPool: r.ssoFromPool === true,
          failReason: itemOk
            ? undefined
            : classifyAuthFailReason({
                ok: itemOk,
                error: errStr,
                mode: modeStr,
                probeHttp,
                probeAction
              })
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await emitItem({
          filename: job.filename || basename(job.path || ''),
          ok: false,
          error: errMsg,
          failReason: classifyAuthFailReason({ ok: false, error: errMsg, mode: 'error' })
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  const remoteOk = results.filter((r) => r.remoteOk === true).length;
  const remoteFailed = results.filter((r) => r.remoteOk === false).length;
  const ssoFromPool = results.filter((r) => r.ssoFromPool).length;
  const failReasons = summarizeFailReasons(results);
  const modeCounts: Record<string, number> = {};
  for (const r of results) {
    const m = r.mode || (r.ok ? 'ok' : 'error');
    modeCounts[m] = (modeCounts[m] || 0) + 1;
  }
  console.log(
    `[cpa-auth] resign-batch total=${results.length} ok=${ok} failed=${results.length - ok} ` +
      `concurrency=${concurrency} modes=${JSON.stringify(modeCounts)}`
  );
  const cancelled = Boolean(input.isAborted?.());
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    remoteOk,
    remoteFailed,
    ssoFromPool,
    failReasons,
    cancelled,
    results
  };
}

/**
 * 批量把已有 auth JSON 推到远程 CPA Management API（不重新 mint）。
 * POST {cpaRemoteUrl}/v0/management/auth-files?name=...
 */
export async function pushCpaAuthRemoteBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
  /** true：忽略 already_pushed，强制重新上传 */
  force?: boolean;
  onItem?: (item: CpaAuthBatchResultItem) => void | Promise<void>;
  isAborted?: () => boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  skipped?: number;
  cancelled?: boolean;
  remoteConfigured: boolean;
  remoteUrl?: string;
  /** mode 分布：uploaded / already_pushed / http_error / … */
  modeCounts?: Record<string, number>;
  failReasons?: Record<string, number>;
  results: CpaAuthBatchResultItem[];
}> {
  const settings = await loadSettings();
  let base = String(settings.cpaRemoteUrl || '').trim().replace(/\/+$/, '');
  const key = String(settings.cpaManagementKey || '').trim();
  if (base.endsWith('/v1')) base = base.slice(0, -3).replace(/\/+$/, '');

  if (!base || !key) {
    throw new Error(
      '未配置远程 CPA：请在设置中填写「远程 CPA 地址」与「远程 CPA 管理密钥」'
    );
  }

  const dir = resolveAuthDir(settings.authDir);
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename: string; path: string }[] = [];

  for (const f of names) {
    const name = String(f || '').trim();
    if (!name) continue;
    const full = join(dir, name);
    assertInsideAuthDir(full, dir);
    jobs.push({ filename: name, path: full });
  }
  for (const p of paths) {
    const full = resolve(String(p || '').trim());
    if (!full) continue;
    assertInsideAuthDir(full, dir);
    jobs.push({ filename: basename(full), path: full });
  }
  // 去重
  const seen = new Set<string>();
  const unique = jobs.filter((j) => {
    const k = j.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) throw new Error('缺少 filenames 或 paths');
  if (unique.length > 200) throw new Error('单次远程推送最多 200 个');

  const concurrency = Math.min(6, Math.max(1, Number(input.concurrency) || 3));
  const force = Boolean(input.force);
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;
  // 批次开始时快照侧车标签，用于 already_pushed 跳过（force 时忽略）
  const pushTagsSnapshot = await loadAccountTagsAsync();

  const emit = async (item: CpaAuthBatchResultItem) => {
    if (!item.ok && !item.failReason) {
      item.failReason = classifyPushFailReason(item);
    }
    results.push(item);
    if (input.onItem) {
      try {
        await input.onItem(item);
      } catch {
        /* ignore client callback errors */
      }
    }
  };

  async function worker() {
    while (idx < unique.length) {
      if (input.isAborted?.()) break;
      const i = idx++;
      const job = unique[i];
      try {
        if (!existsSync(job.path)) {
          await emit({
            filename: job.filename,
            ok: false,
            remoteOk: false,
            error: '文件不存在',
            remoteError: '文件不存在',
            mode: 'missing_file'
          });
          continue;
        }
        const raw = await fsp.readFile(job.path, 'utf-8');
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          await emit({
            filename: job.filename,
            ok: false,
            remoteOk: false,
            error: 'JSON 解析失败',
            remoteError: 'JSON 解析失败',
            mode: 'invalid_json'
          });
          continue;
        }
        const email = String(data.email || '');
        const sso = String(data.sso || '');
        const uploadName = job.filename.endsWith('.json')
          ? job.filename
          : `${job.filename}.json`;
        // 已成功推送过则跳过（force 时强制重推；与 Python is_push_ok 对齐）
        if (!force) {
          const tag = lookupNsfwTag(pushTagsSnapshot, { email, sso });
          if (isPushOkFromTag(tag, 'auth_cpa')) {
            await emit({
              filename: job.filename,
              email,
              ok: true,
              skipped: true,
              mode: 'already_pushed',
              remoteOk: true,
              remoteName: uploadName
            });
            continue;
          }
        }
        const url = `${base}/v0/management/auth-files?name=${encodeURIComponent(uploadName)}`;
        // 优先直连，失败再走代理（与 sub2api / mail 一致）
        const proxy = resolveHttpProxy(settings);
        const res = await requestWithProxyFallback(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: data,
          proxy,
          timeoutMs: 30000
        });
        if (res.status >= 400) {
          const body =
            typeof res.data === 'string'
              ? res.data
              : res.data != null
                ? JSON.stringify(res.data)
                : '';
          const msg = `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
          try {
            setPushTag({ channel: 'auth_cpa', ok: false, email, sso, error: msg });
          } catch {
            /* ignore */
          }
          await emit({
            filename: job.filename,
            email,
            ok: false,
            remoteOk: false,
            remoteError: msg,
            error: msg,
            remoteName: uploadName,
            mode: 'http_error'
          });
        } else {
          try {
            setPushTag({ channel: 'auth_cpa', ok: true, email, sso });
          } catch {
            /* ignore */
          }
          await emit({
            filename: job.filename,
            email,
            ok: true,
            remoteOk: true,
            remoteName: uploadName,
            mode: force ? 'reuploaded' : 'uploaded'
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          // email may be unavailable if parse failed earlier
          setPushTag({ channel: 'auth_cpa', ok: false, email: '', error: msg });
        } catch {
          /* ignore */
        }
        await emit({
          filename: job.filename,
          ok: false,
          remoteOk: false,
          error: msg,
          remoteError: msg,
          mode: 'error'
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // 成功项写入 auth JSON 推送标记
  try {
    const okJobs = results
      .filter((r) => r.ok)
      .map((r) => {
        const fn = String(r.filename || '');
        const full = jobs.find((j) => j.filename === fn)?.path || '';
        return { path: full, filename: fn };
      })
      .filter((j) => j.path);
    if (okJobs.length) await stampAuthPushFlags(okJobs, { pushedCpa: true });
  } catch {
    /* non-fatal */
  }
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const modeCounts: Record<string, number> = {};
  for (const r of results) {
    const m = r.mode || (r.ok ? (r.skipped ? 'already_pushed' : 'uploaded') : 'error');
    modeCounts[m] = (modeCounts[m] || 0) + 1;
  }
  for (const r of results) {
    if (!r.ok && !r.failReason) r.failReason = classifyPushFailReason(r);
  }
  const failReasons = summarizeFailReasons(results);
  const cancelled = Boolean(input.isAborted?.());
  console.log(
    `[cpa-auth] push-remote total=${results.length} ok=${ok} skipped=${skipped} ` +
      `failed=${results.length - ok} force=${force} cancelled=${cancelled} modes=${JSON.stringify(modeCounts)}`
  );
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    skipped,
    cancelled,
    remoteConfigured: true,
    remoteUrl: base,
    modeCounts,
    failReasons,
    results
  };
}


/**
 * 批量把已有 CPA auth 转为 sub2api 官方账号形态后推送（不重新 mint）。
 * 1) cpa_xai_to_sub2api_account  2) POST {sub2apiRemoteUrl}/api/v1/admin/accounts
 */
export async function pushSub2apiAuthRemoteBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
  /** true：忽略 already_pushed，强制重新上传 */
  force?: boolean;
  onItem?: (item: CpaAuthBatchResultItem) => void | Promise<void>;
  isAborted?: () => boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  skipped?: number;
  cancelled?: boolean;
  remoteConfigured: boolean;
  remoteUrl?: string;
  modeCounts?: Record<string, number>;
  failReasons?: Record<string, number>;
  results: CpaAuthBatchResultItem[];
}> {
  const settings = await loadSettings();
  const base = normalizeSub2apiBaseUrl(
    String((settings as { sub2apiRemoteUrl?: string }).sub2apiRemoteUrl || '')
  );
  const token = normalizeSub2apiAdminSecret(
    String((settings as { sub2apiAdminToken?: string }).sub2apiAdminToken || '')
  );

  if (!base || !token) {
    throw new Error(
      '未配置 sub2api：请在设置中填写「sub2api 地址」与「Admin Token」'
    );
  }

  const proxyForGroup = resolveHttpProxy(settings);
  const groupName = String(
    (settings as { sub2apiGroup?: string }).sub2apiGroup || ''
  ).trim();
  let resolvedGroupIds: Array<number | string> = [];
  if (groupName) {
    const resolved = await resolveSub2apiGroupIds(
      base,
      token,
      groupName,
      proxyForGroup
    );
    resolvedGroupIds = resolved.ids;
    if (resolvedGroupIds.length === 0) {
      throw new Error(
        `sub2api 分组「${groupName}」未找到对应 id。请在设置中点「刷新分组」后重选，或确认远端存在该分组`
      );
    }
    console.log(
      `[cpa-auth] push-sub2api group=${groupName} -> group_ids=${JSON.stringify(resolvedGroupIds)}`
    );
  }

  const dir = resolveAuthDir(settings.authDir);
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename: string; path: string }[] = [];

  for (const f of names) {
    const name = String(f || '').trim();
    if (!name) continue;
    const full = join(dir, name);
    assertInsideAuthDir(full, dir);
    jobs.push({ filename: name, path: full });
  }
  for (const p of paths) {
    const full = resolve(String(p || '').trim());
    if (!full) continue;
    assertInsideAuthDir(full, dir);
    jobs.push({ filename: basename(full), path: full });
  }
  const seen = new Set<string>();
  const unique = jobs.filter((j) => {
    const k = j.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) throw new Error('缺少 filenames 或 paths');
  if (unique.length > 200) throw new Error('单次远程推送最多 200 个');

  const concurrency = Math.min(6, Math.max(1, Number(input.concurrency) || 3));
  const force = Boolean(input.force);
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;
  const pushTagsSnapshot = await loadAccountTagsAsync();

  /* S2A_EMIT */
  const emit = async (item: CpaAuthBatchResultItem) => {
    if (!item.ok && !item.failReason) {
      item.failReason = classifyPushFailReason(item);
    }
    results.push(item);
    if (input.onItem) {
      try {
        await input.onItem(item);
      } catch {
        /* ignore */
      }
    }
  };

  function normalizeExpiresAt(raw: unknown): string {
    if (raw == null || raw === '') return '';
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const ts = raw > 1e12 ? raw / 1000 : raw;
      try {
        return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      } catch {
        return String(raw);
      }
    }
    const s = String(raw).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return normalizeExpiresAt(Number(s));
    if (s.endsWith('+00:00')) return s.slice(0, -6) + 'Z';
    return s;
  }

  function cpaToSub2CreateBody(
    data: Record<string, unknown>,
    groupIds?: Array<number | string>
  ): Record<string, unknown> {
    const email = String(data.email || '').trim();
    const name = email || String(data.name || data.sub || 'grok-oauth');
    const access = String(data.access_token || '').trim();
    const refresh = String(data.refresh_token || '').trim();
    if (!access) throw new Error('missing access_token');
    if (!refresh) throw new Error('missing refresh_token');
    const clientId =
      String(data.client_id || '').trim() ||
      'b1a00492-073a-47ea-816f-4c329264a828';
    let baseUrl =
      String(data.base_url || '').trim() || 'https://cli-chat-proxy.grok.com/v1';
    if (baseUrl.endsWith('cli-chat-proxy.grok.com')) baseUrl = baseUrl + '/v1';
    const expiresAt = normalizeExpiresAt(data.expires_at ?? data.expired);
    const credentials: Record<string, unknown> = {
      access_token: access,
      refresh_token: refresh,
      token_type: String(data.token_type || 'Bearer'),
      client_id: clientId,
      base_url: baseUrl
    };
    if (expiresAt) credentials.expires_at = expiresAt;
    if (data.id_token) credentials.id_token = String(data.id_token);
    if (email) credentials.email = email;
    if (data.sub) credentials.sub = String(data.sub);
    // mint 探针 model_ids → sub2api extra + credentials（可用模型列表）
    let modelIds: string[] = [];
    const rawModels =
      data.model_ids ?? data.models ?? data.available_models ?? null;
    if (Array.isArray(rawModels)) {
      modelIds = rawModels.map((x) => String(x || '').trim()).filter(Boolean);
    } else if (rawModels && typeof rawModels === 'object') {
      const m = rawModels as Record<string, unknown>;
      const arr = (m.model_ids ?? m.ids ?? m.data) as unknown;
      if (Array.isArray(arr)) {
        modelIds = arr.map((x) => String(x || '').trim()).filter(Boolean);
      }
    }
    if (modelIds.length > 0) {
      credentials.models = modelIds;
      credentials.available_models = modelIds;
    }
    const groupName = String(
      (settings as { sub2apiGroup?: string }).sub2apiGroup || ''
    ).trim();
    const body: Record<string, unknown> = {
      name,
      platform: 'grok',
      type: 'oauth',
      credentials,
      concurrency: 1,
      priority: 0,
      extra: {
        auth_provider: 'xai',
        provider: 'xai',
        source: 'cpa_xai',
        email,
        mint_channel: data.mint_channel,
        has_grok_45: data.has_grok_45,
        ...(modelIds.length > 0 ? { model_ids: modelIds } : {}),
        ...(groupName ? { group: groupName } : {})
      }
    };
    // sub2api 认 group_ids（数字），不是字符串 group 名
    if (groupIds && groupIds.length > 0) {
      body.group_ids = groupIds;
      body.groupIds = groupIds;
    }
    return body;
  }

  async function worker() {
    while (idx < unique.length) {
      if (input.isAborted?.()) break;
      const i = idx++;
      const job = unique[i];
      try {
        if (!existsSync(job.path)) {
          await emit({
            filename: job.filename,
            ok: false,
            remoteOk: false,
            error: '文件不存在',
            remoteError: '文件不存在',
            mode: 'missing_file'
          });
          continue;
        }
        const raw = await fsp.readFile(job.path, 'utf-8');
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          await emit({
            filename: job.filename,
            ok: false,
            remoteOk: false,
            error: 'JSON 解析失败',
            remoteError: 'JSON 解析失败',
            mode: 'invalid_json'
          });
          continue;
        }
        const emailEarly = String(data.email || '');
        const ssoEarly = String(data.sso || '');
        if (!force) {
          const tag = lookupNsfwTag(pushTagsSnapshot, { email: emailEarly, sso: ssoEarly });
          if (isPushOkFromTag(tag, 'auth_sub2api')) {
            await emit({
              filename: job.filename,
              email: emailEarly,
              ok: true,
              skipped: true,
              mode: 'already_pushed',
              remoteOk: true,
              remoteName: emailEarly || job.filename
            });
            continue;
          }
        }
        let body: Record<string, unknown>;
        try {
          body = cpaToSub2CreateBody(data, resolvedGroupIds);
        } catch (convErr) {
          const msg = convErr instanceof Error ? convErr.message : String(convErr);
          await emit({
            filename: job.filename,
            email: String(data.email || ''),
            ok: false,
            remoteOk: false,
            error: `格式转换失败: ${msg}`,
            remoteError: `格式转换失败: ${msg}`,
            mode: 'convert_error'
          });
          continue;
        }
        // 有则更新、无则新增（按 name/email 查找）
        const proxy = resolveHttpProxy(settings);
        const email = String(data.email || body.name || '');
        const nameKey = String(body.name || email || '').trim();
        let pushMode: string = 'uploaded';
        let res: { status: number; data?: unknown };
        const existingId = nameKey
          ? await findSub2apiAccountIdByName(base, token, nameKey, proxy)
          : null;
        if (existingId) {
          const putUrl = `${base}/api/v1/admin/accounts/${encodeURIComponent(existingId)}`;
          res = await requestWithProxyFallback(putUrl, {
            method: 'PUT',
            headers: {
              ...sub2apiAdminAuthHeaders(token),
              'Content-Type': 'application/json'
            },
            body,
            proxy,
            timeoutMs: 30000
          });
          // 部分版本只支持 PATCH
          if (res.status === 404 || res.status === 405) {
            res = await requestWithProxyFallback(putUrl, {
              method: 'PATCH',
              headers: {
                ...sub2apiAdminAuthHeaders(token),
                'Content-Type': 'application/json'
              },
              body,
              proxy,
              timeoutMs: 30000
            });
          }
          pushMode = 'reuploaded';
        } else {
          const url = `${base}/api/v1/admin/accounts`;
          res = await requestWithProxyFallback(url, {
            method: 'POST',
            headers: {
              ...sub2apiAdminAuthHeaders(token),
              'Content-Type': 'application/json'
            },
            body,
            proxy,
            timeoutMs: 30000
          });
          pushMode = 'uploaded';
        }
        const respBody =
          typeof res.data === 'string'
            ? res.data
            : res.data != null
              ? JSON.stringify(res.data)
              : '';
        // sub2api 信封：HTTP 200 + {code:0,data} 为成功；code!=0 为业务失败
        const envelope =
          res.data && typeof res.data === 'object'
            ? (res.data as { code?: unknown; message?: unknown; error?: unknown })
            : null;
        const bizCode =
          envelope && envelope.code !== undefined && envelope.code !== null
            ? Number(envelope.code)
            : null;
        const httpOk = res.status >= 200 && res.status < 300;
        const bizOk = bizCode === null || bizCode === 0;
        if (!httpOk || !bizOk) {
          const bizMsg =
            envelope &&
            (String(envelope.message || envelope.error || '').trim() || '');
          const msg = !httpOk
            ? `HTTP ${res.status}${respBody ? `: ${respBody.slice(0, 200)}` : ''}`
            : `sub2api code=${bizCode}${bizMsg ? `: ${bizMsg.slice(0, 180)}` : ''}`;
          try {
            setPushTag({
              channel: 'auth_sub2api',
              ok: false,
              email,
              sso: ssoEarly,
              error: msg
            });
          } catch {
            /* ignore */
          }
          await emit({
            filename: job.filename,
            email,
            ok: false,
            remoteOk: false,
            remoteError: msg,
            error: msg,
            mode: !httpOk ? 'http_error' : 'biz_error'
          });
        } else {
          try {
            setPushTag({
              channel: 'auth_sub2api',
              ok: true,
              email,
              sso: ssoEarly
            });
          } catch {
            /* ignore */
          }
          await emit({
            filename: job.filename,
            email,
            ok: true,
            remoteOk: true,
            remoteName: String(body.name || ''),
            mode: pushMode
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          setPushTag({ channel: 'auth_sub2api', ok: false, email: '', error: msg });
        } catch {
          /* ignore */
        }
        await emit({
          filename: job.filename,
          ok: false,
          remoteOk: false,
          error: msg,
          remoteError: msg,
          mode: 'error'
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  try {
    const okJobs = results
      .filter((r) => r.ok)
      .map((r) => {
        const fn = String(r.filename || '');
        const full = jobs.find((j) => j.filename === fn)?.path || '';
        return { path: full, filename: fn };
      })
      .filter((j) => j.path);
    if (okJobs.length) await stampAuthPushFlags(okJobs, { pushedS2a: true });
  } catch {
    /* non-fatal */
  }
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const modeCounts: Record<string, number> = {};
  for (const r of results) {
    const m = r.mode || (r.ok ? (r.skipped ? 'already_pushed' : 'uploaded') : 'error');
    modeCounts[m] = (modeCounts[m] || 0) + 1;
  }
  for (const r of results) {
    if (!r.ok && !r.failReason) r.failReason = classifyPushFailReason(r);
  }
  const failReasons = summarizeFailReasons(results);
  const cancelled = Boolean(input.isAborted?.());
  console.log(
    `[cpa-auth] push-sub2api total=${results.length} ok=${ok} skipped=${skipped} ` +
      `failed=${results.length - ok} force=${force} cancelled=${cancelled} modes=${JSON.stringify(modeCounts)}`
  );
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    skipped,
    cancelled,
    remoteConfigured: true,
    remoteUrl: base,
    modeCounts,
    failReasons,
    results
  };
}

/** 按 name 查找 sub2api 远端账号 id（用于有则更新） */
async function findSub2apiAccountIdByName(
  base: string,
  token: string,
  name: string,
  proxy: string | undefined
): Promise<string | null> {
  const n = String(name || '').trim();
  if (!n) return null;
  try {
    const url = `${base}/api/v1/admin/accounts?page=1&page_size=50&search=${encodeURIComponent(n)}`;
    const res = await requestWithProxyFallback(url, {
      method: 'GET',
      headers: sub2apiAdminAuthHeaders(token),
      proxy,
      timeoutMs: 15000
    });
    if (res.status < 200 || res.status >= 300) return null;
    const data = res.data as {
      code?: unknown;
      data?: unknown;
      items?: unknown;
    } | null;
    if (data && typeof data === 'object' && data.code != null && Number(data.code) !== 0) {
      return null;
    }
    let items: unknown[] = [];
    const inner = data && typeof data === 'object' ? data.data : null;
    if (Array.isArray(inner)) items = inner;
    else if (inner && typeof inner === 'object') {
      const o = inner as Record<string, unknown>;
      items = (o.items || o.list || o.accounts || []) as unknown[];
    } else if (data && typeof data === 'object' && Array.isArray(data.items)) {
      items = data.items;
    }
    const nLc = n.toLowerCase();
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const row = it as Record<string, unknown>;
      const nm = String(row.name || '').trim();
      if (nm.toLowerCase() !== nLc) continue;
      const id = row.id ?? row.account_id ?? row.accountId;
      if (id != null && String(id).trim()) return String(id).trim();
    }
  } catch {
    return null;
  }
  return null;
}

export type Sub2apiGroupItem = { id: number | string; name: string };

function collectSub2apiGroups(payload: unknown): Sub2apiGroupItem[] {
  const byName = new Map<string, Sub2apiGroupItem>();
  const add = (nameRaw: unknown, idRaw?: unknown) => {
    const name = String(nameRaw || '').trim();
    if (!name) return;
    let id: number | string | null = null;
    if (typeof idRaw === 'number' && Number.isFinite(idRaw)) id = idRaw;
    else if (idRaw != null && String(idRaw).trim()) {
      const n = Number(idRaw);
      id = Number.isFinite(n) && String(n) === String(idRaw).trim() ? n : String(idRaw).trim();
    }
    const prev = byName.get(name);
    if (!prev || (prev.id === name && id != null)) {
      byName.set(name, { id: id != null ? id : name, name });
    }
  };
  const walk = (node: unknown, depth = 0) => {
    if (node == null || depth > 6) return;
    if (Array.isArray(node)) {
      for (const it of node) walk(it, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    // 标准 groups item: { id, name }
    if (typeof o.name === 'string' && o.name.trim() && (o.id != null || o.group_id != null)) {
      add(o.name, o.id ?? o.group_id ?? o.groupId);
    }
    // 账号上的 groups: [{id,name}, ...]
    if (Array.isArray(o.groups)) {
      for (const g of o.groups) {
        if (g && typeof g === 'object') {
          const gg = g as Record<string, unknown>;
          add(gg.name, gg.id);
        } else {
          add(g);
        }
      }
    }
    if (Array.isArray(o.account_groups)) walk(o.account_groups, depth + 1);
    if (Array.isArray(o.group_ids) && typeof o.group === 'string') {
      add(o.group, o.group_ids[0]);
    }
    for (const k of ['items', 'list', 'groups', 'data', 'accounts', 'rows', 'results']) {
      if (o[k] != null) walk(o[k], depth + 1);
    }
  };
  walk(payload);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 按分组名解析 group_id（sub2api 创建账号认 group_ids，不认字符串 group） */
async function resolveSub2apiGroupIds(
  base: string,
  token: string,
  groupName: string,
  proxy: string | undefined
): Promise<{ ids: Array<number | string>; matched?: Sub2apiGroupItem }> {
  const name = String(groupName || '').trim();
  if (!name) return { ids: [] };
  // 纯数字：直接当 id
  if (/^\d+$/.test(name)) return { ids: [Number(name)] };

  const tryPaths = [
    '/api/v1/admin/groups?page=1&page_size=200',
    '/api/v1/admin/groups',
    '/api/v1/admin/account-groups'
  ];
  for (const p of tryPaths) {
    try {
      const res = await requestWithProxyFallback(`${base}${p}`, {
        method: 'GET',
        headers: sub2apiAdminAuthHeaders(token),
        proxy,
        timeoutMs: 15000
      });
      if (res.status < 200 || res.status >= 300) continue;
      const groups = collectSub2apiGroups(res.data);
      const hit = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
      if (hit) return { ids: [hit.id], matched: hit };
    } catch {
      /* try next */
    }
  }
  // 找不到 id 时仍返回空，避免把错误 group 字符串当成功
  console.warn(`[sub2api] group name not found: ${name}`);
  return { ids: [] };
}

/**
 * 拉取 sub2api 分组列表（多路径探测 + 从账号列表提取 group）。
 */
export async function listSub2apiGroups(input?: {
  url?: string;
  token?: string;
}): Promise<{
  ok: boolean;
  message: string;
  groups: string[];
  /** 含 id，推送时映射 group_ids */
  items?: Sub2apiGroupItem[];
  source?: string;
  remoteUrl?: string;
}> {
  const settings = await loadSettings();
  const base = normalizeSub2apiBaseUrl(
    String(
      input?.url ?? (settings as { sub2apiRemoteUrl?: string }).sub2apiRemoteUrl ?? ''
    )
  );
  const token = normalizeSub2apiAdminSecret(
    String(
      (isSecretPlaceholder(input?.token) ? undefined : input?.token) ??
        (settings as { sub2apiAdminToken?: string }).sub2apiAdminToken ??
        ''
    )
  );
  if (!base) return { ok: false, message: '请先填写 sub2api 地址', groups: [] };
  if (!token) return { ok: false, message: '请先填写 sub2api Admin Token', groups: [] };

  const proxy = resolveHttpProxy(settings);
  const headers = sub2apiAdminAuthHeaders(token);
  const tryGet = async (path: string) => {
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    try {
      const res = await requestWithProxyFallback(url, {
        method: 'GET',
        headers,
        proxy,
        timeoutMs: 15000
      });
      return { url, res };
    } catch (e) {
      return {
        url,
        res: {
          status: 0,
          data: String(e instanceof Error ? e.message : e)
        }
      };
    }
  };

  // 1) 官方分组 API（含 id）
  const groupPaths = [
    '/api/v1/admin/groups?page=1&page_size=200',
    '/api/v1/admin/groups',
    '/api/v1/admin/account-groups',
    '/api/v1/admin/group',
    '/api/v1/groups',
    '/api/admin/groups',
    '/api/v1/admin/accounts/groups'
  ];
  for (const p of groupPaths) {
    const { res } = await tryGet(p);
    if (res.status < 200 || res.status >= 300) continue;
    const env =
      res.data && typeof res.data === 'object'
        ? (res.data as { code?: unknown })
        : null;
    if (env && env.code != null && Number(env.code) !== 0) continue;
    const items = collectSub2apiGroups(res.data);
    if (items.length > 0) {
      return {
        ok: true,
        message: `已获取 ${items.length} 个分组`,
        groups: items.map((x) => x.name),
        items,
        source: p,
        remoteUrl: base
      };
    }
  }

  // 2) 从账号列表提取 groups
  const accountPaths = [
    '/api/v1/admin/accounts?page=1&page_size=200',
    '/api/v1/admin/accounts?page=1&pageSize=200'
  ];
  for (const p of accountPaths) {
    const { res } = await tryGet(p);
    if (res.status < 200 || res.status >= 300) continue;
    const env =
      res.data && typeof res.data === 'object'
        ? (res.data as { code?: unknown })
        : null;
    if (env && env.code != null && Number(env.code) !== 0) continue;
    const items = collectSub2apiGroups(res.data);
    if (items.length > 0) {
      return {
        ok: true,
        message: `已从账号列表提取 ${items.length} 个分组`,
        groups: items.map((x) => x.name),
        items,
        source: p,
        remoteUrl: base
      };
    }
    return {
      ok: true,
      message: '远端未返回分组字段（可手动输入分组名）',
      groups: [],
      items: [],
      source: p,
      remoteUrl: base
    };
  }

  return {
    ok: false,
    message: '无法获取分组：请检查地址/Token，或手动填写分组名',
    groups: [],
    items: [],
    remoteUrl: base
  };
}

/**
 * 检测远程 sub2api Admin API 连通性（不上传账号）。
 * GET {base}/api/v1/admin/accounts?page=1&page_size=1
 */
export async function testSub2apiRemoteConnectivity(input?: {
  url?: string;
  token?: string;
}): Promise<{
  ok: boolean;
  message: string;
  ms?: number;
  status?: number;
  remoteUrl?: string;
}> {
  const settings = await loadSettings();
  const base = normalizeSub2apiBaseUrl(
    String(
      input?.url ?? (settings as { sub2apiRemoteUrl?: string }).sub2apiRemoteUrl ?? ''
    )
  );
  const token = normalizeSub2apiAdminSecret(
    String(
      (isSecretPlaceholder(input?.token) ? undefined : input?.token) ??
        (settings as { sub2apiAdminToken?: string }).sub2apiAdminToken ??
        ''
    )
  );
  if (!base) {
    return { ok: false, message: '请先填写 sub2api 地址' };
  }
  if (!token) {
    return { ok: false, message: '请先填写 sub2api Admin Token' };
  }

  const started = Date.now();
  const url = `${base}/api/v1/admin/accounts?page=1&page_size=1`;
  const authMethod = token.split('.').length === 3 ? 'jwt' : 'x-api-key';
  try {
    const proxy = resolveHttpProxy(settings);
    const res = await requestWithProxyFallback(url, {
      method: 'GET',
      headers: sub2apiAdminAuthHeaders(token),
      proxy,
      timeoutMs: 12000
    });
    const ms = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      // 兼容 {code:0,data} 信封：code 非 0 视为鉴权/业务失败
      const env =
        res.data && typeof res.data === 'object'
          ? (res.data as { code?: unknown; message?: unknown })
          : null;
      if (env && env.code !== undefined && env.code !== null && Number(env.code) !== 0) {
        return {
          ok: false,
          message: `已连上 ${base}，但业务返回 code=${env.code}${
            env.message ? `: ${String(env.message).slice(0, 80)}` : ''
          }`,
          ms,
          status: res.status,
          remoteUrl: base
        };
      }
      return {
        ok: true,
        message: `远程 sub2api 连通（Admin API 可用 · ${authMethod}${res.via === 'proxy' ? ' · 经代理' : ''}）`,
        ms,
        status: res.status,
        remoteUrl: base
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message:
          `已连上 ${base}，但鉴权被拒（HTTP ${res.status} · 以 ${authMethod} 发送）。` +
          (authMethod === 'x-api-key'
            ? ' 请确认 Admin API Key（admin-...）正确；JWT 请填三段 token。'
            : ' 请确认 JWT 未过期且为管理员；也可改填 Admin API Key（admin-...）。'),
        ms,
        status: res.status,
        remoteUrl: base
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: 'HTTP 404：请确认地址为 sub2api 根（不要带 /api/v1 等多余路径）',
        ms,
        status: 404,
        remoteUrl: base
      };
    }
    const body =
      typeof res.data === 'string'
        ? res.data
        : res.data != null
          ? JSON.stringify(res.data)
          : '';
    return {
      ok: false,
      message: `HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`,
      ms,
      status: res.status,
      remoteUrl: base
    };
  } catch (err) {
    return {
      ok: false,
      message: errorMessage(err),
      ms: Date.now() - started,
      remoteUrl: base
    };
  }
}

/**
 * 检测远程 CPA Management API 连通性（不上传文件）。
 * GET {base}/v0/management/auth-files 或 HEAD；401/403 也算「密钥到达了服务」。
 */
export async function testCpaRemoteConnectivity(input?: {
  url?: string;
  key?: string;
}): Promise<{
  ok: boolean;
  message: string;
  ms?: number;
  status?: number;
  remoteUrl?: string;
}> {
  const settings = await loadSettings();
  let base = String(input?.url ?? settings.cpaRemoteUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  const key = String(
    (isSecretPlaceholder(input?.key) ? undefined : input?.key) ??
      settings.cpaManagementKey ??
      ''
  ).trim();
  if (base.endsWith('/v1')) base = base.slice(0, -3).replace(/\/+$/, '');
  if (!base) {
    return { ok: false, message: '请先填写远程 CPA 地址' };
  }
  if (!key) {
    return { ok: false, message: '请先填写远程 CPA 管理密钥' };
  }

  const started = Date.now();
  const url = `${base}/v0/management/auth-files`;
  try {
    // 优先直连，失败再走代理（与 sub2api / mail / grok2api 一致）
    const proxy = resolveHttpProxy(settings);
    const res = await requestWithProxyFallback(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      },
      proxy,
      timeoutMs: 12000
    });
    const ms = Date.now() - started;
    const viaHint = res.via === 'proxy' ? ' · 经代理' : '';
    // 2xx = 连通且鉴权通过
    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        message: `远程 CPA 连通（Management API 可用${viaHint}）`,
        ms,
        status: res.status,
        remoteUrl: base
      };
    }
    // 401/403 = 服务在线但密钥错误
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `已连上 ${base}，但密钥被拒（HTTP ${res.status}）${viaHint}`,
        ms,
        status: res.status,
        remoteUrl: base
      };
    }
    // 404 = 路径不对或未开 Management
    if (res.status === 404) {
      return {
        ok: false,
        message: `HTTP 404：请确认地址为 Management 根（不要带 /v1），且已开启 remote-management`,
        ms,
        status: 404,
        remoteUrl: base
      };
    }
    const body =
      typeof res.data === 'string'
        ? res.data
        : res.data != null
          ? JSON.stringify(res.data)
          : '';
    return {
      ok: false,
      message: `HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}${viaHint}`,
      ms,
      status: res.status,
      remoteUrl: base
    };
  } catch (err) {
    return {
      ok: false,
      message: errorMessage(err),
      ms: Date.now() - started,
      remoteUrl: base
    };
  }
}

export async function mintCpaAuthFromSso(input: {
  items: { sso: string; email?: string }[];
  concurrency?: number;
  /** 默认 true：mint 前用 sso_probe 验活，仅存活 SSO 继续 */
  precheck?: boolean;
  /**
   * 默认 true：SSO JWT 中 bot_flag_source===1 时跳过 mint。
   * 只读过滤，无法改掉服务端已签发的 claim。
   */
  skipBotFlag1?: boolean;
  onItem?: (item: CpaAuthBatchResultItem) => void | Promise<void>;
  isAborted?: () => boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  alive: number;
  banned: number;
  botFlagSkipped?: number;
  remoteOk?: number;
  remoteFailed?: number;
  failReasons?: Record<string, number>;
  cancelled?: boolean;
  results: CpaAuthBatchResultItem[];
}> {
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error('缺少 SSO 列表');
  if (items.length > 200) throw new Error('单次 mint 最多 200 个');
  const doPrecheck = input.precheck !== false;
  const skipBotFlag1 = input.skipBotFlag1 !== false;

  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  await fsp.mkdir(dir, { recursive: true });
  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python mint');
  // mint 后 probe 死号是否删文件：仅当设置显式开启（默认 false，与测活路径一致）
  const deleteOnDead = settings.cpaProbeDeleteOnDead === true;

  // 预检 + mint 合并为一次 Python 调用（check_sso_ban / sso2gropcpa 思路）
  // SSO→CPA mint 路径：pkce | device | auto（来自设置）
  const mintModeRaw = String(
    (settings as { cpaMintMode?: string }).cpaMintMode || 'pkce'
  )
    .trim()
    .toLowerCase();
  const mintMode =
    mintModeRaw === 'device' || mintModeRaw === 'device_flow' || mintModeRaw === 'b'
      ? 'device'
      : mintModeRaw === 'double' ||
          mintModeRaw === 'auto' ||
          mintModeRaw === 'c' ||
          mintModeRaw === 'merged' ||
          mintModeRaw === 'both' ||
          mintModeRaw === 'pkce_then_device'
        ? 'double'
        : 'pkce';

  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from sso_probe import probe_sso
from auth_service import sso_to_cpa_auth
sso = sys.argv[1]
email = sys.argv[2] if len(sys.argv) > 2 else ""
proxy = sys.argv[3] if len(sys.argv) > 3 else ""
auth_dir = sys.argv[4] if len(sys.argv) > 4 else ""
precheck = (sys.argv[5] if len(sys.argv) > 5 else "1") != "0"
delete_on_dead = (sys.argv[6] if len(sys.argv) > 6 else "1") != "0"
mint_mode = sys.argv[7] if len(sys.argv) > 7 else "pkce"
# 运行/预检强制直连，不走代理，避免浪费 IP 名额；mint 本身仍用 proxy
if precheck:
    p = probe_sso(sso, proxy="")
    if not p.get("alive"):
        print(json.dumps({
            "ok": False,
            "skipped": True,
            "mode": "skipped_" + str(p.get("verdict") or "dead"),
            "verdict": p.get("verdict") or "dead",
            "error": p.get("error") or "sso not alive",
            "email": email or p.get("email") or "",
        }, ensure_ascii=False))
        raise SystemExit(0)
    if not email and p.get("email"):
        email = p.get("email") or email
r = sso_to_cpa_auth(
    sso=sso, email=email, proxy=proxy, auth_dir=auth_dir or None,
    random_fingerprint=True, delete_on_dead=delete_on_dead,
    mint_mode=mint_mode,
)
if isinstance(r, dict):
    r.setdefault("mode", "sso_mint")
    r.setdefault("verdict", "alive")
    r["skipped"] = False
    if r.get("mint_mode"):
        r["mode"] = "sso_mint_" + str(r.get("mint_mode"))
print(json.dumps(r, ensure_ascii=False))
`.trim();

  const concurrency = Math.min(3, Math.max(1, Number(input.concurrency) || 2));
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;

  const emitItem = async (item: CpaAuthBatchResultItem) => {
    if (!item.ok && !item.failReason) {
      item.failReason = classifyAuthFailReason(item);
    }
    results.push(item);
    if (input.onItem) {
      try {
        await input.onItem(item);
      } catch {
        /* ignore stream write */
      }
    }
  };

  async function worker() {
    while (idx < items.length) {
      if (input.isAborted?.()) break;
      const i = idx++;
      const item = items[i];
      const sso = String(item.sso || '').trim();
      const email = String(item.email || '').trim();
      if (!sso) {
        await emitItem({
          email,
          ok: false,
          skipped: true,
          mode: 'skipped_dead',
          verdict: 'dead',
          error: 'empty sso'
        });
        continue;
      }
      const ssoFlag = readBotFlagFromToken(sso);
      if (skipBotFlag1 && ssoFlag.isBotFlag1) {
        await emitItem({
          email,
          ok: false,
          skipped: true,
          mode: 'skipped_bot_flag',
          verdict: 'bot_flag',
          botFlagSource: ssoFlag.botFlagSource,
          isBotFlag1: true,
          error: 'bot_flag_source=1（已跳过 mint）'
        });
        continue;
      }
      try {
        const proxyMint = resolveHttpProxy(settings, 'cpaAuth');
        let r: Record<string, unknown>;
        const poolEnabled = settings.pythonPoolEnabled !== false;
        const poolSize = Math.min(
          4,
          Math.max(1, Number(settings.pythonPoolSize) || concurrency)
        );
        const poolTimeoutMs = Math.min(
          600_000,
          Math.max(10_000, (Number(settings.pythonPoolTimeoutSec) || 180) * 1000)
        );
        try {
          if (!poolEnabled) throw new Error('python pool disabled');
          const pool = getPythonJobPool(
            runtime!.pythonPath,
            runtime!.registerDir,
            poolSize,
            poolTimeoutMs
          );
          r = await pool.run({
            op: 'mint',
            sso,
            email,
            proxy: proxyMint,
            authDir: dir,
            precheck: doPrecheck,
            deleteOnDead,
            mintMode
          });
        } catch (poolErr) {
          if (poolEnabled) {
            console.warn(
              '[cpa-auth] mint pool failed, fallback spawn:',
              poolErr instanceof Error ? poolErr.message : poolErr
            );
          }
          r = await runPythonJson(runtime!.pythonPath, runtime!.registerDir, code, [
            sso,
            email,
            proxyMint,
            dir,
            doPrecheck ? '1' : '0',
            deleteOnDead ? '1' : '0',
            mintMode
          ]);
        }
        const skipped = Boolean(r.skipped) || String(r.mode || '').startsWith('skipped_');
        if (skipped) {
          await emitItem({
            email: String(r.email || email),
            ok: false,
            skipped: true,
            mode: String(r.mode || 'skipped_dead'),
            verdict: String(r.verdict || 'dead'),
            botFlagSource: ssoFlag.botFlagSource,
            isBotFlag1: ssoFlag.isBotFlag1,
            error: r.error ? String(r.error) : 'sso not alive'
          });
          continue;
        }
        const outPath = String(r.path || '');
        const probeObj =
          r.probe && typeof r.probe === 'object'
            ? (r.probe as Record<string, unknown>)
            : null;
        const flags = outPath
          ? await readXaiAfter(outPath)
          : { xai: false, xaiFilename: false, xaiType: false, authType: '' };
        let outFlag = ssoFlag;
        if (outPath && existsSync(outPath)) {
          try {
            const data = JSON.parse(await fsp.readFile(outPath, 'utf-8')) as Record<
              string,
              unknown
            >;
            outFlag = readBotFlagFromAuthRecord(data);
          } catch {
            /* keep sso flag */
          }
        }
        const remote = parseRemoteField(r.remote);
        await emitItem({
          filename: String(r.filename || (outPath ? basename(outPath) : '')),
          email: String(r.email || email),
          ok: r.ok !== false && !r.error,
          error: r.error ? String(r.error) : undefined,
          mode: String(r.mode || 'sso_mint'),
          verdict: String(r.verdict || 'alive'),
          skipped: false,
          path: outPath || undefined,
          xai: flags.xai,
          xaiFilename: flags.xaiFilename,
          xaiType: flags.xaiType,
          botFlagSource: outFlag.botFlagSource,
          isBotFlag1: outFlag.isBotFlag1,
          probeAction: probeObj ? String(probeObj.action || '') : undefined,
          probeHttp: probeObj
            ? Number(probeObj.http_status || 0) || undefined
            : undefined,
          probeDeleted: Boolean(r.deleted) || Boolean(probeObj?.deleted),
          remoteOk: remote.remoteOk,
          remoteError: remote.remoteError,
          remoteName: remote.remoteName
        });
      } catch (err) {
        await emitItem({
          email,
          ok: false,
          skipped: false,
          mode: 'sso_mint_error',
          botFlagSource: ssoFlag.botFlagSource,
          isBotFlag1: ssoFlag.isBotFlag1,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const banned = results.filter((r) => r.verdict === 'banned' || r.mode === 'skipped_banned').length;
  const botFlagSkipped = results.filter(
    (r) => r.verdict === 'bot_flag' || r.mode === 'skipped_bot_flag'
  ).length;
  const alive = results.filter((r) => !r.skipped).length;
  const remoteOkN = results.filter((r) => r.remoteOk === true).length;
  const remoteFailedN = results.filter((r) => r.remoteOk === false).length;
  const cancelled = Boolean(input.isAborted?.());
  // 兜底分类
  for (const it of results) {
    if (!it.ok && !it.failReason) it.failReason = classifyAuthFailReason(it);
  }
  return {
    total: results.length,
    ok,
    failed: results.length - ok - skipped,
    skipped,
    alive,
    banned,
    botFlagSkipped,
    remoteOk: remoteOkN,
    remoteFailed: remoteFailedN,
    failReasons: summarizeFailReasons(results),
    cancelled,
    results
  };
}

/** 把测活结果写回 auth JSON（Node 侧兜底；Python 侧也会写） */
async function persistProbeOnAuthFile(
  filePath: string,
  action: string,
  httpStatus?: number
): Promise<void> {
  const act = String(action || '').trim();
  if (!act || !filePath || !existsSync(filePath)) return;
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    data.probe_action = act;
    const http = Number(httpStatus || 0);
    if (http > 0) data.probe_http = http;
    else delete data.probe_http;
    data.probe_at = new Date().toISOString();
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await fsp.rename(tmp, filePath);
  } catch {
    /* ignore persist failure */
  }
}

/**
 * 手动重登激活：密码登录 → mint 覆盖 → 随机英文消息 → 二次测活 → 写回测活标签。
 * 号池无密码时立刻失败（不启动浏览器）；进度经 WebSocket relogin_progress 推送。
 */
export async function reloginCpaAuth(input: {
  filename?: string;
  path?: string;
}): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  let resolved = '';
  if (input.path) {
    resolved = resolve(String(input.path).trim());
  } else {
    const name = basename(String(input.filename || '').trim());
    if (!name || name.includes('..') || !name.endsWith('.json')) {
      throw new Error('无效的 filename');
    }
    resolved = join(dir, name);
  }
  assertInsideAuthDir(resolved, dir);
  if (!existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);

  const filename = basename(resolved);
  let emailHint = '';
  try {
    const raw = await fsp.readFile(resolved, 'utf-8');
    const doc = JSON.parse(raw) as { email?: string };
    emailHint = String(doc.email || '').trim();
  } catch {
    /* ignore */
  }

  emitReloginProgress({
    filename,
    email: emailHint || undefined,
    stage: 'checking',
    message: '校验邮箱与号池密码…'
  });

  if (!emailHint) {
    emitReloginProgress({
      filename,
      stage: 'error',
      message: 'Auth 文件无邮箱，无法密码重登'
    });
    throw new Error('Auth 文件无邮箱，无法密码重登');
  }

  let password = '';
  try {
    const { listAccountsLite } = await import('./accountStore.js');
    const accounts = await listAccountsLite();
    const em = emailHint.toLowerCase();
    for (const a of accounts) {
      if (String(a.email || '').trim().toLowerCase() === em) {
        password = String(a.password || '').trim();
        if (password) break;
      }
    }
  } catch {
    /* ignore */
  }
  if (!password) {
    const msg = `号池中未找到 ${emailHint} 的密码，无法重登（未启动浏览器）`;
    emitReloginProgress({ filename, email: emailHint, stage: 'error', message: msg });
    throw new Error(msg);
  }

  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) {
    emitReloginProgress({
      filename,
      email: emailHint,
      stage: 'error',
      message: '未找到注册脚本目录'
    });
    throw new Error('未找到注册脚本目录，无法调用 Python 重登');
  }

  emitReloginProgress({
    filename,
    email: emailHint,
    stage: 'login',
    message: '开始密码登录（浏览器）…'
  });

  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from password_login import recover_auth_on_dead

def _log(msg):
    # 进度打到 stderr，避免污染最后一行 JSON（stdout）
    print(msg, file=sys.stderr, flush=True)

path = sys.argv[1]
email = sys.argv[2] if len(sys.argv) > 2 else ""
password = sys.argv[3] if len(sys.argv) > 3 else ""
proxy = sys.argv[4] if len(sys.argv) > 4 else ""
_log("[relogin] stage=login msg=start email=%s" % email)
r = recover_auth_on_dead(path, email, password, proxy=proxy, trigger_http=0, log=_log)
_log("[relogin] stage=%s msg=done ok=%s action=%s err=%s" % (
    "done" if r.get("ok") else "error",
    r.get("ok"), r.get("action"), (r.get("error") or "")[:120]
))
print(json.dumps(r, ensure_ascii=False))
`.trim();

  let r: Record<string, unknown>;
  try {
    r = await runPythonJson(
      runtime.pythonPath,
      runtime.registerDir,
      code,
      [resolved, emailHint, password, resolveHttpProxy(settings, 'cpaAuth')],
      {
        onStderrLine: (line) => {
          const parsed = parseReloginStageLine(line);
          if (parsed) {
            emitReloginProgress({
              filename,
              email: emailHint,
              stage: parsed.stage,
              message: parsed.message
            });
          }
        }
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitReloginProgress({ filename, email: emailHint, stage: 'error', message: msg });
    throw e;
  }

  const second =
    r.second_probe && typeof r.second_probe === 'object'
      ? (r.second_probe as Record<string, unknown>)
      : r;
  const action = String(second.action || r.action || (r.ok ? 'ok' : 'error'));
  const httpStatus = Number(second.http_status || r.http_status || 0) || undefined;
  // Node 兜底写盘（Python 已写则幂等）
  if (existsSync(resolved)) {
    await persistProbeOnAuthFile(resolved, action, httpStatus);
  }
  const ok = r.ok === true || action === 'ok';
  emitReloginProgress({
    filename,
    email: emailHint,
    stage: ok ? 'done' : 'error',
    message: ok
      ? `完成 · HTTP ${httpStatus ?? '—'}`
      : String(r.error || action || '失败')
  });
  // 与重签日志统一：mode=password_relogin（非 refresh/sso）
  console.log(
    `[cpa-auth] resign mode=password_relogin file=${filename} ok=${ok}` +
      (r.error ? ` err=${String(r.error).slice(0, 120)}` : '')
  );
  return {
    ...r,
    filename,
    email: String(r.email || emailHint),
    ok,
    probeAction: action,
    probeHttp: httpStatus,
    mode: 'password_relogin'
  };
}

/**
 * 批量 CPA 测活（/responses）。
 * - 默认快扫：Node 直连 HTTP，不 spawn Python，不密码重登
 * - recoverOnAuthError=true：Python 深检（401/403 可密码重登），并发降至 1～2
 * - 默认不删死号；仅 settings/入参显式 true 才删
 */
export async function probeCpaAuthBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
  /** 未传时读 settings.cpaProbeDeleteOnDead，默认 false */
  deleteOnDead?: boolean;
  /**
   * 401/403 时是否密码重登深检。默认 false（快扫）。
   * true 时走 Python probe_and_cleanup(recover_on_403=true)。
   */
  recoverOnAuthError?: boolean;
  /** 每完成一条即回调（NDJSON 流式测活） */
  onItem?: (item: CpaAuthBatchResultItem) => void | Promise<void>;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  dead: number;
  deleted: number;
  keep: number;
  /** 同步删除的号池 SSO 账号数（需开启 cpaProbeDeleteSsoOnDead） */
  ssoDeleted: number;
  results: CpaAuthBatchResultItem[];
}> {
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename?: string; path?: string }[] = [];
  for (const f of names) {
    if (String(f || '').trim()) jobs.push({ filename: String(f).trim() });
  }
  for (const p of paths) {
    if (String(p || '').trim()) jobs.push({ path: String(p).trim() });
  }
  if (jobs.length === 0) throw new Error('缺少 filenames 或 paths');
  if (jobs.length > 200) throw new Error('单次批量测活最多 200 个');

  const settings = await loadSettings();
  const deleteOnDead =
    input.deleteOnDead !== undefined
      ? input.deleteOnDead === true
      : settings.cpaProbeDeleteOnDead === true;
  const recoverOnAuthError = input.recoverOnAuthError === true;
  const dir = resolveAuthDir(settings.authDir);
  const proxy = resolveHttpProxy(settings, 'cpaAuth');

  // 深检才需要 Python + 号池密码；快扫纯 Node
  let runtime: ReturnType<typeof resolveRegisterRuntime> = null;
  let passwordByEmail = new Map<string, string>();
  let pyCode = '';
  if (recoverOnAuthError) {
    runtime = resolveRegisterRuntime(settings);
    if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python 深检测活');
    try {
      const { listAccountsLite } = await import('./accountStore.js');
      const accounts = await listAccountsLite();
      for (const a of accounts) {
        const em = String(a.email || '')
          .trim()
          .toLowerCase();
        const pw = String(a.password || '').trim();
        if (em && pw && !passwordByEmail.has(em)) passwordByEmail.set(em, pw);
      }
    } catch {
      passwordByEmail = new Map();
    }
    pyCode = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from cpa_probe import probe_and_cleanup
path = sys.argv[1]
proxy = sys.argv[2] if len(sys.argv) > 2 else ""
delete_on_dead = (sys.argv[3] if len(sys.argv) > 3 else "0") == "1"
email = sys.argv[4] if len(sys.argv) > 4 else ""
password = sys.argv[5] if len(sys.argv) > 5 else ""
r = probe_and_cleanup(
    path,
    proxy=proxy,
    delete_on_dead=delete_on_dead,
    email=email or None,
    password=password or None,
    recover_on_403=True,
)
print(json.dumps(r, ensure_ascii=False))
`.trim();
  }

  // 快扫：允许更高并发；深检（含浏览器）：1～2
  const requested = Math.max(1, Math.floor(Number(input.concurrency) || 1));
  const concurrency = recoverOnAuthError
    ? Math.min(2, requested)
    : Math.min(12, Math.max(1, requested || 6));

  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;
  const emitItem = async (item: CpaAuthBatchResultItem) => {
    results.push(item);
    if (input.onItem) {
      try {
        await input.onItem(item);
      } catch {
        /* 流写失败不阻断测活 */
      }
    }
  };

  async function worker() {
    while (idx < jobs.length) {
      const i = idx++;
      const job = jobs[i];
      let resolved = '';
      try {
        if (job.path) {
          resolved = resolve(job.path);
        } else {
          const name = basename(String(job.filename || '').trim());
          if (!name || name.includes('..') || !name.endsWith('.json')) {
            throw new Error('无效的 filename');
          }
          resolved = join(dir, name);
        }
        assertInsideAuthDir(resolved, dir);
        if (!existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);

        let emailHint = '';
        try {
          const raw = await fsp.readFile(resolved, 'utf-8');
          const doc = JSON.parse(raw) as { email?: string };
          emailHint = String(doc.email || '').trim();
        } catch {
          /* ignore */
        }

        if (!recoverOnAuthError) {
          const r = await probeCpaAuthFileNode(resolved, { proxy });
          const action = String(r.action || 'error');
          const httpStatus = Number(r.http_status || 0) || undefined;
          let deleted = false;
          if (action === 'dead' && deleteOnDead && existsSync(resolved)) {
            try {
              await fsp.unlink(resolved);
              deleted = true;
            } catch {
              /* ignore */
            }
          }
          if (!deleted && action && existsSync(resolved)) {
            await persistProbeOnAuthFile(resolved, action, httpStatus);
          }
          await emitItem({
            filename: basename(resolved),
            email: String(r.email || emailHint || ''),
            ok: action === 'ok',
            error: r.error
              ? String(r.error)
              : action === 'dead'
                ? `HTTP ${httpStatus || '?'}`
                : undefined,
            mode: 'cpa_probe',
            path: deleted ? undefined : resolved,
            probeAction: action || undefined,
            probeHttp: httpStatus,
            probeDeleted: deleted
          });
          continue;
        }

        const pw =
          passwordByEmail.get(emailHint.toLowerCase()) ||
          passwordByEmail.get(emailHint) ||
          '';
        const r = await runPythonJson(runtime!.pythonPath, runtime!.registerDir, pyCode, [
          resolved,
          proxy,
          deleteOnDead ? '1' : '0',
          emailHint,
          pw
        ]);
        const action = String(r.action || '');
        const httpStatus = Number(r.http_status || 0) || undefined;
        const deleted = Boolean(r.deleted);
        const isOk = action === 'ok';
        const recovered = Boolean(r.recovered_403) || Boolean(r.recovered_auth);
        const recoverHttp = Number(r.recover_http || 0) || httpStatus;
        if (!deleted && action && existsSync(resolved)) {
          await persistProbeOnAuthFile(resolved, action, httpStatus);
        }
        await emitItem({
          filename: basename(resolved),
          email: String(r.email || emailHint || ''),
          ok: isOk,
          error: r.error
            ? String(r.error)
            : action === 'dead'
              ? `HTTP ${httpStatus || '?'}`
              : undefined,
          mode: recovered ? 'cpa_probe_auth_recover' : 'cpa_probe_deep',
          path: deleted ? undefined : resolved,
          probeAction: action || undefined,
          probeHttp: httpStatus,
          probeDeleted: deleted,
          ...(recovered ? { recoverHttp } : {})
        });
      } catch (err) {
        await emitItem({
          filename: job.filename || basename(job.path || resolved || ''),
          ok: false,
          mode: 'cpa_probe_error',
          error: err instanceof Error ? err.message : String(err),
          probeAction: 'error'
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  let ssoDeleted = 0;
  if (settings.cpaProbeDeleteSsoOnDead === true) {
    const emails = [
      ...new Set(
        results
          .filter((r) => r.probeAction === 'dead' && r.probeDeleted && r.email)
          .map((r) => String(r.email || '').trim().toLowerCase())
          .filter(Boolean)
      )
    ];
    if (emails.length > 0) {
      try {
        const { listAccountsLite, deleteAccounts } = await import('./accountStore.js');
        const accounts = await listAccountsLite();
        const ids = accounts
          .filter((a) => emails.includes(String(a.email || '').trim().toLowerCase()))
          .map((a) => a.id);
        if (ids.length > 0) {
          const dr = await deleteAccounts(ids);
          ssoDeleted = dr.deleted;
        }
      } catch {
        /* ignore sso sync failure */
      }
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const dead = results.filter((r) => r.probeAction === 'dead').length;
  const deleted = results.filter((r) => r.probeDeleted).length;
  const keep = results.filter((r) => r.probeAction === 'keep').length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    dead,
    ssoDeleted,
    deleted,
    keep,
    results
  };
}

/** 批量删除 CPA auth 文件（仅 auth 目录内 .json） */
export async function deleteCpaAuthBatch(input: {
  filenames?: string[];
  paths?: string[];
}): Promise<{
  total: number;
  deleted: number;
  failed: number;
  results: CpaAuthBatchResultItem[];
}> {
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename?: string; path?: string }[] = [];
  for (const f of names) {
    if (String(f || '').trim()) jobs.push({ filename: String(f).trim() });
  }
  for (const p of paths) {
    if (String(p || '').trim()) jobs.push({ path: String(p).trim() });
  }
  if (jobs.length === 0) throw new Error('缺少 filenames 或 paths');
  if (jobs.length > 500) throw new Error('单次批量删除最多 500 个');

  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  const results: CpaAuthBatchResultItem[] = [];

  for (const job of jobs) {
    let resolved = '';
    try {
      if (job.path) {
        resolved = resolve(job.path);
      } else {
        const name = basename(String(job.filename || '').trim());
        if (!name || name.includes('..') || !name.endsWith('.json')) {
          throw new Error('无效的 filename');
        }
        resolved = join(dir, name);
      }
      assertInsideAuthDir(resolved, dir);
      if (!existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
      await fsp.unlink(resolved);
      results.push({
        filename: basename(resolved),
        ok: true,
        mode: 'deleted',
        path: resolved
      });
    } catch (err) {
      results.push({
        filename: job.filename || basename(job.path || resolved || ''),
        ok: false,
        mode: 'delete_error',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const deleted = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    deleted,
    failed: results.length - deleted,
    results
  };
}

/** 读取 auth 文件内容（导出用）；单次最多 200 个 */
export async function readCpaAuthFiles(input: {
  filenames?: string[];
}): Promise<{
  dir: string;
  files: Array<{ filename: string; email: string; content: string }>;
}> {
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const list = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (list.length === 0) throw new Error('缺少 filenames');
  if (list.length > 200) throw new Error('单次导出最多 200 个');

  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  const files: Array<{ filename: string; email: string; content: string }> = [];

  for (const raw of list) {
    const name = basename(raw);
    if (!name || name.includes('..') || !name.endsWith('.json')) {
      throw new Error(`无效的 filename: ${raw}`);
    }
    const full = join(dir, name);
    assertInsideAuthDir(full, dir);
    if (!existsSync(full)) continue;
    const content = await fsp.readFile(full, 'utf-8');
    let email = '';
    try {
      const data = JSON.parse(content) as Record<string, unknown>;
      email = String(data.email || '');
    } catch {
      /* ignore */
    }
    files.push({ filename: name, email, content });
  }
  return { dir, files };
}

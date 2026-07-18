/**
 * 读取 account_tags.json（NSFW 等侧车标签）
 * 与 Python account_tags.py 格式一致。
 * 主路径：DATA_DIR/account_tags.json（Docker ./data 卷，重建镜像不丢）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';

export interface AccountTagEntry {
  nsfw_enabled?: boolean;
  nsfw_attempted?: boolean;
  nsfw_at?: string;
  nsfw_error?: string;
  zdr_closed?: boolean;
  zdr_attempted?: boolean;
  zdr_at?: string;
  zdr_error?: string;
  // 推送渠道标签（与 Python account_tags.set_push_tag 一致）
  push_sso_g2_ok?: boolean;
  push_sso_g2_attempted?: boolean;
  push_sso_g2_at?: string;
  push_sso_g2_error?: string;
  push_auth_cpa_ok?: boolean;
  push_auth_cpa_attempted?: boolean;
  push_auth_cpa_at?: string;
  push_auth_cpa_error?: string;
  push_auth_sub2api_ok?: boolean;
  push_auth_sub2api_attempted?: boolean;
  push_auth_sub2api_at?: string;
  push_auth_sub2api_error?: string;
  [key: string]: unknown;
}

export interface AccountTagsFile {
  by_email: Record<string, AccountTagEntry>;
  by_sso_hash: Record<string, AccountTagEntry>;
}

/** 主持久路径（与 Python _primary_path 一致） */
export function primaryAccountTagsPath(): string {
  const dataDir = String(process.env.DATA_DIR || '/data').trim() || '/data';
  return join(dataDir, 'account_tags.json');
}

function tagsPathCandidates(): string[] {
  // 同步解析；DATA_DIR 优先（与 Python 持久落盘一致）
  const out: string[] = [];
  out.push(primaryAccountTagsPath());
  const dataDir = String(process.env.DATA_DIR || '/data').trim();
  if (dataDir) {
    out.push(join(dataDir, 'account_tags.json'));
  }
  const rt = resolveRegisterRuntime({});
  if (rt?.registerDir) {
    out.push(join(rt.registerDir, 'data', 'account_tags.json'));
    out.push(join(rt.registerDir, 'account_tags.json'));
  }
  out.push(join(process.cwd(), 'register', 'data', 'account_tags.json'));
  out.push(join(process.cwd(), 'data', 'account_tags.json'));
  out.push('/data/account_tags.json');
  out.push('/app/register/data/account_tags.json');
  // 去重保序
  const seen = new Set<string>();
  return out.filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

function mergeTagFiles(a: AccountTagsFile, b: AccountTagsFile): AccountTagsFile {
  const by_email: Record<string, AccountTagEntry> = { ...a.by_email };
  const by_sso_hash: Record<string, AccountTagEntry> = { ...a.by_sso_hash };
  for (const [k, v] of Object.entries(b.by_email || {})) {
    by_email[k] = { ...(by_email[k] || {}), ...v };
  }
  for (const [k, v] of Object.entries(b.by_sso_hash || {})) {
    by_sso_hash[k] = { ...(by_sso_hash[k] || {}), ...v };
  }
  return { by_email, by_sso_hash };
}

export function loadAccountTags(): AccountTagsFile {
  // 低优先级路径先读，高优先级后覆盖（与 tagsPathCandidates 顺序一致）
  let merged: AccountTagsFile = { by_email: {}, by_sso_hash: {} };
  // 倒序：候选列表前面是高优先级（DATA_DIR），最后写入覆盖
  const paths = tagsPathCandidates().slice().reverse();
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<AccountTagsFile>;
      const one: AccountTagsFile = {
        by_email: (
          raw.by_email && typeof raw.by_email === 'object' ? raw.by_email : {}
        ) as Record<string, AccountTagEntry>,
        by_sso_hash: (
          raw.by_sso_hash && typeof raw.by_sso_hash === 'object' ? raw.by_sso_hash : {}
        ) as Record<string, AccountTagEntry>
      };
      merged = mergeTagFiles(merged, one);
    } catch {
      /* try next */
    }
  }
  return merged;
}

export function ssoHashHex(sso: string): string {
  let t = String(sso || '').trim();
  if (t.toLowerCase().startsWith('sso=')) t = t.slice(4).trim();
  if (!t || t.length < 8) return '';
  return createHash('sha256').update(t, 'utf8').digest('hex');
}

export function lookupNsfwTag(
  tags: AccountTagsFile,
  opts: { email?: string; sso?: string; ssoHash?: string }
): AccountTagEntry | null {
  const email = String(opts.email || '')
    .trim()
    .toLowerCase();
  if (email && tags.by_email[email]) {
    return tags.by_email[email];
  }
  let h = String(opts.ssoHash || '')
    .trim()
    .toLowerCase();
  if (!h && opts.sso) {
    h = ssoHashHex(opts.sso);
  }
  if (h && tags.by_sso_hash[h]) {
    return tags.by_sso_hash[h];
  }
  return null;
}

export type NsfwUiStatus = 'ok' | 'fail' | 'none';

export function nsfwStatusFromTag(tag: AccountTagEntry | null | undefined): {
  nsfwEnabled: boolean | null;
  nsfwAttempted: boolean;
  nsfwAt?: string;
  nsfwError?: string;
  nsfwStatus: NsfwUiStatus;
} {
  if (!tag || !tag.nsfw_attempted) {
    return { nsfwEnabled: null, nsfwAttempted: false, nsfwStatus: 'none' };
  }
  if (tag.nsfw_enabled === true) {
    return {
      nsfwEnabled: true,
      nsfwAttempted: true,
      nsfwAt: tag.nsfw_at,
      nsfwStatus: 'ok'
    };
  }
  return {
    nsfwEnabled: false,
    nsfwAttempted: true,
    nsfwAt: tag.nsfw_at,
    nsfwError: tag.nsfw_error,
    nsfwStatus: 'fail'
  };
}

export type ZdrUiStatus = 'closed' | 'open' | 'none';

export function zdrStatusFromTag(tag: AccountTagEntry | null | undefined): {
  zdrClosed: boolean | null;
  zdrAttempted: boolean;
  zdrAt?: string;
  zdrError?: string;
  zdrStatus: ZdrUiStatus;
} {
  if (!tag || !tag.zdr_attempted) {
    return { zdrClosed: null, zdrAttempted: false, zdrStatus: 'none' };
  }
  if (tag.zdr_closed === true) {
    return {
      zdrClosed: true,
      zdrAttempted: true,
      zdrAt: tag.zdr_at,
      zdrStatus: 'closed'
    };
  }
  return {
    zdrClosed: false,
    zdrAttempted: true,
    zdrAt: tag.zdr_at,
    zdrError: tag.zdr_error,
    zdrStatus: 'open'
  };
}

export type PushChannel = 'sso_g2' | 'auth_cpa' | 'auth_sub2api';
export type PushUiStatus = 'ok' | 'fail' | 'none';

export function normalizePushChannel(channel: string): PushChannel | '' {
  const c = String(channel || '').trim().toLowerCase();
  const aliases: Record<string, PushChannel> = {
    sso_g2: 'sso_g2',
    'sso-g2': 'sso_g2',
    grok2api: 'sso_g2',
    g2: 'sso_g2',
    auth_cpa: 'auth_cpa',
    cpa: 'auth_cpa',
    'auth-cpa': 'auth_cpa',
    auth_sub2api: 'auth_sub2api',
    sub2api: 'auth_sub2api',
    'auth-sub2api': 'auth_sub2api',
    s2a: 'auth_sub2api'
  };
  return aliases[c] || '';
}

export function isPushOkFromTag(
  tag: AccountTagEntry | null | undefined,
  channel: string
): boolean {
  const ch = normalizePushChannel(channel);
  if (!ch || !tag) return false;
  const rec = tag as Record<string, unknown>;
  return rec[`push_${ch}_ok`] === true;
}

export function pushStatusFromTag(
  tag: AccountTagEntry | null | undefined,
  channel: string
): {
  pushOk: boolean | null;
  pushAttempted: boolean;
  pushAt?: string;
  pushError?: string;
  pushStatus: PushUiStatus;
} {
  const ch = normalizePushChannel(channel);
  if (!ch || !tag) {
    return { pushOk: null, pushAttempted: false, pushStatus: 'none' };
  }
  const rec = tag as Record<string, unknown>;
  const attempted =
    rec[`push_${ch}_attempted`] === true || rec[`push_${ch}_ok`] === true;
  const ok = rec[`push_${ch}_ok`] === true;
  const at =
    typeof rec[`push_${ch}_at`] === 'string'
      ? String(rec[`push_${ch}_at`])
      : undefined;
  const err =
    typeof rec[`push_${ch}_error`] === 'string'
      ? String(rec[`push_${ch}_error`])
      : undefined;
  if (!attempted && !ok) {
    return { pushOk: null, pushAttempted: false, pushStatus: 'none' };
  }
  if (ok) {
    return { pushOk: true, pushAttempted: true, pushAt: at, pushStatus: 'ok' };
  }
  return {
    pushOk: false,
    pushAttempted: true,
    pushAt: at,
    pushError: err,
    pushStatus: 'fail'
  };
}

export function allPushStatusesFromTag(tag: AccountTagEntry | null | undefined): {
  ssoG2Status: PushUiStatus;
  authCpaStatus: PushUiStatus;
  authSub2apiStatus: PushUiStatus;
  ssoG2At?: string;
  authCpaAt?: string;
  authSub2apiAt?: string;
  ssoG2Error?: string;
  authCpaError?: string;
  authSub2apiError?: string;
} {
  const g2 = pushStatusFromTag(tag, 'sso_g2');
  const cpa = pushStatusFromTag(tag, 'auth_cpa');
  const s2a = pushStatusFromTag(tag, 'auth_sub2api');
  return {
    ssoG2Status: g2.pushStatus,
    authCpaStatus: cpa.pushStatus,
    authSub2apiStatus: s2a.pushStatus,
    ssoG2At: g2.pushAt,
    authCpaAt: cpa.pushAt,
    authSub2apiAt: s2a.pushAt,
    ssoG2Error: g2.pushError,
    authCpaError: cpa.pushError,
    authSub2apiError: s2a.pushError
  };
}

/** 写入推送标签到 DATA_DIR/account_tags.json（与 Python set_push_tag 对齐） */
export function setPushTag(opts: {
  channel: string;
  ok: boolean;
  email?: string;
  sso?: string;
  error?: string;
}): boolean {
  const ch = normalizePushChannel(opts.channel);
  if (!ch) return false;
  const email = String(opts.email || '').trim().toLowerCase();
  const h = opts.sso ? ssoHashHex(opts.sso) : '';
  if (!email && !h) return false;

  const path = primaryAccountTagsPath();
  let data: AccountTagsFile = { by_email: {}, by_sso_hash: {} };
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AccountTagsFile>;
      data = {
        by_email: (
          raw.by_email && typeof raw.by_email === 'object' ? raw.by_email : {}
        ) as Record<string, AccountTagEntry>,
        by_sso_hash: (
          raw.by_sso_hash && typeof raw.by_sso_hash === 'object' ? raw.by_sso_hash : {}
        ) as Record<string, AccountTagEntry>
      };
    }
  } catch {
    /* start empty */
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const patch: AccountTagEntry = {
    [`push_${ch}_ok`]: Boolean(opts.ok),
    [`push_${ch}_attempted`]: true,
    [`push_${ch}_at`]: now,
    [`push_${ch}_error`]: opts.ok ? '' : String(opts.error || '').slice(0, 300)
  };

  if (email) {
    data.by_email[email] = { ...(data.by_email[email] || {}), ...patch };
  }
  if (h) {
    data.by_sso_hash[h] = { ...(data.by_sso_hash[h] || {}), ...patch };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch (e) {
    console.warn('[accountTags] setPushTag failed', e);
    return false;
  }
}

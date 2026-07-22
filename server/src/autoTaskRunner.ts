import type { AppSettings } from '@shared/settings';
import type {
  AccountRecord,
  AccountSsoCheck
} from '@shared/runEvents';
import type {
  AutoTaskRunSummary,
  AutoTaskRetryItem,
  AutoTaskRetryOverview,
  AutoTaskStatus,
  AutoTaskStepSummary
} from '@shared/ipc';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
import { ssoCheckVerdict } from '@shared/ssoCheckVerdict';
import { dataDir, loadSettings } from './settingsStore.js';
import { resolveHttpProxy } from './resolveHttpProxy.js';
import {
  applyAccountSsoChecks,
  invalidateAuthIndexCache,
  listAccounts,
  listAccountsLite,
  matchAccounts
} from './accountStore.js';
import { runSsoCheckBatch } from './ssoCheck.js';
import {
  invalidateCpaAuthListCache,
  matchCpaAuth,
  mintCpaAuthFromSso,
  probeCpaAuthBatch,
  pushCpaAuthRemoteBatch,
  pushSub2apiAuthRemoteBatch
} from './cpaAuthStore.js';
import { pushSsoToGrok2apiBatch } from './ssoGrok2apiPush.js';
import {
  classifyAuthFailReason,
  classifyPushFailReason
} from './pythonJobPool.js';

const TICK_MS = 30_000;
const STATE_VERSION = 1;
const TRANSIENT_REASONS = new Set([
  'timeout',
  'network',
  'rate_limit',
  'http_error',
  'push_error',
  'python_error',
  'unknown'
]);

type RetryStateItem = AutoTaskRetryItem & {
  createdAt: string;
};

type PersistedAutoTaskState = {
  version: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastSummary: AutoTaskRunSummary | null;
  history: AutoTaskRunSummary[];
  retry: Record<string, RetryStateItem>;
};

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let nextRunAtMs: number | null = null;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastError: string | null = null;
let lastSummary: AutoTaskRunSummary | null = null;
let history: AutoTaskRunSummary[] = [];
let retryState: Record<string, RetryStateItem> = {};
let stateLoaded = false;
let stateLoadPromise: Promise<void> | null = null;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowIso(): string {
  return new Date().toISOString();
}

function statePath(): string {
  return join(dataDir(), 'auto_tasks_state.json');
}

function isoOrNull(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function isoToMs(value?: string | null): number | null {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : null;
}

function intervalMin(settings: AppSettings): number {
  const n = Number(settings.autoTaskIntervalMin);
  if (!Number.isFinite(n) || n < 5) return 30;
  return Math.min(Math.floor(n), 1440);
}

function intervalMs(settings: AppSettings): number {
  return intervalMin(settings) * 60_000;
}

function batchLimit(settings: AppSettings): number {
  const n = Number(settings.autoTaskBatchLimit);
  if (!Number.isFinite(n) || n < 10) return 100;
  return Math.min(Math.floor(n), 200);
}

function historyLimit(settings: AppSettings): number {
  const n = Number(settings.autoTaskHistoryLimit);
  if (!Number.isFinite(n) || n < 5) return 20;
  return Math.min(Math.floor(n), 100);
}

function ssoRecheckMs(settings: AppSettings): number {
  const n = Number(settings.autoTaskSsoRecheckHours);
  const hours = !Number.isFinite(n) || n < 1 ? 24 : Math.min(Math.floor(n), 168);
  return hours * 60 * 60 * 1000;
}

function retryBackoffMs(settings: AppSettings): number {
  const n = Number(settings.autoTaskRetryBackoffMin);
  const min = !Number.isFinite(n) || n < 5 ? 60 : Math.min(Math.floor(n), 1440);
  return min * 60_000;
}

function retryMaxAttempts(settings: AppSettings): number {
  const n = Number(settings.autoTaskRetryMaxAttempts);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(Math.floor(n), 10);
}

function retryEnabled(settings: AppSettings): boolean {
  return settings.autoTaskRetryEnabled !== false;
}

async function ensureStateLoaded(): Promise<void> {
  if (stateLoaded) return;
  if (stateLoadPromise) return stateLoadPromise;
  stateLoadPromise = (async () => {
    try {
      const file = statePath();
      if (!existsSync(file)) {
        stateLoaded = true;
        return;
      }
      const raw = JSON.parse(await fsp.readFile(file, 'utf-8')) as Partial<PersistedAutoTaskState>;
      if (raw && typeof raw === 'object') {
        lastStartedAt = typeof raw.lastStartedAt === 'string' ? raw.lastStartedAt : null;
        lastFinishedAt = typeof raw.lastFinishedAt === 'string' ? raw.lastFinishedAt : null;
        lastError = typeof raw.lastError === 'string' ? raw.lastError : null;
        lastSummary =
          raw.lastSummary && typeof raw.lastSummary === 'object'
            ? (raw.lastSummary as AutoTaskRunSummary)
            : null;
        history = Array.isArray(raw.history)
          ? raw.history.filter((x) => x && typeof x === 'object') as AutoTaskRunSummary[]
          : [];
        retryState =
          raw.retry && typeof raw.retry === 'object'
            ? (raw.retry as Record<string, RetryStateItem>)
            : {};
        const nextMs = isoToMs(raw.nextRunAt);
        nextRunAtMs = nextMs && nextMs > Date.now() ? nextMs : null;
      }
    } catch (err) {
      console.warn('[auto-task] load state failed', err);
    } finally {
      stateLoaded = true;
    }
  })();
  return stateLoadPromise;
}

async function saveState(settings?: AppSettings): Promise<void> {
  const keep = settings ? historyLimit(settings) : 20;
  history = history.slice(0, keep);
  const retryEntries = Object.values(retryState).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  retryState = Object.fromEntries(retryEntries.slice(0, 800).map((item) => [item.key, item]));
  const doc: PersistedAutoTaskState = {
    version: STATE_VERSION,
    lastStartedAt,
    lastFinishedAt,
    nextRunAt: isoOrNull(nextRunAtMs),
    lastError,
    lastSummary,
    history,
    retry: retryState
  };
  const file = statePath();
  const tmp = `${file}.tmp`;
  try {
    await fsp.mkdir(dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* ignore */
    }
    console.warn('[auto-task] save state failed', err);
  }
}

function ensureSchedule(settings: AppSettings): void {
  if (settings.autoTaskEnabled !== true) {
    nextRunAtMs = null;
    return;
  }
  const now = Date.now();
  const dueIn = intervalMs(settings);
  if (!nextRunAtMs) {
    nextRunAtMs = now + dueIn;
  } else if (nextRunAtMs > now + dueIn) {
    nextRunAtMs = now + dueIn;
  }
}

function checkedAtMs(check?: Pick<AccountSsoCheck, 'checkedAt'> | null): number {
  const t = Date.parse(String(check?.checkedAt || ''));
  return Number.isFinite(t) ? t : 0;
}

function isStaleSsoCheck(
  check?: Pick<AccountSsoCheck, 'checkedAt'> | null,
  staleMs = 24 * 60 * 60 * 1000,
  now = Date.now()
): boolean {
  const t = checkedAtMs(check);
  return !t || now - t >= staleMs;
}

function retryKey(step: string, target: string): string {
  return `${step}:${target}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function retryableReason(reason: string): boolean {
  return TRANSIENT_REASONS.has(String(reason || '').trim());
}

function retryDue(item: RetryStateItem | undefined, now = Date.now()): boolean {
  if (!item || !item.retryable || !item.nextAt) return false;
  const t = Date.parse(item.nextAt);
  return Number.isFinite(t) && t <= now;
}

function retryGateAllows(settings: AppSettings, step: string, target: string): boolean {
  if (!retryEnabled(settings)) return true;
  const item = retryState[retryKey(step, target)];
  if (!item) return true;
  return retryDue(item);
}

function dueRetryTargets(step: string, limit: number): RetryStateItem[] {
  const now = Date.now();
  return Object.values(retryState)
    .filter((it) => it.step === step && retryDue(it, now))
    .sort((a, b) => {
      const an = Date.parse(a.nextAt || '') || 0;
      const bn = Date.parse(b.nextAt || '') || 0;
      if (an !== bn) return an - bn;
      return a.lastAt.localeCompare(b.lastAt);
    })
    .slice(0, limit);
}

function clearRetry(step: string, target: string): boolean {
  const key = retryKey(step, target);
  if (!retryState[key]) return false;
  delete retryState[key];
  return true;
}

function recordRetryFailure(
  settings: AppSettings,
  step: string,
  target: string,
  reason: string,
  error?: string
): RetryStateItem | null {
  if (!retryEnabled(settings)) return null;
  const normalized = String(reason || 'unknown').trim() || 'unknown';
  const key = retryKey(step, target);
  const prev = retryState[key];
  const attempts = (prev?.attempts || 0) + 1;
  const maxAttempts = retryMaxAttempts(settings);
  const retryable = retryableReason(normalized) && attempts < maxAttempts;
  const base = retryBackoffMs(settings);
  const delay = Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), 24 * 60 * 60 * 1000);
  const now = nowIso();
  const item: RetryStateItem = {
    key,
    step,
    target,
    attempts,
    maxAttempts,
    lastReason: normalized,
    lastError: error ? String(error).slice(0, 240) : undefined,
    lastAt: now,
    nextAt: retryable ? new Date(Date.now() + delay).toISOString() : null,
    retryable,
    createdAt: prev?.createdAt || now
  };
  retryState[key] = item;
  return item;
}

function retryOverview(): AutoTaskRetryOverview {
  const now = Date.now();
  const items = Object.values(retryState)
    .sort((a, b) => {
      const ad = retryDue(a, now) ? 0 : 1;
      const bd = retryDue(b, now) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      const an = Date.parse(a.nextAt || '') || Number.MAX_SAFE_INTEGER;
      const bn = Date.parse(b.nextAt || '') || Number.MAX_SAFE_INTEGER;
      if (an !== bn) return an - bn;
      return b.lastAt.localeCompare(a.lastAt);
    });
  const byStep: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let due = 0;
  let blocked = 0;
  for (const item of items) {
    byStep[item.step] = (byStep[item.step] || 0) + 1;
    byReason[item.lastReason] = (byReason[item.lastReason] || 0) + 1;
    if (retryDue(item, now)) due++;
    if (!item.retryable) blocked++;
  }
  return {
    total: items.length,
    due,
    blocked,
    byStep,
    byReason,
    items: items.slice(0, 30)
  };
}

function authMintTarget(item: { email?: string; sso?: string; id?: string }): string {
  const email = String(item.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const sso = String(item.sso || '').trim();
  if (sso) return `sso:${shortHash(sso)}`;
  return `id:${String(item.id || '').trim()}`;
}

function ssoPriority(a: AccountRecord, settings: AppSettings): number {
  const dueKey = retryKey('ssoCheck', a.id);
  if (retryDue(retryState[dueKey])) return 0;
  if (retryEnabled(settings) && retryState[dueKey]) return 9;
  const v = ssoCheckVerdict(a.ssoCheck);
  if (v === 'unknown') return 1;
  if (v === 'unchecked') return 2;
  if (v === 'alive' && isStaleSsoCheck(a.ssoCheck, ssoRecheckMs(settings))) return 3;
  return 9;
}

function buildSsoRuntime(settings: AppSettings) {
  const timeoutMsRaw = Number(settings.ssoCheckTimeoutMs);
  const retryRaw = Number(settings.ssoCheckRetry);
  const concurrencyRaw = Number(settings.ssoCheckConcurrency);
  return {
    proxy: resolveHttpProxy(settings, 'ssoCheck'),
    timeoutMs:
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 5000
        ? Math.min(Math.floor(timeoutMsRaw), 60_000)
        : 12_000,
    retry:
      Number.isFinite(retryRaw) && retryRaw >= 0
        ? Math.min(Math.floor(retryRaw), 2)
        : 1,
    proxyFallback: settings.ssoCheckProxyFallback === true,
    concurrency:
      Number.isFinite(concurrencyRaw) && concurrencyRaw >= 1
        ? Math.min(Math.floor(concurrencyRaw), 20)
        : 5
  };
}

function summarizeSsoResults(
  results: Array<{
    alive: boolean | null;
    status: number;
  }>
): Pick<AutoTaskStepSummary, 'alive' | 'dead' | 'unknown'> {
  let alive = 0;
  let dead = 0;
  let unknown = 0;
  for (const r of results) {
    if (r.alive === true) {
      alive++;
    } else if (r.alive === false && (r.status === 401 || r.status === 403)) {
      dead++;
    } else {
      unknown++;
    }
  }
  return { alive, dead, unknown };
}

function classifySsoFailReason(input: {
  alive: boolean | null;
  status: number;
  error?: string;
}): string {
  const status = Number(input.status || 0) || 0;
  const err = String(input.error || '').toLowerCase();
  if (input.alive === false && (status === 401 || status === 403)) return 'sso_dead';
  if (status === 429 || err.includes('429') || err.includes('rate limit')) return 'rate_limit';
  if (
    err.includes('timeout') ||
    err.includes('etimedout') ||
    err.includes('timed out') ||
    err.includes('aborted')
  ) {
    return 'timeout';
  }
  if (
    err.includes('econn') ||
    err.includes('network') ||
    err.includes('socket') ||
    err.includes('proxy') ||
    err.includes('enotfound') ||
    err.includes('econnreset')
  ) {
    return 'network';
  }
  if (status >= 500 || err.includes('http ')) return 'http_error';
  return 'unknown';
}

async function selectSsoCheckCandidates(limit: number): Promise<{
  total: number;
  items: { id: string; sso: string }[];
  retrySelected: number;
}> {
  const settings = await loadSettings();
  const all = await listAccountsLite();
  const candidates = all
    .filter((a) => {
      if (!String(a.sso || '').trim()) return false;
      return ssoPriority(a, settings) < 9;
    })
    .sort((a, b) => {
      const pa = ssoPriority(a, settings);
      const pb = ssoPriority(b, settings);
      if (pa !== pb) return pa - pb;
      return checkedAtMs(a.ssoCheck) - checkedAtMs(b.ssoCheck);
    });
  const selected = candidates.slice(0, limit);
  return {
    total: candidates.length,
    retrySelected: selected.filter((a) => retryDue(retryState[retryKey('ssoCheck', a.id)])).length,
    items: selected.map((a) => ({
      id: a.id,
      sso: String(a.sso || '').trim()
    }))
  };
}

async function runSsoCheckStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  const limit = batchLimit(settings);
  const selected = await selectSsoCheckCandidates(limit);
  if (selected.items.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const results = await runSsoCheckBatch(selected.items, buildSsoRuntime(settings));
  const persisted = await applyAccountSsoChecks(results);
  const counts = summarizeSsoResults(results);
  let retryRecorded = 0;
  let retryCleared = 0;
  const failReasons: Record<string, number> = {};
  for (const r of results) {
    if (r.alive === true || (r.alive === false && (r.status === 401 || r.status === 403))) {
      if (clearRetry('ssoCheck', r.id)) retryCleared++;
      continue;
    }
    const reason = classifySsoFailReason(r);
    failReasons[reason] = (failReasons[reason] || 0) + 1;
    if (recordRetryFailure(settings, 'ssoCheck', r.id, reason, r.error)) retryRecorded++;
  }
  return {
    total: selected.total,
    selected: selected.items.length,
    retrySelected: selected.retrySelected,
    checked: results.length,
    ...counts,
    updated: persisted.updated,
    emailsFilled: persisted.emailsFilled,
    retryRecorded,
    retryCleared,
    failReasons: Object.keys(failReasons).length ? failReasons : undefined
  };
}

async function runAuthMintStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  const limit = batchLimit(settings);
  invalidateAuthIndexCache();
  const matched = await matchAccounts({
    sso: 'has_sso',
    auth: 'unconverted',
    requireSso: true,
    limit
  });
  const candidates = matched.items
    .filter((a) => String(a.sso || '').trim())
    .filter((a) => retryGateAllows(settings, 'authMint', authMintTarget(a)))
    .sort((a, b) => {
      const ad = retryDue(retryState[retryKey('authMint', authMintTarget(a))]) ? 0 : 1;
      const bd = retryDue(retryState[retryKey('authMint', authMintTarget(b))]) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.createdAt.localeCompare(b.createdAt);
    });
  if (candidates.length === 0) {
    return { total: matched.total, selected: 0 };
  }

  const now = Date.now();
  const needCheck = candidates.filter((a) => {
    const verdict = ssoCheckVerdict(a.ssoCheck);
    if (verdict === 'dead') return false;
    if (verdict === 'alive') return isStaleSsoCheck(a.ssoCheck, ssoRecheckMs(settings), now);
    return true;
  });

  const checkedIds = new Set<string>();
  const checkedAliveIds = new Set<string>();
  let checkedDead = 0;
  let checkedUnknown = 0;

  if (needCheck.length > 0) {
    const results = await runSsoCheckBatch(
      needCheck.map((a) => ({ id: a.id, sso: a.sso })),
      buildSsoRuntime(settings)
    );
    await applyAccountSsoChecks(results);
    for (const r of results) {
      checkedIds.add(r.id);
      if (r.alive === true) {
        checkedAliveIds.add(r.id);
      } else if (r.alive === false && (r.status === 401 || r.status === 403)) {
        checkedDead++;
      } else {
        checkedUnknown++;
      }
    }
  }

  const mintAccounts = candidates
    .filter((a) => {
      if (checkedIds.has(a.id)) return checkedAliveIds.has(a.id);
      return (
        ssoCheckVerdict(a.ssoCheck) === 'alive' &&
        !isStaleSsoCheck(a.ssoCheck, ssoRecheckMs(settings), now)
      );
    })
    .slice(0, limit);
  const mintItems = mintAccounts.map((a) => ({
    sso: String(a.sso || '').trim(),
    email: String(a.email || '').trim()
  }));

  if (mintItems.length === 0) {
    return {
      total: matched.total,
      selected: 0,
      checked: needCheck.length,
      dead: checkedDead,
      unknown: checkedUnknown,
      skipped: candidates.length
    };
  }

  const selectedTargets = new Map(
    mintAccounts.map((a) => [String(a.email || '').trim().toLowerCase(), authMintTarget(a)])
  );
  const retrySelected = mintAccounts.filter((a) =>
    retryDue(retryState[retryKey('authMint', authMintTarget(a))])
  ).length;
  const result = await mintCpaAuthFromSso({
    items: mintItems,
    concurrency: Math.min(3, Math.max(1, Number(settings.cpaResignConcurrency) || 2)),
    skipBotFlag1: settings.skipBotFlag1OnMint !== false,
    precheck: true
  });
  invalidateAuthIndexCache();
  invalidateCpaAuthListCache();
  let retryRecorded = 0;
  let retryCleared = 0;
  const failReasons = result.failReasons || {};
  for (const item of result.results || []) {
    const email = String(item.email || '').trim().toLowerCase();
    const target =
      selectedTargets.get(email) ||
      (email ? `email:${email}` : item.filename ? `file:${item.filename}` : '');
    if (!target) continue;
    if (item.ok) {
      if (clearRetry('authMint', target)) retryCleared++;
      continue;
    }
    const reason = item.failReason || classifyAuthFailReason(item) || 'unknown';
    if (recordRetryFailure(settings, 'authMint', target, reason, item.error)) retryRecorded++;
  }
  return {
    total: matched.total,
    selected: mintItems.length,
    retrySelected,
    checked: needCheck.length,
    alive: result.alive,
    dead: result.banned,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    botFlagSkipped: result.botFlagSkipped,
    remoteOk: result.remoteOk,
    remoteFailed: result.remoteFailed,
    retryRecorded,
    retryCleared,
    failReasons: Object.keys(failReasons).length ? failReasons : undefined
  };
}

async function selectCpaProbeFilenames(settings: AppSettings, limit: number): Promise<{
  total: number;
  filenames: string[];
  retrySelected: number;
}> {
  const filenames: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  const due = dueRetryTargets('cpaProbe', limit);
  total += due.length;
  for (const item of due) {
    const filename = String(item.target || '').trim();
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    filenames.push(filename);
    if (filenames.length >= limit) break;
  }
  const add = async (status: 'unprobed' | 'other_err') => {
    if (filenames.length >= limit) return;
    const matched = await matchCpaAuth({
      status,
      limit: limit - filenames.length
    });
    total += matched.total;
    for (const item of matched.items) {
      if (status === 'other_err') {
        const http = Number(item.probeHttp || 0) || 0;
        if (http === 401 || http === 402 || http === 403) continue;
      }
      const filename = String(item.filename || '').trim();
      if (!retryGateAllows(settings, 'cpaProbe', filename)) continue;
      if (!filename || seen.has(filename)) continue;
      seen.add(filename);
      filenames.push(filename);
      if (filenames.length >= limit) break;
    }
  };
  await add('other_err');
  await add('unprobed');
  return {
    total,
    filenames,
    retrySelected: filenames.filter((f) => retryDue(retryState[retryKey('cpaProbe', f)])).length
  };
}

async function runCpaProbeStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  const limit = batchLimit(settings);
  const selected = await selectCpaProbeFilenames(settings, limit);
  if (selected.filenames.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const result = await probeCpaAuthBatch({
    filenames: selected.filenames,
    concurrency: Math.min(12, Math.max(1, Number(settings.ssoCheckConcurrency) || 6)),
    deleteOnDead: settings.cpaProbeDeleteOnDead === true,
    recoverOnAuthError: false
  });
  invalidateAuthIndexCache();
  invalidateCpaAuthListCache();
  let retryRecorded = 0;
  let retryCleared = 0;
  const failReasons: Record<string, number> = {};
  const modeCounts: Record<string, number> = {};
  for (const item of result.results || []) {
    const filename = String(item.filename || '').trim();
    if (!filename) continue;
    const mode = String(item.mode || '').trim() || 'unknown';
    modeCounts[mode] = (modeCounts[mode] || 0) + 1;
    if (item.ok) {
      if (clearRetry('cpaProbe', filename)) retryCleared++;
      continue;
    }
    const reason = item.failReason || classifyAuthFailReason(item) || 'unknown';
    failReasons[reason] = (failReasons[reason] || 0) + 1;
    if (recordRetryFailure(settings, 'cpaProbe', filename, reason, item.error)) retryRecorded++;
  }
  return {
    total: selected.total,
    selected: selected.filenames.length,
    retrySelected: selected.retrySelected,
    ok: result.ok,
    failed: result.failed,
    dead: result.dead,
    deleted: result.deleted,
    keep: result.keep,
    ssoDeleted: result.ssoDeleted,
    retryRecorded,
    retryCleared,
    failReasons: Object.keys(failReasons).length ? failReasons : undefined,
    modeCounts: Object.keys(modeCounts).length ? modeCounts : undefined
  };
}

async function selectAuthPushFilenames(
  settings: AppSettings,
  prefix: 'cpa' | 's2a',
  limit: number
): Promise<{ total: number; filenames: string[]; retrySelected: number }> {
  const filenames: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  const step = prefix === 'cpa' ? 'pushCpa' : 'pushSub2api';
  const due = dueRetryTargets(step, limit);
  total += due.length;
  for (const item of due) {
    const filename = String(item.target || '').trim();
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    filenames.push(filename);
    if (filenames.length >= limit) break;
  }
  const add = async (push: 'cpa_none' | 'cpa_fail' | 's2a_none' | 's2a_fail') => {
    if (filenames.length >= limit) return;
    const matched = await matchCpaAuth({
      push,
      limit: limit - filenames.length
    });
    total += matched.total;
    for (const item of matched.items) {
      const filename = String(item.filename || '').trim();
      const step = prefix === 'cpa' ? 'pushCpa' : 'pushSub2api';
      if (!retryGateAllows(settings, step, filename)) continue;
      if (!filename || seen.has(filename)) continue;
      seen.add(filename);
      filenames.push(filename);
      if (filenames.length >= limit) break;
    }
  };
  if (prefix === 'cpa') {
    await add('cpa_fail');
    await add('cpa_none');
  } else {
    await add('s2a_fail');
    await add('s2a_none');
  }
  return {
    total,
    filenames,
    retrySelected: filenames.filter((f) => retryDue(retryState[retryKey(step, f)])).length
  };
}

async function runCpaPushStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  if (settings.autoPushAuthToCpa !== true) {
    return { selected: 0, skipped: 0 };
  }
  const limit = batchLimit(settings);
  const selected = await selectAuthPushFilenames(settings, 'cpa', limit);
  if (selected.filenames.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const result = await pushCpaAuthRemoteBatch({
    filenames: selected.filenames,
    concurrency: 3,
    force: false
  });
  invalidateCpaAuthListCache();
  let retryRecorded = 0;
  let retryCleared = 0;
  for (const item of result.results || []) {
    const filename = String(item.filename || '').trim();
    if (!filename) continue;
    if (item.ok && !item.skipped) {
      if (clearRetry('pushCpa', filename)) retryCleared++;
      continue;
    }
    if (item.ok && item.skipped) {
      if (clearRetry('pushCpa', filename)) retryCleared++;
      continue;
    }
    const reason = item.failReason || classifyPushFailReason(item) || 'unknown';
    if (recordRetryFailure(settings, 'pushCpa', filename, reason, item.error || item.remoteError)) {
      retryRecorded++;
    }
  }
  return {
    total: selected.total,
    selected: selected.filenames.length,
    retrySelected: selected.retrySelected,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    remoteOk: result.results.filter((r) => r.remoteOk === true).length,
    remoteFailed: result.results.filter((r) => r.remoteOk === false).length,
    retryRecorded,
    retryCleared,
    failReasons: result.failReasons,
    modeCounts: result.modeCounts
  };
}

async function runSub2apiPushStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  if (settings.autoPushAuthToSub2api !== true) {
    return { selected: 0, skipped: 0 };
  }
  const limit = batchLimit(settings);
  const selected = await selectAuthPushFilenames(settings, 's2a', limit);
  if (selected.filenames.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const result = await pushSub2apiAuthRemoteBatch({
    filenames: selected.filenames,
    concurrency: 3,
    force: false
  });
  invalidateCpaAuthListCache();
  let retryRecorded = 0;
  let retryCleared = 0;
  for (const item of result.results || []) {
    const filename = String(item.filename || '').trim();
    if (!filename) continue;
    if (item.ok) {
      if (clearRetry('pushSub2api', filename)) retryCleared++;
      continue;
    }
    const reason = item.failReason || classifyPushFailReason(item) || 'unknown';
    if (
      recordRetryFailure(settings, 'pushSub2api', filename, reason, item.error || item.remoteError)
    ) {
      retryRecorded++;
    }
  }
  return {
    total: selected.total,
    selected: selected.filenames.length,
    retrySelected: selected.retrySelected,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    remoteOk: result.results.filter((r) => r.remoteOk === true).length,
    remoteFailed: result.results.filter((r) => r.remoteOk === false).length,
    retryRecorded,
    retryCleared,
    failReasons: result.failReasons,
    modeCounts: result.modeCounts
  };
}

async function selectGrok2apiPushItems(settings: AppSettings, limit: number): Promise<{
  total: number;
  items: { id: string; sso: string; email?: string }[];
  retrySelected: number;
}> {
  const all = await listAccounts();
  const candidates = all
    .filter((a) => {
      if (!String(a.sso || '').trim()) return false;
      if (ssoCheckVerdict(a.ssoCheck) !== 'alive') return false;
      if (!retryGateAllows(settings, 'pushGrok2api', a.id)) return false;
      const status = a.ssoG2Status || 'none';
      return status === 'none' || status === 'fail';
    })
    .sort((a, b) => {
      const ad = retryDue(retryState[retryKey('pushGrok2api', a.id)]) ? 0 : 1;
      const bd = retryDue(retryState[retryKey('pushGrok2api', b.id)]) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      const pa = (a.ssoG2Status || 'none') === 'fail' ? 0 : 1;
      const pb = (b.ssoG2Status || 'none') === 'fail' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const atA = Date.parse(String(a.ssoG2At || '')) || 0;
      const atB = Date.parse(String(b.ssoG2At || '')) || 0;
      return atA - atB;
    });
  const selected = candidates.slice(0, limit);
  return {
    total: candidates.length,
    retrySelected: selected.filter((a) =>
      retryDue(retryState[retryKey('pushGrok2api', a.id)])
    ).length,
    items: selected.map((a) => ({
      id: a.id,
      sso: String(a.sso || '').trim(),
      email: String(a.email || '').trim() || undefined
    }))
  };
}

async function runGrok2apiPushStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  if (settings.autoPushSsoToGrok2api !== true) {
    return { selected: 0, skipped: 0 };
  }
  const limit = batchLimit(settings);
  const selected = await selectGrok2apiPushItems(settings, limit);
  if (selected.items.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const result = await pushSsoToGrok2apiBatch({
    items: selected.items,
    concurrency: 3,
    force: false
  });
  let retryRecorded = 0;
  let retryCleared = 0;
  for (const item of result.results || []) {
    const id = String(item.id || '').trim();
    if (!id) continue;
    if (item.ok) {
      if (clearRetry('pushGrok2api', id)) retryCleared++;
      continue;
    }
    const reason = item.failReason || classifyPushFailReason(item) || 'unknown';
    if (recordRetryFailure(settings, 'pushGrok2api', id, reason, item.error)) {
      retryRecorded++;
    }
  }
  return {
    total: selected.total,
    selected: selected.items.length,
    retrySelected: selected.retrySelected,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    retryRecorded,
    retryCleared,
    failReasons: result.failReasons
  };
}

async function runStep(
  summary: AutoTaskRunSummary,
  key: string,
  fn: () => Promise<AutoTaskStepSummary>
): Promise<void> {
  const started = Date.now();
  try {
    summary.steps[key] = {
      ...(await fn()),
      durationMs: Date.now() - started
    };
  } catch (err) {
    const message = `${key}: ${errorText(err)}`;
    summary.errors = [...(summary.errors || []), message];
    summary.steps[key] = { failed: 1, durationMs: Date.now() - started };
    console.warn(`[auto-task] ${message}`);
  }
}

async function runConfiguredSteps(
  settings: AppSettings,
  summary: AutoTaskRunSummary
): Promise<void> {
  if (settings.autoTaskSsoCheckEnabled === true) {
    await runStep(summary, 'ssoCheck', () => runSsoCheckStep(settings));
  }
  if (settings.autoTaskAuthMintEnabled === true) {
    await runStep(summary, 'authMint', () => runAuthMintStep(settings));
  }
  if (settings.autoTaskCpaProbeEnabled === true) {
    await runStep(summary, 'cpaProbe', () => runCpaProbeStep(settings));
  }
  if (settings.autoTaskPushEnabled === true) {
    await runStep(summary, 'pushCpa', () => runCpaPushStep(settings));
    await runStep(summary, 'pushSub2api', () => runSub2apiPushStep(settings));
    await runStep(summary, 'pushGrok2api', () => runGrok2apiPushStep(settings));
  }
}

export async function runAutoTaskOnce(reason = 'manual'): Promise<AutoTaskRunSummary> {
  await ensureStateLoaded();
  if (running) throw new Error('自动任务正在运行中');
  const settings = await loadSettings();
  const started = Date.now();
  const summary: AutoTaskRunSummary = {
    id: `auto-${started.toString(36)}`,
    reason,
    startedAt: new Date(started).toISOString(),
    steps: {}
  };
  running = true;
  lastStartedAt = summary.startedAt;
  lastError = null;
  await saveState(settings);
  console.log(`[auto-task] start reason=${reason}`);
  try {
    await runConfiguredSteps(settings, summary);
  } catch (err) {
    summary.errors = [...(summary.errors || []), errorText(err)];
  } finally {
    const finished = Date.now();
    summary.finishedAt = new Date(finished).toISOString();
    summary.durationMs = finished - started;
    running = false;
    lastFinishedAt = summary.finishedAt;
    lastSummary = summary;
    lastError = summary.errors?.length ? summary.errors.join('；') : null;
    history = [summary, ...history].slice(0, historyLimit(settings));
    const latest = await loadSettings().catch(() => settings);
    nextRunAtMs = latest.autoTaskEnabled === true ? Date.now() + intervalMs(latest) : null;
    await saveState(latest);
    console.log(
      `[auto-task] done reason=${reason} duration=${summary.durationMs}ms` +
        (lastError ? ` errors=${lastError}` : '')
    );
  }
  return summary;
}

async function tick(): Promise<void> {
  await ensureStateLoaded();
  if (running) return;
  let settings: AppSettings;
  try {
    settings = await loadSettings();
  } catch (err) {
    lastError = errorText(err);
    await saveState();
    return;
  }
  ensureSchedule(settings);
  await saveState(settings);
  if (settings.autoTaskEnabled !== true || !nextRunAtMs) return;
  if (Date.now() < nextRunAtMs) return;
  await runAutoTaskOnce('schedule').catch((err) => {
    lastError = errorText(err);
  });
}

export function startAutoTaskRunner(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  const maybeTimer = timer as unknown as { unref?: () => void };
  if (typeof maybeTimer.unref === 'function') maybeTimer.unref();
  void ensureStateLoaded().then(() => tick());
}

export function stopAutoTaskRunner(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export async function getAutoTaskStatus(): Promise<AutoTaskStatus> {
  await ensureStateLoaded();
  const settings = await loadSettings();
  ensureSchedule(settings);
  await saveState(settings);
  return {
    enabled: settings.autoTaskEnabled === true,
    running,
    intervalMin: intervalMin(settings),
    batchLimit: batchLimit(settings),
    lastStartedAt,
    lastFinishedAt,
    nextRunAt: isoOrNull(nextRunAtMs),
    lastError,
    lastSummary,
    history: history.slice(0, historyLimit(settings)),
    retry: retryOverview()
  };
}

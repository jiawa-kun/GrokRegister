import type { AppSettings } from '@shared/settings';
import type {
  AccountRecord,
  AccountSsoCheck
} from '@shared/runEvents';
import type {
  AutoTaskRunSummary,
  AutoTaskStatus,
  AutoTaskStepSummary
} from '@shared/ipc';
import { ssoCheckVerdict } from '@shared/ssoCheckVerdict';
import { loadSettings } from './settingsStore.js';
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

const TICK_MS = 30_000;
const SSO_RECHECK_MS = 24 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let nextRunAtMs: number | null = null;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastError: string | null = null;
let lastSummary: AutoTaskRunSummary | null = null;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
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
  now = Date.now()
): boolean {
  const t = checkedAtMs(check);
  return !t || now - t >= SSO_RECHECK_MS;
}

function ssoPriority(a: AccountRecord): number {
  const v = ssoCheckVerdict(a.ssoCheck);
  if (v === 'unknown') return 0;
  if (v === 'unchecked') return 1;
  if (v === 'alive' && isStaleSsoCheck(a.ssoCheck)) return 2;
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

async function selectSsoCheckCandidates(limit: number): Promise<{
  total: number;
  items: { id: string; sso: string }[];
}> {
  const all = await listAccountsLite();
  const candidates = all
    .filter((a) => {
      if (!String(a.sso || '').trim()) return false;
      return ssoPriority(a) < 9;
    })
    .sort((a, b) => {
      const pa = ssoPriority(a);
      const pb = ssoPriority(b);
      if (pa !== pb) return pa - pb;
      return checkedAtMs(a.ssoCheck) - checkedAtMs(b.ssoCheck);
    });
  return {
    total: candidates.length,
    items: candidates.slice(0, limit).map((a) => ({
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
  return {
    total: selected.total,
    selected: selected.items.length,
    checked: results.length,
    ...counts,
    updated: persisted.updated,
    emailsFilled: persisted.emailsFilled
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
  const candidates = matched.items.filter((a) => String(a.sso || '').trim());
  if (candidates.length === 0) {
    return { total: matched.total, selected: 0 };
  }

  const now = Date.now();
  const needCheck = candidates.filter((a) => {
    const verdict = ssoCheckVerdict(a.ssoCheck);
    if (verdict === 'dead') return false;
    if (verdict === 'alive') return isStaleSsoCheck(a.ssoCheck, now);
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

  const mintItems = candidates
    .filter((a) => {
      if (checkedIds.has(a.id)) return checkedAliveIds.has(a.id);
      return ssoCheckVerdict(a.ssoCheck) === 'alive' && !isStaleSsoCheck(a.ssoCheck, now);
    })
    .slice(0, limit)
    .map((a) => ({
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

  const result = await mintCpaAuthFromSso({
    items: mintItems,
    concurrency: Math.min(3, Math.max(1, Number(settings.cpaResignConcurrency) || 2)),
    skipBotFlag1: settings.skipBotFlag1OnMint !== false,
    precheck: true
  });
  invalidateAuthIndexCache();
  invalidateCpaAuthListCache();
  return {
    total: matched.total,
    selected: mintItems.length,
    checked: needCheck.length,
    alive: result.alive,
    dead: result.banned,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    botFlagSkipped: result.botFlagSkipped,
    remoteOk: result.remoteOk,
    remoteFailed: result.remoteFailed
  };
}

async function selectCpaProbeFilenames(limit: number): Promise<{
  total: number;
  filenames: string[];
}> {
  const filenames: string[] = [];
  const seen = new Set<string>();
  let total = 0;
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
      if (!filename || seen.has(filename)) continue;
      seen.add(filename);
      filenames.push(filename);
      if (filenames.length >= limit) break;
    }
  };
  await add('other_err');
  await add('unprobed');
  return { total, filenames };
}

async function runCpaProbeStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  const limit = batchLimit(settings);
  const selected = await selectCpaProbeFilenames(limit);
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
  return {
    total: selected.total,
    selected: selected.filenames.length,
    ok: result.ok,
    failed: result.failed,
    dead: result.dead,
    deleted: result.deleted,
    keep: result.keep,
    ssoDeleted: result.ssoDeleted
  };
}

async function selectAuthPushFilenames(
  prefix: 'cpa' | 's2a',
  limit: number
): Promise<{ total: number; filenames: string[] }> {
  const filenames: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  const add = async (push: 'cpa_none' | 'cpa_fail' | 's2a_none' | 's2a_fail') => {
    if (filenames.length >= limit) return;
    const matched = await matchCpaAuth({
      push,
      limit: limit - filenames.length
    });
    total += matched.total;
    for (const item of matched.items) {
      const filename = String(item.filename || '').trim();
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
  return { total, filenames };
}

async function runCpaPushStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  if (settings.autoPushAuthToCpa !== true) {
    return { selected: 0, skipped: 0 };
  }
  const limit = batchLimit(settings);
  const selected = await selectAuthPushFilenames('cpa', limit);
  if (selected.filenames.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const result = await pushCpaAuthRemoteBatch({
    filenames: selected.filenames,
    concurrency: 3,
    force: false
  });
  invalidateCpaAuthListCache();
  return {
    total: selected.total,
    selected: selected.filenames.length,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    remoteOk: result.results.filter((r) => r.remoteOk === true).length,
    remoteFailed: result.results.filter((r) => r.remoteOk === false).length
  };
}

async function runSub2apiPushStep(settings: AppSettings): Promise<AutoTaskStepSummary> {
  if (settings.autoPushAuthToSub2api !== true) {
    return { selected: 0, skipped: 0 };
  }
  const limit = batchLimit(settings);
  const selected = await selectAuthPushFilenames('s2a', limit);
  if (selected.filenames.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const result = await pushSub2apiAuthRemoteBatch({
    filenames: selected.filenames,
    concurrency: 3,
    force: false
  });
  invalidateCpaAuthListCache();
  return {
    total: selected.total,
    selected: selected.filenames.length,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    remoteOk: result.results.filter((r) => r.remoteOk === true).length,
    remoteFailed: result.results.filter((r) => r.remoteOk === false).length
  };
}

async function selectGrok2apiPushItems(limit: number): Promise<{
  total: number;
  items: { id: string; sso: string; email?: string }[];
}> {
  const all = await listAccounts();
  const candidates = all
    .filter((a) => {
      if (!String(a.sso || '').trim()) return false;
      if (ssoCheckVerdict(a.ssoCheck) !== 'alive') return false;
      const status = a.ssoG2Status || 'none';
      return status === 'none' || status === 'fail';
    })
    .sort((a, b) => {
      const pa = (a.ssoG2Status || 'none') === 'fail' ? 0 : 1;
      const pb = (b.ssoG2Status || 'none') === 'fail' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const atA = Date.parse(String(a.ssoG2At || '')) || 0;
      const atB = Date.parse(String(b.ssoG2At || '')) || 0;
      return atA - atB;
    });
  return {
    total: candidates.length,
    items: candidates.slice(0, limit).map((a) => ({
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
  const selected = await selectGrok2apiPushItems(limit);
  if (selected.items.length === 0) {
    return { total: selected.total, selected: 0 };
  }
  const result = await pushSsoToGrok2apiBatch({
    items: selected.items,
    concurrency: 3,
    force: false
  });
  return {
    total: selected.total,
    selected: selected.items.length,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped
  };
}

async function runStep(
  summary: AutoTaskRunSummary,
  key: string,
  fn: () => Promise<AutoTaskStepSummary>
): Promise<void> {
  try {
    summary.steps[key] = await fn();
  } catch (err) {
    const message = `${key}: ${errorText(err)}`;
    summary.errors = [...(summary.errors || []), message];
    summary.steps[key] = { failed: 1 };
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
  if (running) throw new Error('自动任务正在运行中');
  const settings = await loadSettings();
  const started = Date.now();
  const summary: AutoTaskRunSummary = {
    reason,
    startedAt: new Date(started).toISOString(),
    steps: {}
  };
  running = true;
  lastStartedAt = summary.startedAt;
  lastError = null;
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
    const latest = await loadSettings().catch(() => settings);
    nextRunAtMs = latest.autoTaskEnabled === true ? Date.now() + intervalMs(latest) : null;
    console.log(
      `[auto-task] done reason=${reason} duration=${summary.durationMs}ms` +
        (lastError ? ` errors=${lastError}` : '')
    );
  }
  return summary;
}

async function tick(): Promise<void> {
  if (running) return;
  let settings: AppSettings;
  try {
    settings = await loadSettings();
  } catch (err) {
    lastError = errorText(err);
    return;
  }
  ensureSchedule(settings);
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
  void tick();
}

export function stopAutoTaskRunner(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export async function getAutoTaskStatus(): Promise<AutoTaskStatus> {
  const settings = await loadSettings();
  ensureSchedule(settings);
  return {
    enabled: settings.autoTaskEnabled === true,
    running,
    intervalMin: intervalMin(settings),
    batchLimit: batchLimit(settings),
    lastStartedAt,
    lastFinishedAt,
    nextRunAt: isoOrNull(nextRunAtMs),
    lastError,
    lastSummary
  };
}

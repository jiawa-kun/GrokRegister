import type { RendererApi } from '@shared/ipc';
import type { ThemeMode } from '@shared/settings';
import type { RunEvent, TestResult } from '@shared/runEvents';

function buildHeaders(body?: unknown): HeadersInit {
  return {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
  };
}

/** 批量任务取消：Auth 等页在批次期间挂上 AbortSignal，结束后务必 clear */
let activeAbortSignal: AbortSignal | null = null;

export function setWebApiAbortSignal(signal: AbortSignal | null): void {
  activeAbortSignal = signal;
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 已 abort 的 signal 勿再挂上，否则设置页测活等会整批“秒失败”
  const signal =
    activeAbortSignal && !activeAbortSignal.aborted ? activeAbortSignal : undefined;
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: buildHeaders(body),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    // Cloudflare 524 等会返回整页 HTML，避免把巨型 body 塞进 Error
    if (res.status === 524) {
      throw new Error(
        `${method} ${path} → HTTP 524 源站超时（测活块过大或过慢；已请用分块测活）`
      );
    }
    if (detail.length > 240 || /<!DOCTYPE html/i.test(detail)) {
      detail = detail.replace(/\s+/g, ' ').slice(0, 180) + '…';
    }
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
const listeners = new Set<(event: RunEvent) => void>();

function emit(event: RunEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

function clearReconnectTimer() {
  if (reconnectTimer != null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function connectWs() {
  if (typeof window === 'undefined' || ws || listeners.size === 0) return;
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  ws = new WebSocket(url.toString());
  ws.onmessage = (message) => {
    try {
      emit(JSON.parse(String(message.data)) as RunEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    ws = null;
    if (listeners.size > 0) {
      clearReconnectTimer();
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectWs();
      }, 1500);
    }
  };
}

function maybeCloseWs() {
  if (listeners.size > 0) return;
  clearReconnectTimer();
  if (ws) {
    ws.close();
    ws = null;
  }
}

const webApi: RendererApi = {
  getAuthState: () => http('GET', '/api/auth/me'),
  getAuthBootstrap: () => http('GET', '/api/auth/bootstrap'),
  login: (username, password) => http('POST', '/api/auth/login', { username, password }),
  logout: async () => {
    await http('POST', '/api/auth/logout');
    return { ok: true };
  },
  changeCredentials: (input) => http('POST', '/api/auth/change', input),

  getSettings: () => http('GET', '/api/settings'),
  saveSettings: async (s) => {
    await http('PUT', '/api/settings', s);
    return { ok: true };
  },

  startRegister: (args) => http('POST', '/api/run/start', args ?? {}),
  stopRegister: async (runId, opts) => {
    return http<{ ok: boolean; stopped?: string[] }>('POST', '/api/run/stop', {
      runId: runId || undefined,
      stopAll: opts?.stopAll === true
    });
  },
  getStatus: () => http('GET', '/api/run/status'),
  getAuthQueueMetrics: () =>
    http<{
      ok?: boolean;
      pending?: number;
      queue_size?: number;
      done_ok?: number;
      done_fail?: number;
      workers?: number;
      queue_max?: number;
      updated_at?: number;
      updated_iso?: string;
      stale?: boolean;
    }>('GET', '/api/auth-queue/metrics'),
  listRegisterJobs: () => http('GET', '/api/run/jobs'),
  getRegisterJobStatus: (runId) =>
    http('GET', `/api/run/jobs/${encodeURIComponent(runId)}`),
  focusRegisterJob: (runId) =>
    http('POST', '/api/run/focus', { runId }),
  clearFinishedRegisterJobs: () =>
    http<{ ok: true; removed: number; removedIds?: string[] }>(
      'POST',
      '/api/run/jobs/clear-finished'
    ),
  onRegisterEvent: (cb) => {
    listeners.add(cb);
    connectWs();
    return () => {
      listeners.delete(cb);
      maybeCloseWs();
    };
  },

  listAccounts: () => http('GET', '/api/accounts'),
  getAccount: (id) => http('GET', `/api/accounts/${encodeURIComponent(id)}`),
  listAccountsPage: (query) => {
    const qs = new URLSearchParams();
    qs.set('paged', '1');
    if (query?.page != null) qs.set('page', String(query.page));
    if (query?.pageSize != null) qs.set('pageSize', String(query.pageSize));
    if (query?.q) qs.set('q', query.q);
    if (query?.sso) qs.set('sso', query.sso);
    if (query?.alive) qs.set('alive', query.alive);
    if (query?.auth) qs.set('auth', query.auth);
    return http('GET', `/api/accounts?${qs.toString()}`);
  },
  matchAccounts: (query) => {
    const qs = new URLSearchParams();
    if (query?.q) qs.set('q', query.q);
    if (query?.sso) qs.set('sso', query.sso);
    if (query?.alive) qs.set('alive', query.alive);
    if (query?.auth) qs.set('auth', query.auth);
    if (query?.limit != null) qs.set('limit', String(query.limit));
    if (query?.requireSso) qs.set('requireSso', '1');
    const q = qs.toString();
    return http('GET', q ? `/api/accounts/match?${q}` : '/api/accounts/match');
  },
  getFailStageBoard: (opts) => {
    const qs = new URLSearchParams();
    if (opts?.runId) qs.set('runId', opts.runId);
    if (opts?.all) qs.set('all', '1');
    const q = qs.toString();
    return http('GET', q ? `/api/run/fail-stages?${q}` : '/api/run/fail-stages');
  },
  resyncAccounts: () =>
    http<{ total: number; imported: number }>('POST', '/api/accounts/resync'),
  deleteAccounts: (ids) =>
    http<{ deleted: number; requested: number; remaining: number }>(
      'POST',
      '/api/accounts/delete',
      { ids }
    ),
  importAccounts: (input) =>
    http<{
      totalLines: number;
      parsed: number;
      imported: number;
      skipped: number;
      invalid: number;
      remaining: number;
    }>('POST', '/api/accounts/import', input),

  getMailCode: (address) =>
    http('GET', `/api/mail/code?address=${encodeURIComponent(address)}`),
  checkSso: async (items) => {
    const r = await http<{
      results: import('@shared/ipc').SsoCheckResult[];
      emailsFilled?: number;
    }>('POST', '/api/sso/check', { items });
    const list = r.results || [];
    Object.defineProperty(list, 'emailsFilled', {
      value: r.emailsFilled ?? 0,
      enumerable: false,
      writable: false
    });
    return list as typeof list & { emailsFilled?: number };
  },
  checkSsoStream: async (items, onItem) => {
    const signal =
      activeAbortSignal && !activeAbortSignal.aborted ? activeAbortSignal : undefined;
    const res = await fetch('/api/sso/check-stream', {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders({ items }),
      body: JSON.stringify({ items }),
      signal
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      if (detail.length > 240 || /<!DOCTYPE html/i.test(detail)) {
        detail = detail.replace(/\s+/g, ' ').slice(0, 180) + '…';
      }
      throw new Error(
        `POST /api/sso/check-stream → HTTP ${res.status}: ${detail}`
      );
    }
    if (!res.body) {
      const r = await http<{
        results: import('@shared/ipc').SsoCheckResult[];
        emailsFilled?: number;
      }>('POST', '/api/sso/check', { items });
      const list = r.results || [];
      for (const it of list) onItem(it);
      Object.defineProperty(list, 'emailsFilled', {
        value: r.emailsFilled ?? 0,
        enumerable: false,
        writable: false
      });
      return list as typeof list & { emailsFilled?: number };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const list: import('@shared/ipc').SsoCheckResult[] = [];
    let emailsFilled = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(t) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.type === 'item') {
          const item = { ...msg } as unknown as import('@shared/ipc').SsoCheckResult & {
            type?: string;
          };
          delete (item as { type?: string }).type;
          list.push(item);
          onItem(item);
        } else if (msg.type === 'done') {
          emailsFilled = Number(msg.emailsFilled) || 0;
        } else if (msg.type === 'error') {
          throw new Error(String(msg.error || 'SSO 验活流失败'));
        }
      }
    }
    Object.defineProperty(list, 'emailsFilled', {
      value: emailsFilled,
      enumerable: false,
      writable: false
    });
    return list as typeof list & { emailsFilled?: number };
  },
  pushSsoToGrok2api: (input) =>
    http('POST', '/api/accounts/push-grok2api', input),

  listCpaAuth: () => http('GET', '/api/cpa-auth'),
  getAuthBadgeIndex: () => http('GET', '/api/cpa-auth/badge-index'),
  listCpaAuthPage: (query) => {
    const qs = new URLSearchParams();
    qs.set('paged', '1');
    if (query?.page != null) qs.set('page', String(query.page));
    if (query?.pageSize != null) qs.set('pageSize', String(query.pageSize));
    if (query?.q) qs.set('q', query.q);
    if (query?.meta) qs.set('meta', query.meta);
    if (query?.status) qs.set('status', query.status);
    if (query?.push) qs.set('push', query.push);
    return http('GET', `/api/cpa-auth?${qs.toString()}`);
  },
  matchCpaAuth: (query) => {
    const qs = new URLSearchParams();
    if (query?.q) qs.set('q', query.q);
    if (query?.meta) qs.set('meta', query.meta);
    if (query?.status) qs.set('status', query.status);
    if (query?.push) qs.set('push', query.push);
    if (query?.limit != null) qs.set('limit', String(query.limit));
    if (query?.requireSso) qs.set('requireSso', '1');
    if (query?.requireMissingSso) qs.set('requireMissingSso', '1');
    if (query?.requireEmail) qs.set('requireEmail', '1');
    const q = qs.toString();
    return http('GET', q ? `/api/cpa-auth/match?${q}` : '/api/cpa-auth/match');
  },
  resignCpaAuth: (input) => http('POST', '/api/cpa-auth/resign', input),
  resignCpaAuthBatch: (input) => http('POST', '/api/cpa-auth/resign-batch', input),
  resignCpaAuthBatchStream: async (input, onItem) => {
    const signal =
      activeAbortSignal && !activeAbortSignal.aborted ? activeAbortSignal : undefined;
    const res = await fetch('/api/cpa-auth/resign-stream', {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders(input),
      body: JSON.stringify(input),
      signal
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      if (detail.length > 240 || /<!DOCTYPE html/i.test(detail)) {
        detail = detail.replace(/\s+/g, ' ').slice(0, 180) + '…';
      }
      throw new Error(
        `POST /api/cpa-auth/resign-stream → HTTP ${res.status}: ${detail}`
      );
    }
    if (!res.body) {
      return http('POST', '/api/cpa-auth/resign-batch', input);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let summary: import('@shared/ipc').CpaAuthBatchResult | null = null;
    const results: import('@shared/ipc').CpaAuthBatchResultItem[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(t) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.type === 'item') {
          const item = { ...msg } as unknown as import('@shared/ipc').CpaAuthBatchResultItem & {
            type?: string;
          };
          delete (item as { type?: string }).type;
          results.push(item);
          onItem(item);
        } else if (msg.type === 'done') {
          summary = {
            total: Number(msg.total) || results.length,
            ok: Number(msg.ok) || 0,
            failed: Number(msg.failed) || 0,
            remoteOk: Number(msg.remoteOk) || 0,
            remoteFailed: Number(msg.remoteFailed) || 0,
            results
          };
        } else if (msg.type === 'error') {
          throw new Error(String(msg.error || '重签流失败'));
        }
      }
    }
    if (summary) return summary;
    const ok = results.filter((r) => r.ok).length;
    return {
      total: results.length,
      ok,
      failed: results.length - ok,
      remoteOk: results.filter((r) => r.remoteOk === true).length,
      remoteFailed: results.filter((r) => r.remoteOk === false).length,
      results
    };
  },
  mintCpaAuthFromSso: (input) => http('POST', '/api/cpa-auth/mint', input),
  mintCpaAuthFromSsoStream: async (input, onItem) => {
    const signal =
      activeAbortSignal && !activeAbortSignal.aborted ? activeAbortSignal : undefined;
    const res = await fetch('/api/cpa-auth/mint-stream', {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders(input),
      body: JSON.stringify(input),
      signal
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      if (detail.length > 240 || /<!DOCTYPE html/i.test(detail)) {
        detail = detail.replace(/\s+/g, ' ').slice(0, 180) + '…';
      }
      throw new Error(
        `POST /api/cpa-auth/mint-stream → HTTP ${res.status}: ${detail}`
      );
    }
    if (!res.body) {
      return http('POST', '/api/cpa-auth/mint', input);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let summary: import('@shared/ipc').CpaAuthBatchResult | null = null;
    const results: import('@shared/ipc').CpaAuthBatchResultItem[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(t) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.type === 'item') {
          const item = { ...msg } as unknown as import('@shared/ipc').CpaAuthBatchResultItem & {
            type?: string;
          };
          delete (item as { type?: string }).type;
          results.push(item);
          onItem(item);
        } else if (msg.type === 'done') {
          summary = {
            total: Number(msg.total) || results.length,
            ok: Number(msg.ok) || 0,
            failed: Number(msg.failed) || 0,
            skipped: Number(msg.skipped) || 0,
            banned: Number(msg.banned) || 0,
            remoteOk: Number(msg.remoteOk) || 0,
            remoteFailed: Number(msg.remoteFailed) || 0,
            results
          };
        } else if (msg.type === 'error') {
          throw new Error(String(msg.error || '补签流失败'));
        }
      }
    }
    if (summary) return summary;
    const ok = results.filter((r) => r.ok).length;
    const skipped = results.filter((r) => r.skipped).length;
    return {
      total: results.length,
      ok,
      failed: results.length - ok - skipped,
      skipped,
      banned: results.filter((r) => r.verdict === 'banned').length,
      remoteOk: results.filter((r) => r.remoteOk === true).length,
      remoteFailed: results.filter((r) => r.remoteOk === false).length,
      results
    };
  },
  probeCpaAuthBatch: (input) => http('POST', '/api/cpa-auth/probe-batch', input),
  probeCpaAuthBatchStream: async (input, onItem) => {
    const signal =
      activeAbortSignal && !activeAbortSignal.aborted ? activeAbortSignal : undefined;
    const res = await fetch('/api/cpa-auth/probe-batch-stream', {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders(input),
      body: JSON.stringify(input),
      signal
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      if (detail.length > 240 || /<!DOCTYPE html/i.test(detail)) {
        detail = detail.replace(/\s+/g, ' ').slice(0, 180) + '…';
      }
      throw new Error(
        `POST /api/cpa-auth/probe-batch-stream → HTTP ${res.status}: ${detail}`
      );
    }
    if (!res.body) {
      // 无流能力：回退整包
      return http('POST', '/api/cpa-auth/probe-batch', input);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let summary: import('@shared/ipc').CpaAuthBatchResult | null = null;
    const results: import('@shared/ipc').CpaAuthBatchResultItem[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(t) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.type === 'item') {
          const item = { ...msg } as unknown as import('@shared/ipc').CpaAuthBatchResultItem & {
            type?: string;
          };
          delete (item as { type?: string }).type;
          results.push(item);
          onItem(item);
        } else if (msg.type === 'done') {
          summary = {
            total: Number(msg.total) || results.length,
            ok: Number(msg.ok) || 0,
            failed: Number(msg.failed) || 0,
            dead: Number(msg.dead) || 0,
            deleted: Number(msg.deleted) || 0,
            keep: Number(msg.keep) || 0,
            ssoDeleted: Number(msg.ssoDeleted) || 0,
            results
          };
        } else if (msg.type === 'error') {
          throw new Error(String(msg.error || '测活流失败'));
        }
      }
    }
    if (summary) return summary;
    // 流意外结束：用已收集结果汇总
    const ok = results.filter((r) => r.ok).length;
    const dead = results.filter((r) => r.probeAction === 'dead').length;
    const deleted = results.filter((r) => r.probeDeleted).length;
    const keep = results.filter((r) => r.probeAction === 'keep').length;
    return {
      total: results.length,
      ok,
      failed: results.length - ok,
      dead,
      deleted,
      keep,
      ssoDeleted: 0,
      results
    };
  },
  reloginCpaAuth: (input) => http('POST', '/api/cpa-auth/relogin', input),
  pushCpaAuthRemote: (input) => http('POST', '/api/cpa-auth/push-remote', input),
  pushSub2apiAuthRemote: (input) => http('POST', '/api/cpa-auth/push-sub2api', input),
  deleteCpaAuth: (input) => http('POST', '/api/cpa-auth/delete', input),
  exportCpaAuth: (input) => http('POST', '/api/cpa-auth/export', input),
  backfillCpaAuthSso: (input) =>
    http('POST', '/api/cpa-auth/backfill-sso', input ?? {}),

  getTheme: async () => {
    const stored = (localStorage.getItem('theme') as ThemeMode | null) ?? 'system';
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = stored === 'system' ? (dark ? 'dark' : 'light') : stored;
    return { mode: stored, effective };
  },
  setTheme: async (mode) => {
    localStorage.setItem('theme', mode);
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = mode === 'system' ? (dark ? 'dark' : 'light') : mode;
    return { mode, effective };
  },
  onThemeChanged: (cb) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      const stored = (localStorage.getItem('theme') as ThemeMode | null) ?? 'system';
      if (stored !== 'system') return;
      cb({ mode: 'system', effective: mq.matches ? 'dark' : 'light' });
    };
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  },

  testMail: (b) => http<TestResult>('POST', '/api/test/mail', b),
  testTurnstileSolver: (input) =>
    http<
      TestResult & {
        status?: number;
        url?: string;
        latencyMs?: number;
        enabled?: boolean;
      }
    >('POST', '/api/test/turnstile-solver', {
      url: input?.url,
      enabled: input?.enabled
    }),
  testCpaRemote: (input) =>
    http<TestResult & { status?: number; remoteUrl?: string }>('POST', '/api/test/cpa-remote', {
      url: input?.url,
      key: input?.key
    }),
  testSub2apiRemote: (input) =>
    http<TestResult & { status?: number; remoteUrl?: string }>('POST', '/api/test/sub2api-remote', {
      url: input?.url,
      token: input?.token
    }),
  listSub2apiGroups: (input) =>
    http<{
      ok: boolean;
      message: string;
      groups: string[];
      source?: string;
      remoteUrl?: string;
    }>('POST', '/api/test/sub2api-groups', {
      url: input?.url,
      token: input?.token
    }),
  testGrok2apiRemote: (input) =>
    http<TestResult & { status?: number; remoteUrl?: string; latencyMs?: number }>(
      'POST',
      '/api/test/grok2api-remote',
      {
        url: input?.url,
        username: input?.username,
        password: input?.password
      }
    ),
  testProxy: (proxy) =>
    http<TestResult & { exitIp?: string; latencyMs?: number }>('POST', '/api/test/proxy', {
      proxy
    }),
  fetchProxiesFromUrl: (input) =>
    http('POST', '/api/proxy/fetch', {
      url: input?.url,
      viaProxy: input?.viaProxy === true,
      pages: input?.pages
    }),
  testProxyBatch: (input) =>
    http('POST', '/api/test/proxy-batch', {
      proxies: input.proxies,
      concurrency: input.concurrency,
      timeoutMs: input.timeoutMs
    }),

  getCfProxyStatus: () => http('GET', '/api/cf-proxy/status'),
  startCfProxy: () => http('POST', '/api/cf-proxy/start'),
  stopCfProxy: () => http('POST', '/api/cf-proxy/stop'),
  syncCfProxy: () => http('POST', '/api/cf-proxy/sync'),
  getCfProxyLog: (tail = 200) =>
    http('GET', `/api/cf-proxy/log?tail=${encodeURIComponent(String(tail))}`),

  getSingBoxStatus: () => http('GET', '/api/singbox/status'),
  getSingBoxNodes: () => http('GET', '/api/singbox/nodes'),
  parseSingBoxNodes: (nodes: string) =>
    http('POST', '/api/singbox/parse', { nodes }),
  importSingBoxSubscription: (input) =>
    http('POST', '/api/singbox/subscription', {
      url: input?.url,
      mode: input?.mode,
      existing: input?.existing
    }),
  startSingBox: (opts) =>
    http('POST', '/api/singbox/start', {
      force: opts?.force === true,
      nodes: opts?.nodes,
      selected: opts?.selected
    }),
  stopSingBox: () => http('POST', '/api/singbox/stop'),
  syncSingBox: () => http('POST', '/api/singbox/sync'),
  rotateSingBox: (reason?: string) =>
    http('POST', '/api/singbox/rotate', { reason: reason || 'manual' }),
  getSingBoxLog: (tail = 200) =>
    http('GET', `/api/singbox/log?tail=${encodeURIComponent(String(tail))}`),

  getSystemHealth: () => http('GET', '/api/system/health'),
  getSystemVersion: () =>
    http<{ current: string; buildId?: string; version?: string }>('GET', '/api/system/version'),
  checkUpdate: () => http('GET', '/api/system/update-check')
};

export function installWebApiIfNeeded() {
  if (typeof window === 'undefined') return;
  if ((window as Window & { api?: RendererApi }).api) return;
  (window as Window & { api: RendererApi }).api = webApi;
}

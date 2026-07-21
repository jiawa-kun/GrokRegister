/**
 * Node 侧 CPA auth 纯测活（对齐 register/cpa_probe.probe_cpa_auth）。
 * 不 spawn Python；不包含密码重登恢复。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { proxiedRequest } from './httpClient.js';

/** 与 cpa_schema.DEFAULT_BASE_URL 一致 */
export const CPA_DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const CPA_GROK_CLIENT_VERSION = '0.2.93';
export const CPA_DEFAULT_CLIENT_HEADERS: Record<string, string> = {
  'User-Agent': `grok-pager/${CPA_GROK_CLIENT_VERSION} grok-shell/${CPA_GROK_CLIENT_VERSION} (linux; x86_64)`,
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-authenticateresponse': 'authenticate-response',
  'x-grok-client-identifier': 'grok-pager',
  'x-grok-client-version': CPA_GROK_CLIENT_VERSION
};

const DEFAULT_DEAD_STATUSES = new Set([401, 402, 403]);

export type CpaProbeAction = 'ok' | 'dead' | 'keep' | 'error';

export interface CpaProbeNodeResult {
  ok: boolean;
  alive: boolean;
  action: CpaProbeAction;
  http_status?: number;
  summary?: string;
  email?: string;
  path?: string;
  elapsed_ms: number;
  error?: string;
  deleted?: boolean;
}

function summarizeBody(data: unknown): string {
  let raw = '';
  try {
    raw = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  } catch {
    raw = String(data ?? '');
  }
  const summary = raw.replace(/\r/g, '').split(/\s+/).join(' ').trim();
  return summary.length > 300 ? `${summary.slice(0, 300)}...` : summary;
}

/**
 * 对单个 CPA auth JSON 文件做 /responses 测活。
 */
export async function probeCpaAuthFileNode(
  filePath: string,
  opts?: {
    proxy?: string;
    model?: string;
    prompt?: string;
    maxOutputTokens?: number;
    timeoutMs?: number;
    deadStatuses?: Set<number>;
  }
): Promise<CpaProbeNodeResult> {
  const started = Date.now();
  const path = String(filePath || '').trim();
  const deadStatuses = opts?.deadStatuses ?? DEFAULT_DEAD_STATUSES;
  const proxy = String(opts?.proxy || '').trim();
  const model = String(opts?.model || 'grok-4.5');
  const prompt = String(opts?.prompt || 'ping');
  const maxOutputTokens = Math.max(1, Number(opts?.maxOutputTokens) || 1);
  const timeoutMs = Math.max(3000, Math.min(60000, Number(opts?.timeoutMs) || 20000));

  if (!path || !existsSync(path)) {
    return {
      ok: false,
      alive: false,
      action: 'error',
      error: `文件不存在: ${path || '(empty)'}`,
      path,
      elapsed_ms: Date.now() - started
    };
  }

  let doc: Record<string, unknown>;
  try {
    const raw = await fsp.readFile(path, 'utf-8');
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      alive: false,
      action: 'error',
      error: `read failed: ${e instanceof Error ? e.message : String(e)}`,
      path,
      elapsed_ms: Date.now() - started
    };
  }

  const access = String(doc.access_token || '').trim();
  const email = String(doc.email || '');
  const base = String(doc.base_url || CPA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!access) {
    return {
      ok: false,
      alive: false,
      action: 'error',
      error: 'missing access_token',
      email,
      path,
      elapsed_ms: Date.now() - started
    };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-grok-client-version': CPA_GROK_CLIENT_VERSION,
    ...CPA_DEFAULT_CLIENT_HEADERS
  };
  const fileHeaders = doc.headers;
  if (fileHeaders && typeof fileHeaders === 'object' && !Array.isArray(fileHeaders)) {
    for (const [k, v] of Object.entries(fileHeaders as Record<string, unknown>)) {
      if (v == null) continue;
      const key = String(k);
      if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'content-type') continue;
      headers[key] = String(v);
    }
  }

  const endpoint = `${base}/responses`;
  try {
    const res = await proxiedRequest(endpoint, {
      method: 'POST',
      proxy: proxy || undefined,
      timeoutMs,
      headers,
      body: {
        model,
        input: prompt,
        max_output_tokens: maxOutputTokens,
        store: false
      }
    });
    const status = Number(res.status || 0);
    const summary = summarizeBody(res.data) || (status >= 200 && status < 300 ? 'ok' : `HTTP ${status}`);
    const elapsed_ms = Date.now() - started;

    if (status >= 200 && status < 300) {
      return {
        ok: true,
        alive: true,
        action: 'ok',
        http_status: status,
        summary,
        email,
        path,
        elapsed_ms
      };
    }
    if (deadStatuses.has(status)) {
      return {
        ok: false,
        alive: false,
        action: 'dead',
        http_status: status,
        summary,
        email,
        path,
        elapsed_ms,
        error: `HTTP ${status}`
      };
    }
    return {
      ok: false,
      alive: false,
      action: 'keep',
      http_status: status,
      summary,
      email,
      path,
      elapsed_ms,
      error: `HTTP ${status}`
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      alive: false,
      action: 'error',
      email,
      path,
      elapsed_ms: Date.now() - started,
      error: msg.slice(0, 300),
      summary: msg.slice(0, 300)
    };
  }
}

export function cpaProbeFilename(pathOrName: string): string {
  return basename(String(pathOrName || '').trim());
}

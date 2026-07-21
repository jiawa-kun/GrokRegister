/**
 * SSO 验活：用 sso token 作 cookie 请求 grok.com 的用户信息接口。
 * - 200 = 存活
 * - 401/403 = 失效
 * - 网络/超时/429/其它 HTTP = 未知（alive=null，不写死号）
 * 额外解码 JWT 中的 bot_flag_source（只读）。
 *
 * 可选：429/5xx/网络重试；代理失败后降级直连。
 */
import { proxiedRequest } from './httpClient.js';
import { readBotFlagFromToken } from './jwtBotFlag.js';
import { mapPoolAdaptive } from './asyncPoolAdaptive.js';

const GET_USER_URL = 'https://grok.com/rest/auth/get-user';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 默认验活超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 12_000;

export interface SsoCheckOutcome {
  /**
   * true=存活；false=仅 401/403 失效；null=未知(网络/超时/429/其它)。
   */
  alive: boolean | null;
  status: number;
  email?: string;
  givenName?: string;
  familyName?: string;
  emailConfirmed?: boolean;
  sessionTierId?: string;
  createTime?: string;
  error?: string;
  /** JWT claim bot_flag_source（可能为 null） */
  botFlagSource?: number | string | null;
  /** bot_flag_source === 1 */
  isBotFlag1?: boolean;
}

export interface CheckSsoOptions {
  /** HTTP 代理 URL；空则直连 */
  proxy?: string;
  /** 单次请求超时毫秒，默认 12000 */
  timeoutMs?: number;
  /**
   * 对 429 / 5xx / 网络错误的额外重试次数（0～2）。
   * 401/403/200 不重试。
   */
  retry?: number;
  /**
   * 代理请求后仍为「可重试未知」时，再试一次直连。
   * 仅当 proxy 非空时生效。
   */
  proxyFallback?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampRetry(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), 2);
}

function clampTimeout(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 5000) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(v), 60_000);
}

/** 429 / 5xx / 网络(status=0) 可重试；确定存活/失效不重试 */
function isRetryableOutcome(o: SsoCheckOutcome): boolean {
  if (o.alive === true || o.alive === false) return false;
  if (o.status === 0) return true;
  if (o.status === 429) return true;
  if (o.status >= 500) return true;
  return false;
}

type BotFlag = ReturnType<typeof readBotFlagFromToken>;

async function checkSsoOnce(
  token: string,
  flag: BotFlag,
  proxy: string | undefined,
  timeoutMs: number
): Promise<SsoCheckOutcome> {
  try {
    const res = await proxiedRequest(GET_USER_URL, {
      headers: {
        Cookie: `sso=${token}; sso-rw=${token}`,
        'User-Agent': UA,
        Accept: 'application/json'
      },
      proxy,
      timeoutMs
    });

    if (res.status === 200) {
      const u = res.data as Record<string, unknown>;
      // 非 JSON 业务体：不当作确定存活
      if (!u || typeof u !== 'object' || Array.isArray(u)) {
        return {
          alive: null,
          status: 200,
          error: 'grok 返回非用户 JSON',
          botFlagSource: flag.botFlagSource,
          isBotFlag1: flag.isBotFlag1
        };
      }
      return {
        alive: true,
        status: 200,
        email: typeof u.email === 'string' ? u.email : undefined,
        givenName: typeof u.givenName === 'string' ? u.givenName : undefined,
        familyName: typeof u.familyName === 'string' ? u.familyName : undefined,
        emailConfirmed: typeof u.emailConfirmed === 'boolean' ? u.emailConfirmed : undefined,
        sessionTierId: u.sessionTierId != null ? String(u.sessionTierId) : undefined,
        createTime: typeof u.createTime === 'string' ? u.createTime : undefined,
        botFlagSource: flag.botFlagSource,
        isBotFlag1: flag.isBotFlag1
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        alive: false,
        status: res.status,
        botFlagSource: flag.botFlagSource,
        isBotFlag1: flag.isBotFlag1
      };
    }

    // 429 / 5xx / 其它：未知，不写死号
    return {
      alive: null,
      status: res.status,
      error: `grok 返回 HTTP ${res.status}`,
      botFlagSource: flag.botFlagSource,
      isBotFlag1: flag.isBotFlag1
    };
  } catch (e) {
    return {
      alive: null,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
      botFlagSource: flag.botFlagSource,
      isBotFlag1: flag.isBotFlag1
    };
  }
}

/**
 * @param sso sso cookie 值（可带 sso= 前缀）
 * @param opts 超时 / 重试 / 代理 / 代理失败降级直连
 */
export async function checkSso(
  sso: string,
  opts?: CheckSsoOptions | string
): Promise<SsoCheckOutcome> {
  // 兼容旧调用 checkSso(sso, proxyString)
  const options: CheckSsoOptions =
    typeof opts === 'string' ? { proxy: opts } : opts || {};

  const token = (sso || '').replace(/^sso=/, '').trim();
  if (!token) return { alive: false, status: 0, error: '缺少 sso token' };

  const flag = readBotFlagFromToken(token);
  const timeoutMs = clampTimeout(options.timeoutMs);
  const retry = clampRetry(options.retry);
  const proxy = String(options.proxy || '').trim() || undefined;
  const proxyFallback = options.proxyFallback === true && Boolean(proxy);

  let last = await checkSsoOnce(token, flag, proxy, timeoutMs);

  for (let i = 0; i < retry && isRetryableOutcome(last); i++) {
    const waitMs = 400 * (i + 1) + Math.floor(Math.random() * 200);
    await sleep(waitMs);
    last = await checkSsoOnce(token, flag, proxy, timeoutMs);
  }

  if (proxyFallback && isRetryableOutcome(last)) {
    const viaProxy = last;
    const direct = await checkSsoOnce(token, flag, undefined, timeoutMs);
    if (direct.alive !== null) {
      return {
        ...direct,
        error: direct.error
          ? `${direct.error}（代理失败后直连）`
          : viaProxy.error
            ? `代理：${viaProxy.error}；已直连确认`
            : undefined
      };
    }
    // 直连仍未知：合并错误信息
    const parts = [
      viaProxy.error ? `代理：${viaProxy.error}` : null,
      direct.error ? `直连：${direct.error}` : null
    ].filter(Boolean);
    return {
      ...direct,
      error: parts.length > 0 ? parts.join('；') : '代理与直连均未知'
    };
  }

  return last;
}

/**
 * 批量 SSO 验活（自适应并发）。可选 onItem 流式回调。
 */
export async function runSsoCheckBatch(
  items: { id: string; sso: string }[],
  opts: {
    proxy?: string;
    timeoutMs?: number;
    retry?: number;
    proxyFallback?: boolean;
    concurrency?: number;
    onItem?: (row: SsoCheckOutcome & { id: string; checkedAt: string }) => void | Promise<void>;
  } = {}
): Promise<Array<SsoCheckOutcome & { id: string; checkedAt: string }>> {
  type Row = SsoCheckOutcome & { id: string; checkedAt: string };
  const concurrency = Math.min(
    20,
    Math.max(1, Number.isFinite(Number(opts.concurrency)) ? Math.floor(Number(opts.concurrency)) : 5)
  );
  const timeoutMs = opts.timeoutMs;
  const retry = opts.retry;
  const proxy = opts.proxy;
  const proxyFallback = opts.proxyFallback === true;

  return mapPoolAdaptive<{ id: string; sso: string }, Row>(items, {
    concurrency,
    minConcurrency: 1,
    rateLimitBackoffMs: 500,
    isRateLimited: (r) => r.status === 429,
    worker: async (item) => {
      const outcome = await checkSso(item.sso, {
        proxy,
        timeoutMs,
        retry,
        proxyFallback
      });
      return { id: item.id, ...outcome, checkedAt: new Date().toISOString() };
    },
    onResult: opts.onItem
      ? async (row) => {
          await opts.onItem!(row);
        }
      : undefined
  });
}

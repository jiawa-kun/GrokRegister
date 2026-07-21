/**
 * SSO 验活：用 sso token 作 cookie 请求 grok.com 的用户信息接口。
 * - 200 = 存活
 * - 401/403 = 失效
 * - 网络/超时/429/其它 HTTP = 未知（alive=null，不写死号）
 * 额外解码 JWT 中的 bot_flag_source（只读）。
 */
import { proxiedRequest } from './httpClient.js';
import { readBotFlagFromToken } from './jwtBotFlag.js';

const GET_USER_URL = 'https://grok.com/rest/auth/get-user';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 验活请求超时（秒级；避免大批量长时间挂起） */
const SSO_CHECK_TIMEOUT_MS = 12_000;

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

export async function checkSso(sso: string, proxy?: string): Promise<SsoCheckOutcome> {
  const token = (sso || '').replace(/^sso=/, '').trim();
  if (!token) return { alive: false, status: 0, error: '缺少 sso token' };

  const flag = readBotFlagFromToken(token);

  try {
    const res = await proxiedRequest(GET_USER_URL, {
      headers: {
        Cookie: `sso=${token}; sso-rw=${token}`,
        'User-Agent': UA,
        Accept: 'application/json'
      },
      proxy,
      timeoutMs: SSO_CHECK_TIMEOUT_MS
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

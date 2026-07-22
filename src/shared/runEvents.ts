/**
 * Python 子进程往渲染进程流式推送的事件。
 * stdout 行已经按前缀分级，渲染端只关心 level + text。
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'tip' | 'plain';

export type RunPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'done'
  | 'error'
  | 'killed';

export interface RunStatus {
  phase: RunPhase;
  runId: string | null;
  pid: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  /** 当前轮次 */
  current: number;
  /** 计划总轮次 */
  total: number;
  /** 注册成功数 */
  success: number;
  /** 注册失败数 */
  failed: number;
  /** 当前任务中 Plan A/B/C 成功次数 */
  planASuccess: number;
  planBSuccess: number;
  planCSuccess: number;
  /** 错误摘要，仅 phase==='error' 时有值 */
  errorMessage: string | null;
}

/** 号池 SSO 验活快照（落盘在 accounts.json，跨设备/清浏览器缓存仍可恢复） */
export interface AccountSsoCheck {
  /** true=存活；false=失效(仅 401/403)；null=未知(网络/超时/429 等) */
  alive: boolean | null;
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
}

/** 一条完整账号记录：邮箱 + 密码 + sso，由 registerBot 从 Python stdout 关联生成 */
export interface AccountRecord {
  id: string;
  runId: string;
  email: string;
  password: string;
  sso: string;
  /** ISO 字符串 */
  createdAt: string;
  /** 最近一次 SSO 验活结果（可选，服务端持久化） */
  ssoCheck?: AccountSsoCheck;
  /** NSFW 侧车：true 已开 / false 失败 / null 未尝试 */
  nsfwEnabled?: boolean | null;
  nsfwAttempted?: boolean;
  nsfwAt?: string;
  nsfwError?: string;
  /** ok | fail | none */
  nsfwStatus?: 'ok' | 'fail' | 'none';
  /** ZDR：true=已关 / false=仍开或失败 / null=未尝试 */
  zdrClosed?: boolean | null;
  zdrAttempted?: boolean;
  zdrAt?: string;
  zdrError?: string;
  /** closed | open | none */
  zdrStatus?: 'closed' | 'open' | 'none';
  /**
   * 分页列表轻字段：是否有密码/SSO（全文仅 detail/match 返回）。
   * 旧全量接口可能不带此字段。
   */
  hasPassword?: boolean;
  hasSso?: boolean;
  /** SSO→grok2api (G2A) 推送状态，来自 account_tags */
  ssoG2Status?: 'ok' | 'fail' | 'none';
  ssoG2At?: string | null;
  ssoG2Error?: string | null;
}

export interface StructuredRunEvent {
  type:
    | 'log'
    | 'progress'
    | 'account'
    | 'success'
    | 'failed'
    | 'sso'
    | 'exit'
    | 'bootstrap'
    | 'perf_round_start'
    | 'perf_stage'
    | 'perf_round_end';
  runId?: string;
  level?: LogLevel;
  current?: number;
  total?: number;
  success?: number;
  failed?: number;
  pid?: number;
  text?: string;
  token?: string;
  record?: AccountRecord;
  code?: number | null;
  signal?: string | null;
  killed?: boolean;
  phase?: string;
  username?: string;
  email?: string;
  password?: string;
  sso?: string;
  plan?: string;
  planASuccess?: number;
  planBSuccess?: number;
  planCSuccess?: number;
  round?: number;
  stage?: string;
  ms?: number;
  ok?: boolean;
  message?: string;
  ts?: number;
}

/** Auth 重登阶段（WebSocket 推送，UI 显示登录中/mint/激活） */
export type ReloginStage =
  | 'queued'
  | 'checking'
  | 'login'
  | 'mint'
  | 'activate'
  | 'probe'
  | 'done'
  | 'error';

export type RunEvent =
  | { type: 'started'; runId: string; pid: number; total: number }
  | { type: 'stdout'; runId: string; level: LogLevel; text: string; ts: number }
  | { type: 'stderr'; runId: string; text: string; ts: number }
  | { type: 'progress'; runId: string; current: number; total: number }
  | {
      type: 'success';
      runId: string;
      success: number;
      failed: number;
      total: number;
      plan?: 'a' | 'b' | 'c';
      planASuccess?: number;
      planBSuccess?: number;
      planCSuccess?: number;
    }
  | {
      type: 'failed';
      runId: string;
      success: number;
      failed: number;
      total: number;
      /** 本轮失败明细（可选） */
      message?: string;
      /** 启发式阶段：mail|turnstile|... */
      failStage?: string;
      plan?: string;
      round?: number;
    }
  | { type: 'sso'; runId: string; token: string }
  | { type: 'account'; runId: string; record: AccountRecord }
  | {
      type: 'exit';
      runId: string;
      code: number | null;
      signal: string | null;
      killed: boolean;
    }
  /** CPA Auth 密码重登进度（不经过 registerBot） */
  | {
      type: 'relogin_progress';
      filename: string;
      email?: string;
      stage: ReloginStage;
      message?: string;
      ts: number;
    }
  | { type: 'structured'; payload: StructuredRunEvent; raw?: string };

/** 测试连接的统一返回 */
export interface TestResult {
  ok: boolean;
  message: string;
  /** 调用耗时（ms） */
  ms?: number;
  /** 服务端返回的额外信息（例如 token 总数、Python 版本） */
  detail?: Record<string, unknown>;
}

export const EMPTY_STATUS: RunStatus = {
  phase: 'idle',
  runId: null,
  pid: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  current: 0,
  total: 0,
  success: 0,
  failed: 0,
  planASuccess: 0,
  planBSuccess: 0,
  planCSuccess: 0,
  errorMessage: null
};

/**
 * 注册失败分阶段归因（从 message / 日志文本启发式归类）。
 * 用于看板聚合，不保证 100% 精确。
 */

export type FailStageId =
  | 'mail'
  | 'turnstile'
  | 'profile'
  | 'sso'
  | 'proxy'
  | 'blocked'
  | 'timeout'
  | 'plan'
  | 'other';

export type FailStageStat = {
  id: FailStageId;
  label: string;
  count: number;
};

export const FAIL_STAGE_LABELS: Record<FailStageId, string> = {
  mail: '邮箱/验证码',
  turnstile: 'Turnstile',
  profile: '资料/同意',
  sso: 'SSO/登录',
  proxy: '代理/网络',
  blocked: '风控/拦截',
  timeout: '超时',
  plan: '方案失败',
  other: '其他'
};

const RULES: { id: FailStageId; re: RegExp }[] = [
  {
    id: 'mail',
    re: /mail|邮箱|验证码|code_timeout|get_oai|收信|临时邮|duckmail|gptmail|yyds|cloudflare.?temp/i
  },
  {
    id: 'turnstile',
    re: /turnstile|cf.?challenge|人机|captcha|yescaptcha|solver/i
  },
  {
    id: 'blocked',
    re: /blocked|ban|风控|attention required|access denied|403|cloudflare.*block|bot_flag/i
  },
  {
    id: 'proxy',
    re: /proxy|代理|tunnel|socks|err_proxy|err_tunnel|直连|sing-?box|连接失败|connection (refused|reset|timed)/i
  },
  {
    id: 'timeout',
    re: /timeout|超时|timed?\s*out|deadline/i
  },
  {
    id: 'profile',
    re: /profile|资料|同意|terms|birthday|birth|sign-?up|注册页|fill_profile/i
  },
  {
    id: 'sso',
    re: /sso|cookie|session|登录|sign-?in|oauth|mint|pkce|device.?code/i
  },
  {
    id: 'plan',
    re: /plan\s*[abc]|全部方案|hybrid|方案/i
  }
];

export function classifyFailStage(message: string | null | undefined): FailStageId {
  const text = String(message || '').trim();
  if (!text) return 'other';
  for (const r of RULES) {
    if (r.re.test(text)) return r.id;
  }
  return 'other';
}

export function emptyFailStageCounts(): Record<FailStageId, number> {
  return {
    mail: 0,
    turnstile: 0,
    profile: 0,
    sso: 0,
    proxy: 0,
    blocked: 0,
    timeout: 0,
    plan: 0,
    other: 0
  };
}

export function bumpFailStage(
  counts: Record<FailStageId, number>,
  message: string | null | undefined
): FailStageId {
  const id = classifyFailStage(message);
  counts[id] = (counts[id] || 0) + 1;
  return id;
}

export function failStageStats(
  counts: Partial<Record<FailStageId, number>> | null | undefined
): FailStageStat[] {
  const base = emptyFailStageCounts();
  if (counts) {
    for (const k of Object.keys(base) as FailStageId[]) {
      const n = Number(counts[k] || 0);
      if (Number.isFinite(n) && n > 0) base[k] = Math.floor(n);
    }
  }
  return (Object.keys(base) as FailStageId[])
    .map((id) => ({ id, label: FAIL_STAGE_LABELS[id], count: base[id] }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
}

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

/** 各阶段操作建议（给注册页看板用） */
export const FAIL_STAGE_TIPS: Record<FailStageId, string> = {
  mail: '检查邮箱 API/域名/密钥；换 mail 提供方或降并行',
  turnstile: '开外置 Solver / YesCaptcha；换 IP 或开 Sing-Box 节点',
  profile: '页面结构可能变更；看日志 Plan A/B/C 是否全挂',
  sso: '登录/SSO 提取失败；检查是否卡同意页或 mint 超时',
  proxy: '检查 Sing-Box 节点连通；直连可试开代理',
  blocked: '出口 IP 被风控；换住宅节点 / 降并行 / 拉长间隔',
  timeout: '机器或网络慢；降并行、加超时、检查 CPU/内存',
  plan: '多方案均失败；先看主因阶段再针对性改',
  other: '看最近失败明细与完整日志定位'
};

export function tipForFailStage(id: string | null | undefined): string {
  const key = String(id || '').trim() as FailStageId;
  if (key && key in FAIL_STAGE_TIPS) return FAIL_STAGE_TIPS[key];
  return FAIL_STAGE_TIPS.other;
}

/**
 * 根据阶段统计生成 1～3 条建议（按失败占比排序）。
 */
export function suggestForFailStages(
  stages: { id: string; count: number; pct?: number }[],
  opts?: { totalFailed?: number; failRate?: number }
): string[] {
  const tips: string[] = [];
  const total = opts?.totalFailed ?? stages.reduce((n, s) => n + (s.count || 0), 0);
  const rate = opts?.failRate;
  if (typeof rate === 'number' && rate >= 60 && total >= 3) {
    tips.push(`失败率 ${rate}% 偏高：建议先降并行到 1，确认单路稳定再加`);
  }
  const sorted = [...stages].sort((a, b) => (b.count || 0) - (a.count || 0));
  for (const s of sorted.slice(0, 3)) {
    if (!s.count) continue;
    const pct =
      typeof s.pct === 'number'
        ? s.pct
        : total > 0
          ? Math.round((s.count / total) * 100)
          : 0;
    if (pct < 15 && sorted[0] && s.id !== sorted[0].id) continue;
    const tip = tipForFailStage(s.id);
    const label = FAIL_STAGE_LABELS[s.id as FailStageId] || s.id;
    tips.push(`${label} ${pct}%：${tip}`);
  }
  if (tips.length === 0 && total > 0) {
    tips.push(FAIL_STAGE_TIPS.other);
  }
  return tips.slice(0, 3);
}

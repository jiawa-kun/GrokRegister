/**
 * SSO 验活结果三态：存活 / 失效(仅 401/403) / 未知(网络、超时、429 等)。
 */
import type { AccountSsoCheck } from './runEvents';

export type SsoCheckVerdict = 'unchecked' | 'alive' | 'dead' | 'unknown';

/** 明确账号失效：仅 HTTP 401/403 */
export function isSsoDefinitelyDead(
  status: number,
  alive: boolean | null | undefined
): boolean {
  if (alive !== false) return false;
  return status === 401 || status === 403;
}

/**
 * 从 ssoCheck 快照得到展示/筛选 verdict。
 * - 无快照 → unchecked
 * - alive===true → alive
 * - alive===false 且 status 401/403 → dead
 * - 其余已检（含 alive===null、历史网络假死）→ unknown
 */
export function ssoCheckVerdict(
  check?: Pick<AccountSsoCheck, 'alive' | 'status'> | null
): SsoCheckVerdict {
  if (!check) return 'unchecked';
  if (check.alive === true) return 'alive';
  if (isSsoDefinitelyDead(Number(check.status || 0), check.alive)) return 'dead';
  // 有过验活记录但无法确认存活/失效
  if (check.alive === false || check.alive === null) return 'unknown';
  return 'unchecked';
}

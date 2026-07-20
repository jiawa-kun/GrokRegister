/**
 * SPA 查询串读写（无 router）：刷新/分享可恢复筛选与页码。
 */

export function readQuery(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search || '');
  } catch {
    return new URLSearchParams();
  }
}

export function getQuery(key: string): string {
  return readQuery().get(key) || '';
}

export function getQueryInt(key: string, fallback: number): number {
  const n = Number(getQuery(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 合并写入 URL query（replaceState，不产生历史噪音）。
 * value 为 null/undefined/'' 时删除该 key。
 */
export function patchQuery(patch: Record<string, string | number | null | undefined>): void {
  try {
    const qs = readQuery();
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '' || v === 'all') {
        // all 视为默认筛选，不写进 URL 以保持干净
        if (v === 'all' || v === '' || v == null) qs.delete(k);
        else qs.set(k, String(v));
      } else {
        qs.set(k, String(v));
      }
    }
    const s = qs.toString();
    const next = s ? `${window.location.pathname}?${s}${window.location.hash || ''}` : `${window.location.pathname}${window.location.hash || ''}`;
    const cur = `${window.location.pathname}${window.location.search}${window.location.hash || ''}`;
    if (next !== cur) {
      window.history.replaceState(null, '', next);
    }
  } catch {
    /* ignore */
  }
}

export function oneOf<T extends string>(raw: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

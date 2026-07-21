/**
 * 自适应并发池：遇限流结果自动降并发，稳定后缓慢回升。
 */
export type AdaptivePoolOptions<T, R> = {
  /** 初始/上限并发 */
  concurrency: number;
  /** 下限并发，默认 1 */
  minConcurrency?: number;
  worker: (item: T, index: number) => Promise<R>;
  /** 是否判定为限流（如 HTTP 429） */
  isRateLimited?: (result: R) => boolean;
  /** 每条完成回调（流式进度） */
  onResult?: (result: R, index: number) => void | Promise<void>;
  /** 触发限流后的额外等待毫秒（会乘以连击次数） */
  rateLimitBackoffMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 按自适应并发执行 map，保持结果下标与输入一致。
 */
export async function mapPoolAdaptive<T, R>(
  items: T[],
  opts: AdaptivePoolOptions<T, R>
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const maxConc = Math.max(1, Math.floor(Number(opts.concurrency) || 1));
  const minConc = Math.max(1, Math.floor(Number(opts.minConcurrency) || 1));
  const backoffBase = Math.max(0, Math.floor(Number(opts.rateLimitBackoffMs) || 400));
  let conc = Math.min(maxConc, n);
  let next = 0;
  let active = 0;
  let consecutiveRateLimits = 0;
  const results = new Array<R>(n);
  let settled = false;

  return new Promise<R[]>((resolve, reject) => {
    const launch = () => {
      if (settled) return;
      while (active < conc && next < n) {
        const i = next++;
        active++;
        void (async () => {
          try {
            const r = await opts.worker(items[i], i);
            if (settled) return;
            results[i] = r;
            if (opts.isRateLimited?.(r)) {
              consecutiveRateLimits += 1;
              conc = Math.max(minConc, Math.floor(conc / 2) || 1);
              if (backoffBase > 0) {
                const wait =
                  backoffBase * consecutiveRateLimits +
                  Math.floor(Math.random() * 200);
                await sleep(wait);
              }
            } else {
              consecutiveRateLimits = 0;
              if (conc < maxConc) {
                conc = Math.min(maxConc, conc + 1);
              }
            }
            if (opts.onResult) await opts.onResult(r, i);
          } catch (e) {
            if (!settled) {
              settled = true;
              reject(e);
            }
            return;
          } finally {
            active--;
            if (settled) return;
            if (next >= n && active === 0) {
              settled = true;
              resolve(results);
            } else {
              launch();
            }
          }
        })();
      }
    };

    launch();
  });
}

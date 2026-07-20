import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCcw } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { cn } from '@renderer/lib/cn';
import type { SystemHealth, SystemHealthCheck, SystemHealthLevel } from '@shared/ipc';

function levelTone(level: SystemHealthLevel): string {
  if (level === 'error') return 'text-destructive';
  if (level === 'warn') return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function levelDot(level: SystemHealthLevel): string {
  if (level === 'error') return 'bg-destructive';
  if (level === 'warn') return 'bg-amber-500';
  return 'bg-emerald-500';
}

function overallLevel(h: SystemHealth | null): SystemHealthLevel {
  if (!h) return 'ok';
  if ((h.summary?.error || 0) > 0) return 'error';
  if ((h.summary?.warn || 0) > 0) return 'warn';
  return 'ok';
}

function CheckRow({ c }: { c: SystemHealthCheck }) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/40 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span
          className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', levelDot(c.level))}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium tracking-tight">{c.label}</span>
            <span className={cn('text-[10px] font-semibold uppercase', levelTone(c.level))}>
              {c.level}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{c.message}</p>
          {c.detail ? (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80" title={c.detail}>
              {c.detail}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SystemHealthCard({
  compact = false,
  pollMs = 15000
}: {
  compact?: boolean;
  pollMs?: number;
}) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.api.getSystemHealth();
      setHealth(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(id);
  }, [load, pollMs]);

  const level = overallLevel(health);
  const checks = health?.checks || [];
  const summary = health?.summary;

  return (
    <div className="rounded-xl border border-border bg-card/80 p-3.5 shadow-[var(--ios-shadow)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className={cn('h-4 w-4 shrink-0', levelTone(level))} aria-hidden />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-[-0.02em]">系统健康</div>
            <p className="text-[10px] text-muted-foreground">
              {err
                ? '检查失败'
                : summary
                  ? `OK ${summary.ok} · 警告 ${summary.warn} · 错误 ${summary.error}`
                  : '检测中…'}
              {health?.checkedAt
                ? ` · ${String(health.checkedAt).slice(11, 19)}`
                : ''}
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void load()}
          disabled={loading}
          title="重新检测"
        >
          <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {err ? (
        <p className="mt-2 text-[11px] text-destructive">{err}</p>
      ) : compact ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {checks.map((c) => (
            <span
              key={c.id}
              title={`${c.label}: ${c.message}${c.detail ? `\n${c.detail}` : ''}`}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[10px]',
                levelTone(c.level)
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', levelDot(c.level))} />
              {c.label}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {checks.map((c) => (
            <CheckRow key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

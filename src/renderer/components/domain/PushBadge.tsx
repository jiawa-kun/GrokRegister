import { cn } from '@renderer/lib/cn';

/** 推送结果 tag：绿=成功 / 黄=失败 / 灰=未推送 */
export function PushBadge({
  label,
  status,
  error,
  at,
  className
}: {
  /** 短标签，如 G2 / CPA / S2A */
  label: string;
  status?: 'ok' | 'fail' | 'none' | boolean | null;
  error?: string | null;
  at?: string | null;
  className?: string;
}) {
  let s: 'ok' | 'fail' | 'none' = 'none';
  if (status === 'ok' || status === true) s = 'ok';
  else if (status === 'fail' || status === false) s = 'fail';
  else s = 'none';

  const timeHint = at ? ` · ${at}` : '';

  if (s === 'ok') {
    return (
      <span
        title={`${label} 已推送成功${timeHint}`}
        className={cn(
          'inline-flex h-5 items-center rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium leading-none text-emerald-600 dark:text-emerald-400',
          className
        )}
      >
        {label}
      </span>
    );
  }
  if (s === 'fail') {
    return (
      <span
        title={error ? `${label} 推送失败: ${error}${timeHint}` : `${label} 推送失败${timeHint}`}
        className={cn(
          'inline-flex h-5 items-center rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium leading-none text-amber-700 dark:text-amber-400',
          className
        )}
      >
        {label}×
      </span>
    );
  }
  return (
    <span
      title={`${label} 尚未推送`}
      className={cn(
        'inline-flex h-5 items-center rounded-full bg-muted px-1.5 text-[10px] font-medium leading-none text-muted-foreground',
        className
      )}
    >
      {label}—
    </span>
  );
}

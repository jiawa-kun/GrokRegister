import { useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import {
  type RegisterPlanId,
  moveRegisterPlanOrder,
  normalizeRegisterPlanOrder
} from '@shared/settings';

const PLAN_META: Record<
  RegisterPlanId,
  { short: string; title: string; hint: string }
> = {
  A: { short: 'A', title: 'Plan A · 浏览器主流程', hint: '浏览器主流程' },
  B: { short: 'B', title: 'Plan B · 拟人兜底', hint: '拟人兜底' },
  C: { short: 'C', title: 'Plan C · Hybrid 协议', hint: 'Hybrid 协议' }
};

export type PlanEnabledMap = Record<RegisterPlanId, boolean>;

type Props = {
  order: RegisterPlanId[];
  enabled: PlanEnabledMap;
  onOrderChange: (next: RegisterPlanId[]) => void;
  onToggle: (which: RegisterPlanId) => void;
  /** horizontal = 首页胶囊；vertical = 配置页列表 */
  layout?: 'horizontal' | 'vertical';
  className?: string;
};

/**
 * 注册方案 A/B/C：点击开关 + 拖拽改执行顺序。
 * 首页左右拖、配置上下拖；同一 order 字段双向同步。
 */
export function RegisterPlanOrderControl({
  order,
  enabled,
  onOrderChange,
  onToggle,
  layout = 'horizontal',
  className
}: Props) {
  const normalized = normalizeRegisterPlanOrder(order);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const dragFromRef = useRef<number | null>(null);

  const setFrom = (i: number | null) => {
    dragFromRef.current = i;
    setDragFrom(i);
  };

  const applyDrop = (to: number) => {
    const from = dragFromRef.current;
    setFrom(null);
    setOver(null);
    if (from == null || from === to) return;
    onOrderChange(moveRegisterPlanOrder(normalized, from, to));
  };

  if (layout === 'vertical') {
    return (
      <div className={cn('space-y-2', className)} role="list" aria-label="注册方案顺序">
        <p className="text-[11px] text-muted-foreground">
          拖动手柄调整执行顺序 · 当前{' '}
          <span className="font-medium text-foreground">
            {normalized
              .filter((p) => enabled[p])
              .join(' > ') || '—'}
          </span>
        </p>
        {normalized.map((id, index) => {
          const on = enabled[id];
          const meta = PLAN_META[id];
          const isOver = over === index && dragFrom !== null && dragFrom !== index;
          return (
            <div
              key={id}
              role="listitem"
              draggable
              onDragStart={(e) => {
                setFrom(index);
                e.dataTransfer.effectAllowed = 'move';
                try {
                  e.dataTransfer.setData('text/plain', id);
                } catch {
                  /* ignore */
                }
              }}
              onDragEnd={() => {
                setFrom(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== index) setOver(index);
              }}
              onDragLeave={() => {
                if (over === index) setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                applyDrop(index);
              }}
              className={cn(
                'flex items-center gap-2 rounded-xl border bg-muted/50 px-2.5 py-2 transition-colors',
                isOver ? 'border-primary/50 bg-primary/5' : 'border-border/60',
                dragFrom === index && 'opacity-60'
              )}
            >
              <button
                type="button"
                className="inline-flex h-9 w-8 shrink-0 cursor-grab items-center justify-center rounded-lg text-muted-foreground active:cursor-grabbing"
                title="拖动调整顺序"
                aria-label={`拖动 ${id} 调整顺序`}
                onClick={(e) => e.preventDefault()}
              >
                <GripVertical className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-foreground">{meta.title}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{meta.hint}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                title={`${meta.short} · ${on ? '开' : '关'} · 点击切换`}
                onClick={() => onToggle(id)}
                className={cn(
                  'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors',
                  on
                    ? 'border-primary/40 bg-primary'
                    : 'border-border bg-muted'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                    on ? 'translate-x-6' : 'translate-x-1'
                  )}
                />
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  // horizontal pills (home)
  return (
    <div className={cn('space-y-2', className)}>
      <div
        className="inline-flex w-full max-w-[240px] items-center gap-1 rounded-[12px] border border-border/70 bg-muted/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        role="group"
        aria-label="注册方案 A B C 可多选可拖动排序"
        title="点击开关 · 左右拖动调整执行顺序"
      >
        {normalized.map((id, index) => {
          const on = enabled[id];
          const meta = PLAN_META[id];
          const isOver = over === index && dragFrom !== null && dragFrom !== index;
          return (
            <button
              key={id}
              type="button"
              draggable
              aria-pressed={on}
              title={`${meta.short} · ${meta.hint}${on ? '（开）' : '（关）'} · 拖动改顺序`}
              onClick={() => onToggle(id)}
              onDragStart={(e) => {
                setFrom(index);
                e.dataTransfer.effectAllowed = 'move';
                try {
                  e.dataTransfer.setData('text/plain', id);
                } catch {
                  /* ignore */
                }
              }}
              onDragEnd={() => {
                setFrom(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== index) setOver(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                applyDrop(index);
              }}
              className={cn(
                'inline-flex h-9 min-w-0 flex-1 cursor-grab items-center justify-center rounded-[10px] px-2.5 text-[13px] font-semibold tracking-[-0.02em] transition-all duration-150 active:cursor-grabbing active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35',
                on
                  ? 'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] hover:bg-primary/92'
                  : 'bg-transparent text-muted-foreground hover:bg-card/70 hover:text-foreground',
                isOver && 'ring-2 ring-primary/40',
                dragFrom === index && 'opacity-55'
              )}
            >
              {meta.short}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        顺序{' '}
        <span className="font-medium text-foreground/80">
          {normalized.join(' > ')}
        </span>
        {' · '}
        启用{' '}
        {normalized.filter((p) => enabled[p]).join(' > ') || '—'}
        {' · '}
        拖动改序 · 至少开一个
      </p>
    </div>
  );
}

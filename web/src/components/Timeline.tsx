import * as React from 'react';
import { motion } from 'motion/react';
import { Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TimelineItem {
  id: string;
  title: string;
  /** Pre-formatted time or "Today 10:42". */
  at?: string;
  note?: React.ReactNode;
  state?: 'done' | 'current' | 'upcoming';
}

/** Vertical timeline for work-request history and stage progress. Items fade in with a short stagger. */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn('relative grid gap-0', className)}>
      {items.map((it, i) => {
        const state = it.state ?? 'done';
        return (
          <motion.li
            key={it.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.03, ease: 'easeOut' }}
            className="relative flex gap-3 pb-5 last:pb-0"
            aria-current={state === 'current' ? 'step' : undefined}
          >
            {i < items.length - 1 && <span className="absolute start-[13px] top-7 bottom-0 w-0.5 bg-border" aria-hidden />}
            <span
              className={cn(
                'z-[1] mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border-2',
                state === 'done' && 'border-success bg-success text-background',
                state === 'current' && 'border-primary bg-card text-primary',
                state === 'upcoming' && 'border-input bg-card text-muted-foreground',
              )}
            >
              {state === 'done' ? <Check className="size-4" aria-hidden /> : <Circle className="size-2.5 fill-current" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn('font-medium leading-tight', state === 'upcoming' && 'text-muted-foreground')}>
                {it.title}
                <span className="sr-only"> ({state === 'done' ? 'done' : state === 'current' ? 'current step' : 'upcoming'})</span>
              </p>
              {it.at && <p className="text-xs text-muted-foreground">{it.at}</p>}
              {it.note && <div className="mt-1 text-sm text-muted-foreground">{it.note}</div>}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

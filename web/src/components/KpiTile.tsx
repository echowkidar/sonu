import * as React from 'react';
import { animate, useReducedMotion } from 'motion/react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

function useCountUp(target: number, duration = 0.4) {
  const reduce = useReducedMotion();
  const [v, setV] = React.useState(reduce ? target : 0);
  React.useEffect(() => {
    if (reduce) { setV(target); return; }
    const c = animate(0, target, { duration, ease: 'easeOut', onUpdate: (x) => setV(Math.round(x)) });
    return () => c.stop();
  }, [target, duration, reduce]);
  return v;
}

/** Number first, label second. Counts up on mount. `delta` is the change since yesterday. */
export function KpiTile({
  label, value, delta, tone = 'neutral', onClick, className,
}: { label: string; value: number; delta?: number; tone?: 'neutral' | 'warning' | 'danger' | 'success'; onClick?: () => void; className?: string }) {
  const shown = useCountUp(value);
  const Dir = !delta ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Card className={cn('overflow-hidden', className)}>
      <Wrapper
        {...(onClick ? { type: 'button' as const, onClick } : {})}
        className={cn('flex w-full min-h-24 flex-col items-start gap-1 p-4 text-start', onClick && 'hover:bg-muted/50')}
      >
        <span
          data-testid="kpi-value"
          className={cn('text-3xl font-bold tabular-nums leading-none', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning', tone === 'success' && 'text-success')}
        >
          {shown.toLocaleString()}
        </span>
        <span className="text-sm text-muted-foreground">{label}</span>
        {delta !== undefined && (
          <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Dir className="size-3.5" aria-hidden />
            {delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta} since yesterday`}
          </span>
        )}
      </Wrapper>
    </Card>
  );
}

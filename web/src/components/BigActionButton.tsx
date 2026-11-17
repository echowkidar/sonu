import * as React from 'react';
import { Play, PencilLine, CheckCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type BigAction = 'start' | 'update' | 'done';

const CFG: Record<BigAction, { label: string; Icon: typeof Play; variant: 'default' | 'secondary' | 'success' }> = {
  start: { label: 'Start', Icon: Play, variant: 'default' },
  update: { label: 'Update', Icon: PencilLine, variant: 'secondary' },
  done: { label: 'Done', Icon: CheckCheck, variant: 'success' },
};

/** One-thumb primary action: full width, 56 px tall, large type. */
export function BigActionButton({
  action, loading, className, children, ...props
}: { action: BigAction; loading?: boolean } & Omit<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  const { label, Icon, variant } = CFG[action];
  return (
    <Button variant={variant} size="lg" className={cn('h-14 w-full text-lg', className)} disabled={loading || props.disabled} {...props}>
      {loading ? <Loader2 className="size-6 animate-spin" aria-hidden /> : <Icon className="size-6" aria-hidden />}
      {children ?? label}
    </Button>
  );
}

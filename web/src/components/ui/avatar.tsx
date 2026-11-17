import * as React from 'react';
import { Avatar as A } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Avatar({ className, ...props }: React.ComponentProps<typeof A.Root>) {
  return <A.Root className={cn('relative flex size-9 shrink-0 overflow-hidden rounded-full', className)} {...props} />;
}
export function AvatarImage({ className, ...props }: React.ComponentProps<typeof A.Image>) {
  return <A.Image className={cn('aspect-square size-full', className)} {...props} />;
}
export function AvatarFallback({ className, ...props }: React.ComponentProps<typeof A.Fallback>) {
  return <A.Fallback className={cn('flex size-full items-center justify-center bg-primary-soft text-sm font-semibold text-accent-foreground', className)} {...props} />;
}

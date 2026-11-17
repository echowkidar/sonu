import * as React from 'react';
import { Checkbox as C } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Checkbox({ className, ...props }: React.ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        'peer inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-input bg-card shadow-sm data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <C.Indicator><Check className="size-4" /></C.Indicator>
    </C.Root>
  );
}

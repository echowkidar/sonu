import * as React from 'react';
import { Switch as SW } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: React.ComponentProps<typeof SW.Root>) {
  return (
    <SW.Root
      className={cn('peer inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-transparent bg-input shadow-sm transition-colors data-[state=checked]:bg-primary disabled:opacity-50', className)}
      {...props}
    >
      <SW.Thumb className="pointer-events-none block size-6 rounded-full bg-white shadow transition-transform duration-150 data-[state=checked]:translate-x-5 rtl:data-[state=checked]:-translate-x-5" />
    </SW.Root>
  );
}

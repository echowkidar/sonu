import * as React from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { DialogOverlay } from './dialog';

export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
export const SheetClose = D.Close;
export const SheetTitle = D.Title;
export const SheetDescription = D.Description;

/**
 * side="bottom": phone bottom sheet (rounded top, grab handle, safe-area padding).
 * side="end": side panel (detail panel on desktop).
 * side="responsive": bottom sheet on phones, side panel from md up.
 */
const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-3 bg-card p-5 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out',
  {
    variants: {
      side: {
        bottom: 'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-2xl border-t safe-bottom data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
        end: 'inset-y-0 end-0 h-full w-[min(26rem,100%)] border-s data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right rtl:data-[state=open]:slide-in-from-left rtl:data-[state=closed]:slide-out-to-left',
        responsive:
          'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-2xl border-t safe-bottom data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom md:inset-x-auto md:inset-y-0 md:end-0 md:h-full md:max-h-none md:w-[26rem] md:rounded-none md:border-s md:border-t-0',
      },
    },
    defaultVariants: { side: 'bottom' },
  },
);

export function SheetContent({
  side,
  className,
  children,
  ...props
}: React.ComponentProps<typeof D.Content> & VariantProps<typeof sheetVariants>) {
  return (
    <D.Portal>
      <DialogOverlay />
      <D.Content className={cn(sheetVariants({ side }), className)} {...props}>
        {(side ?? 'bottom') !== 'end' && <div className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-input md:hidden" aria-hidden />}
        {children}
        <D.Close className="tap absolute end-2 top-2 inline-flex items-center justify-center rounded-md opacity-70 hover:opacity-100" aria-label="Close">
          <X className="size-5" />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}

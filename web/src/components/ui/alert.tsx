import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva('relative flex w-full items-start gap-3 rounded-lg border p-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0', {
  variants: {
    variant: {
      default: 'bg-card',
      info: 'border-info/30 bg-info-soft text-info',
      success: 'border-success/30 bg-success-soft text-success',
      warning: 'border-warning/30 bg-warning-soft text-warning',
      danger: 'border-danger/30 bg-danger-soft text-danger',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
export function AlertTitle({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('font-semibold leading-tight', className)} {...props} />;
}
export function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('opacity-90', className)} {...props} />;
}

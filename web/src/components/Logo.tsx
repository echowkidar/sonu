import { cn } from '@/lib/utils';

/** SONU mark (public/logo-mark.svg, three folded ribbons). Wordmark hidden when `mark` only. */
export function Logo({ mark = false, className }: { mark?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)} aria-label="SONU" role="img">
      <img src="/logo-mark.svg" alt="" className="size-9 shrink-0" aria-hidden />
      {!mark && <span className="text-xl font-bold tracking-[0.18em]">SONU</span>}
    </span>
  );
}

import { cn } from '@/lib/utils';

/** SONU mark (inline so it follows theme tokens). Wordmark hidden when `mark` only. */
export function Logo({ mark = false, className }: { mark?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)} aria-label="SONU" role="img">
      <svg viewBox="0 0 64 64" className="size-9 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="16" className="fill-primary" />
        <path d="M42 21.5c-2.4-3-6-4.5-10.2-4.5-6 0-10 3.2-10 8 0 11 21 6.6 21 15.5 0 4.4-4.2 7.5-10.6 7.5-4.6 0-8.6-1.7-11.2-5" fill="none" className="stroke-primary-foreground" strokeWidth="6" strokeLinecap="round" />
        <circle cx="46" cy="17" r="3.5" fill="#ffc857" />
      </svg>
      {!mark && <span className="text-xl font-bold tracking-[0.18em]">SONU</span>}
    </span>
  );
}

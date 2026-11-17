import * as React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export type Illustration = 'inbox' | 'done' | 'search' | 'build';

const draw = { hidden: { pathLength: 0, opacity: 0 }, visible: { pathLength: 1, opacity: 1 } };

/** Small original illustration; draws in once (200 ms), nothing loops. motion honours prefers-reduced-motion via MotionConfig. */
function Art({ kind }: { kind: Illustration }) {
  const t = { duration: 0.2, ease: 'easeOut' as const };
  return (
    <svg viewBox="0 0 120 96" className="h-24 w-30" aria-hidden fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="60" cy="86" rx="38" ry="5" className="fill-muted" stroke="none" />
      {kind === 'inbox' && (
        <>
          <motion.path variants={draw} initial="hidden" animate="visible" transition={t} d="M22 52l12-26h52l12 26v22a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6V52z" className="stroke-primary" />
          <motion.path variants={draw} initial="hidden" animate="visible" transition={{ ...t, delay: 0.1 }} d="M22 52h26a12 12 0 0 0 24 0h26" className="stroke-primary" />
        </>
      )}
      {kind === 'done' && (
        <>
          <motion.circle variants={draw} initial="hidden" animate="visible" transition={t} cx="60" cy="46" r="30" className="stroke-success" />
          <motion.path variants={draw} initial="hidden" animate="visible" transition={{ ...t, delay: 0.12 }} d="M46 47l10 10 20-22" className="stroke-success" />
        </>
      )}
      {kind === 'search' && (
        <>
          <motion.circle variants={draw} initial="hidden" animate="visible" transition={t} cx="54" cy="42" r="22" className="stroke-primary" />
          <motion.path variants={draw} initial="hidden" animate="visible" transition={{ ...t, delay: 0.1 }} d="M71 59l20 20" className="stroke-primary" />
        </>
      )}
      {kind === 'build' && (
        <>
          <motion.path variants={draw} initial="hidden" animate="visible" transition={t} d="M26 78V34l34-16 34 16v44z" className="stroke-primary" />
          <motion.path variants={draw} initial="hidden" animate="visible" transition={{ ...t, delay: 0.1 }} d="M46 78V56h28v22M60 40v0" className="stroke-primary" />
        </>
      )}
    </svg>
  );
}

export function EmptyState({
  title, description, action, illustration = 'inbox', className,
}: { title: string; description?: string; action?: React.ReactNode; illustration?: Illustration; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-4 py-12 text-center', className)}>
      <Art kind={illustration} />
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

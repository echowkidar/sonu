import { CheckCircle2, AlertTriangle, AlarmClock } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DayState = 'ok' | 'warn' | 'late';

/**
 * ok: more than `warnWithin` days left. warn: 1..warnWithin days left. late: due today or overdue.
 * Rules are configurable on the server; pass the numbers in.
 */
export function dayState(day: number, of = 14, warnWithin = 4): DayState {
  const remaining = of - day;
  if (remaining <= 0) return 'late';
  if (remaining <= warnWithin) return 'warn';
  return 'ok';
}

export function dayLabel(day: number, of = 14): string {
  const base = `Day ${day} of ${of}`;
  const remaining = of - day;
  if (remaining < 0) return `${base} · overdue by ${-remaining}`;
  if (remaining === 0) return `${base} · due today`;
  return base;
}

const STYLE: Record<DayState, { cls: string; Icon: typeof CheckCircle2; word: string }> = {
  ok: { cls: 'bg-success-soft text-success', Icon: CheckCircle2, word: 'On track' },
  warn: { cls: 'bg-warning-soft text-warning', Icon: AlertTriangle, word: 'Due soon' },
  late: { cls: 'bg-danger-soft text-danger', Icon: AlarmClock, word: 'Late' },
};

export function DayCounter({ day, of = 14, warnWithin = 4, className }: { day: number; of?: number; warnWithin?: number; className?: string }) {
  const state = dayState(day, of, warnWithin);
  const { cls, Icon, word } = STYLE[state];
  return (
    <span data-state={state} className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold', cls, className)}>
      <Icon className="size-4" aria-hidden />
      <span>{dayLabel(day, of)}</span>
      <span className="sr-only"> — {word}</span>
    </span>
  );
}

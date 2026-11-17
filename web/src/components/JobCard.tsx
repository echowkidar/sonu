import * as React from 'react';
import { MapPin } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { DayCounter } from './DayCounter';
import { StatusBadge, type Tone } from './StatusBadge';
import { BigActionButton, type BigAction } from './BigActionButton';
import { cn } from '@/lib/utils';

export interface JobCardProps {
  code: string;
  title: string;
  location?: string;
  status: { label: string; tone?: Tone };
  permit?: string;
  day?: number;
  dayOf?: number;
  action: BigAction;
  onAction?: () => void;
  onOpen?: () => void;
  className?: string;
  children?: React.ReactNode;
}

/** Phone job card: code and place on top, status + day counter, one big thumb button at the bottom. */
export function JobCard({ code, title, location, status, permit, day, dayOf, action, onAction, onOpen, className, children }: JobCardProps) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div
        role={onOpen ? 'button' : undefined}
        tabIndex={onOpen ? 0 : undefined}
        onClick={onOpen}
        onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
        className="grid gap-2 p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-sm font-semibold text-muted-foreground">{code}</span>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </div>
        <h3 className="text-lg font-semibold leading-snug">{title}</h3>
        {location && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="size-4 shrink-0" aria-hidden />{location}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {day !== undefined && <DayCounter day={day} of={dayOf} />}
          {permit && <StatusBadge tone="info">Permit: {permit}</StatusBadge>}
        </div>
        {children}
      </div>
      <div className="p-4 pt-0">
        <BigActionButton action={action} onClick={onAction} />
      </div>
    </Card>
  );
}

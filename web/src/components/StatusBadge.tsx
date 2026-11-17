import { CheckCircle2, CircleDot, AlertTriangle, XCircle, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const ICONS = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info, neutral: CircleDot } as const;

/** Colour is never the only signal: every badge carries an icon and its text label. */
export function StatusBadge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  const Icon = ICONS[tone];
  return (
    <Badge variant={tone} data-tone={tone}>
      <Icon className="size-3.5" aria-hidden />
      {children}
    </Badge>
  );
}

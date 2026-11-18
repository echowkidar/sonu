import { StatusBadge } from '@/components/StatusBadge';
import { PC_STATUS } from '@/lib/pettyCash';
import type { PettyCashStatus } from '@/lib/types';

export function PettyCashStatusBadge({ status }: { status: PettyCashStatus }) {
  const s = PC_STATUS[status];
  return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}

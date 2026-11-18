import { StatusBadge } from '@/components/StatusBadge';
import { MR_STATUS } from '@/lib/mr';
import type { MrStatus } from '@/lib/types';

export function MrStatusBadge({ status }: { status: MrStatus }) {
  const s = MR_STATUS[status];
  return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}

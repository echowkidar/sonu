import { WifiOff } from 'lucide-react';
import { useOnline } from '@/lib/hooks';

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-warning-soft px-4 py-2 text-sm font-medium text-warning">
      <WifiOff className="size-4" aria-hidden />
      You are offline. Data shown may be out of date and changes cannot be saved yet.
    </div>
  );
}

import { Toaster as Sonner, toast } from 'sonner';

export function Toaster({ theme }: { theme?: 'light' | 'dark' }) {
  return (
    <Sonner
      theme={theme ?? 'system'}
      position="top-center"
      toastOptions={{ classNames: { toast: 'bg-popover text-popover-foreground border-border shadow-md rounded-lg' } }}
    />
  );
}
export { toast };

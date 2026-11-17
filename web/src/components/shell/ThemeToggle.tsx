import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ThemeToggle({ onToggle }: { onToggle: () => void }) {
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle light / dark theme" onClick={onToggle}>
      <Sun className="size-5 dark:hidden" aria-hidden />
      <Moon className="hidden size-5 dark:block" aria-hidden />
    </Button>
  );
}

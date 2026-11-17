import * as React from 'react';
import { useTheme } from '@/lib/theme';

type Ctx = ReturnType<typeof useTheme>;
const ThemeCtx = React.createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <ThemeCtx.Provider value={t}>{children}</ThemeCtx.Provider>;
}

export function useThemeContext(): Ctx {
  const c = React.useContext(ThemeCtx);
  if (!c) throw new Error('ThemeProvider missing');
  return c;
}

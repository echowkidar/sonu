import * as React from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Direction = 'ltr' | 'rtl';

const safeGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f1320' : '#3b4cca');
}

export function applyDirection(dir: Direction) {
  document.documentElement.dir = dir;
  document.documentElement.lang = dir === 'rtl' ? 'ar' : 'en';
}

export function useTheme() {
  const [mode, setMode] = React.useState<ThemeMode>(() => (safeGet('sonu.theme') as ThemeMode) || 'system');
  const [dir, setDir] = React.useState<Direction>(() => (safeGet('sonu.dir') as Direction) || 'ltr');

  React.useEffect(() => {
    applyTheme(mode);
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [mode]);
  React.useEffect(() => applyDirection(dir), [dir]);

  return {
    mode,
    dir,
    setMode: (m: ThemeMode) => { safeSet('sonu.theme', m); setMode(m); },
    setDir: (d: Direction) => { safeSet('sonu.dir', d); setDir(d); },
    toggle: () => {
      const isDark = document.documentElement.classList.contains('dark');
      const next: ThemeMode = isDark ? 'light' : 'dark';
      safeSet('sonu.theme', next);
      setMode(next);
    },
  };
}

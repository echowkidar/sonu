import * as React from 'react';

export function useOnline(): boolean {
  const [online, setOnline] = React.useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  React.useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

export function usePrefersReducedMotion(): boolean {
  const [r, setR] = React.useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const h = () => setR(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return r;
}

/** True on weak or data-saving devices: 3D and heavy motion are skipped. */
export function isLowEndDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return true;
  if (nav.connection?.saveData) return true;
  return false;
}

export function useIsDesktop(): boolean {
  const q = '(min-width: 768px)';
  const [m, setM] = React.useState(() => window.matchMedia?.(q).matches ?? false);
  React.useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}

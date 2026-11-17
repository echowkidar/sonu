import * as React from 'react';
import { isLowEndDevice, usePrefersReducedMotion } from '@/lib/hooks';

const CampusScene = React.lazy(() => import('./CampusScene'));

async function batterySaver(): Promise<boolean> {
  try {
    const b = await (navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> }).getBattery?.();
    return !!b && !b.charging && b.level < 0.2;
  } catch {
    return false;
  }
}

/**
 * Calm 3D backdrop. Never blocks the page:
 * - mounts only after first paint (idle callback), and the three.js chunk is fetched only then
 * - skipped entirely on reduce-motion, < 4 GB device memory, save-data, low battery
 * - render loop paused when off-screen or the tab is hidden
 * - the CSS gradient (.login-fallback) is always underneath as the static fallback
 */
export function SceneBackdrop() {
  const reduce = usePrefersReducedMotion();
  const [ready, setReady] = React.useState(false);
  const [visible, setVisible] = React.useState(true);
  const [tabVisible, setTabVisible] = React.useState(true);
  const host = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (reduce || isLowEndDevice()) return;
    let cancelled = false;
    const start = () => { void batterySaver().then((low) => { if (!cancelled && !low) setReady(true); }); };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const id = ric ? ric(start, { timeout: 2000 }) : window.setTimeout(start, 800);
    return () => { cancelled = true; if (!ric) clearTimeout(id); };
  }, [reduce]);

  React.useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting));
    io.observe(el);
    const vis = () => setTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', vis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  }, []);

  return (
    <div ref={host} className="login-fallback pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      {ready && (
        <React.Suspense fallback={null}>
          {/* Phones: scene only in the top band, above the sign-in card (which sits lower). */}
          <div className="absolute inset-x-0 top-0 h-[42dvh] animate-in fade-in duration-700 sm:inset-0 sm:h-auto">
            <CampusScene active={visible && tabVisible} />
          </div>
        </React.Suspense>
      )}
    </div>
  );
}

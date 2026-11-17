/**
 * SONU service worker (vite-plugin-pwa, injectManifest).
 * - Precaches the app shell only.
 * - /api is NEVER cached: data must never be stale silently. We register no route for it, so the
 *   browser goes to the network and an offline failure surfaces as an error (the UI shows the offline banner).
 * - push -> notification from { title, body, url, tag }; click -> focus an open tab or open the url.
 *
 * Types are declared locally so the file compiles under the DOM lib used by the rest of the app.
 */
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

interface PushPayload { title?: string; body?: string; url?: string; tag?: string }
interface SWExtendableEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface SWPushEvent extends SWExtendableEvent { data: { json(): PushPayload; text(): string } | null }
interface SWNotificationEvent extends SWExtendableEvent { notification: Notification }
interface SWClient { url: string; focus(): Promise<unknown>; navigate?(url: string): Promise<unknown> }
interface SWScope {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
  registration: { showNotification(title: string, o?: NotificationOptions): Promise<void> };
  clients: { matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<SWClient[]>; openWindow(url: string): Promise<unknown>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  location: { origin: string };
  addEventListener(type: string, l: (e: never) => void): void;
}
declare const self: SWScope;
const sw = self;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA fallback for navigations, but never for API calls.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/internal\//] }));

sw.addEventListener('install', () => { void sw.skipWaiting(); });
sw.addEventListener('activate', ((e: SWExtendableEvent) => { e.waitUntil(sw.clients.claim()); }) as (e: never) => void);

sw.addEventListener('push', ((event: SWPushEvent) => {
  let p: PushPayload = {};
  try { p = event.data?.json() ?? {}; } catch { p = { body: event.data?.text() }; }
  const title = p.title ?? 'SONU';
  event.waitUntil(
    sw.registration.showNotification(title, {
      body: p.body,
      tag: p.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: p.url ?? '/notifications' },
    }),
  );
}) as (e: never) => void);

sw.addEventListener('notificationclick', ((event: SWNotificationEvent) => {
  event.notification.close();
  const raw = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  const target = new URL(raw, sw.location.origin);
  // Only ever open our own origin.
  const url = target.origin === sw.location.origin ? target.href : sw.location.origin + '/';
  event.waitUntil(
    (async () => {
      const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = all[0];
      if (existing) {
        if (existing.navigate) await existing.navigate(url);
        await existing.focus();
      } else {
        await sw.clients.openWindow(url);
      }
    })(),
  );
}) as (e: never) => void);

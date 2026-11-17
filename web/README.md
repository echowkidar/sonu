# @sonu/web

Vite + React 19 + TypeScript (strict) + Tailwind 4 + shadcn/ui (copied into `src/components/ui`). Built output (`dist/`) is served by `@sonu/server`.

```
npm install
npm run dev      # http://localhost:5173, proxies /api -> http://localhost:3000, /dev/kit shows every component
npm run build    # tsc + vite build + service worker (dist/sw.mjs)
npm test         # vitest
npm run icons    # regenerate PWA icons from the SONU mark (needs sharp)
```

## Where things are

| Need | File |
|---|---|
| Add a screen | `src/nav.ts` (menu + role access), `src/App.tsx` (lazy route), page in `src/pages/` (replace the placeholder body, keep the default export) |
| Call the API | `src/lib/api.ts` (`apiGet/apiPost/apiUpload`, `ApiError`), paths in `src/lib/endpoints.ts` |
| Session shape | `src/lib/session.ts` (only file that knows `GET /api/auth/me`) |
| Top bar slots ("data as of", unread count) | `src/components/shell/slots.ts` (stubs, replace with queries) |
| Design tokens | `src/index.css` (CSS variables, light + dark, `.light`/`.dark` scopes) |
| Phone primitives | `JobCard`, `BigActionButton`, `PhotoPicker`, `DayCounter`, `StatusBadge`, `Timeline`, `FileDrop`, `EmptyState`, `ConfirmDialog`, `PageHeader` in `src/components` |
| Tables / charts | `DataTable` (virtual rows), `BarStack`, `KpiTile` |
| PWA / push | `src/sw.ts`, `src/lib/push.ts` |
| 3D sign-in scene | `src/scene/` (lazy chunk `scene-*.js`, only loaded after first paint on capable devices) |

Rules: logical CSS only (`ms/me/ps/pe/start/end`) so RTL works; status is always colour + text; touch targets 44 px; motion 150-250 ms and honours reduced motion; `/api` responses are never cached by the service worker.

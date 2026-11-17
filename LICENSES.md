# Third-party licences

Direct dependencies of the four packages, with the licence read from each installed package. Only free/open licences are used.

## Needs attention

| Item | Licence | Note |
|---|---|---|
| `web-push` (server) | MPL-2.0 | Weak, file-level copyleft. Used unmodified as a library; keep its notice, publish any change to its own files. |
| `playwright` (worker) | Apache-2.0 | Permissive. Browser binaries come from the official Playwright Docker image. |
| SheetJS `xlsx` 0.20.3 (core) | Apache-2.0 | Vendored as `packages/core/vendor/xlsx-0.20.3.tgz`. Keep the tarball in the repo. |
| `baileys` with `libsignal` (server, optional) | GPL-3.0 | **Not installed by default.** Only for the optional WhatsApp "linked session" mode. Installing and shipping it brings GPL-3.0 obligations; the owner decides. |
| `lucide-react` (web) | ISC | Permissive. Icons come from this package only. |

## packages/core

Runtime: exceljs MIT, xlsx (SheetJS, vendored) Apache-2.0.
Dev: @types/node MIT, tsx MIT, typescript Apache-2.0, vitest MIT.

## server

Runtime: @fastify/cookie MIT, @fastify/multipart MIT, @fastify/static MIT, @sonu/core (own code), exceljs MIT, fastify MIT, fastify-plugin MIT, nodemailer MIT-0, pg MIT, proxy-addr MIT, qrcode MIT, web-push MPL-2.0, zod MIT.
Dev: @types/node MIT, @types/nodemailer MIT, @types/pg MIT, @types/proxy-addr MIT, @types/qrcode MIT, @types/web-push MIT, embedded-postgres MIT, tsx MIT, typescript Apache-2.0, vitest MIT.
Optional, not installed: baileys (MIT) with libsignal (GPL-3.0).

## web

Runtime: @react-three/fiber MIT, @tanstack/react-query MIT, @tanstack/react-table MIT, @tanstack/react-virtual MIT, class-variance-authority Apache-2.0, clsx MIT, lucide-react ISC, motion MIT, radix-ui MIT, react MIT, react-dom MIT, react-router MIT, recharts MIT, sonner MIT, tailwind-merge MIT, three MIT, tw-animate-css MIT, workbox-window MIT, zod MIT.
Dev: @tailwindcss/vite MIT, @testing-library/jest-dom MIT, @testing-library/react MIT, @testing-library/user-event MIT, @types/node MIT, @types/react MIT, @types/react-dom MIT, @types/three MIT, @vitejs/plugin-react MIT, jsdom MIT, sharp Apache-2.0, tailwindcss MIT, typescript Apache-2.0, vite MIT, vite-plugin-pwa MIT, vitest MIT, workbox-build MIT, workbox-core MIT, workbox-precaching MIT, workbox-routing MIT.

## worker

Runtime: playwright Apache-2.0, zod MIT.
Dev: @types/node MIT, exceljs MIT, tsx MIT, typescript Apache-2.0, vitest MIT.
Container base image: `mcr.microsoft.com/playwright` (Ubuntu and Chromium components carry their own licences).

## Fonts, icons, templates

- Icons: lucide (ISC). No third-party web fonts are used (none found in `web/`); record any added font here.
- `assets/` templates (RFE template, tracker lookups, bulk-import templates) are SONU's own run-time files.
- Transitive dependencies are not listed; run a licence checker per package before a release if a full audit is needed.

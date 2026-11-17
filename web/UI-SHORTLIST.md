# UI template shortlist (design 15, section 3)

The current build uses plain shadcn/ui with SONU's own tokens. Nothing below is copied in yet. The owner picks; we then adapt (SONU colours, logo, wording, remove the unused). Free and open licences only. Screenshots: open each link, or run `npm run dev` and compare with `/dev/kit`.

## Web (desktop dashboards on shadcn + Tailwind)

| Name | URL | Licence | Why |
|---|---|---|---|
| shadcn-admin (satnaing) | https://github.com/satnaing/shadcn-admin | MIT (to be re-checked at copy time) | Vite + React + shadcn admin shell with sidebar, tables, command palette, light/dark; closest to our stack. |
| shadcn/ui dashboard blocks (dashboard-01 and sidebar blocks) | https://ui.shadcn.com/blocks | MIT | Official building blocks: sidebar, KPI cards, chart and data-table patterns we can lift one by one. |
| next-shadcn-dashboard-starter (Kiranism) | https://github.com/Kiranism/next-shadcn-dashboard-starter | MIT (licence to be verified) | Rich dashboard/table/kanban layouts as design reference; Next.js based, so only the components would be ported. |

## Phone (mobile-first patterns)

Few phone kits are built on shadcn; these three are the ones we are confident exist and are free.

| Name | URL | Licence | Why |
|---|---|---|---|
| Vaul + shadcn Drawer | https://github.com/emilkowalski/vaul | MIT | The bottom-sheet and swipe-down behaviour of native apps; fits shadcn and our `Sheet`. |
| Konsta UI | https://konstaui.com | MIT | Tailwind-based React components with iOS/Material look (tab bar, list cells, large buttons), for reference or selective use. |
| Ionic Framework (React) | https://ionicframework.com | MIT | Mature mobile patterns (tabs, pull-to-refresh, swipe list items); reference for gestures, not a drop-in with shadcn. |

Status: undecided. Until the owner chooses, all screens use the shadcn/ui components in `src/components/ui`.

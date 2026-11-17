# Build status — step 1 and 1b (2026-11-17)

## Verified

| What | How |
|---|---|
| Parsers for all 11 lists, renamed / missing caption fails naming the caption and loads nothing, `.xls`, title rows | `packages/core` tests (113) on synthetic fixtures with the exact captions |
| Computed columns = the tracker formulas (Month, Days to Breach, TD Status, KPI, RFE status, RFE time frame with 14 days, days since assigned) | core tests at every boundary; formulas taken from the contractor's workbook |
| Deadline rules (calendar and working days), mirror diff → events, Master workbook round trip, RFE file `rfe-<WR>.xlsx` | core tests |
| Accounts, invitations, roles, tenant separation, audit, bulk-import preview / confirm (EXAMPLE rows skipped, password columns refused) | server tests (75) on a real PostgreSQL |
| Import → dashboard: status × discipline, × zone, × facility and total equal a hand count of the sample | server test + `scripts/e2e-smoke.mjs` against a running server (18 steps pass) |
| Re-import of a changed file raises exactly the expected events; owner / criterion / status / remarks untouched | server test + smoke script |
| Stored passwords never returned (mail, Marafiq, WhatsApp session); worker token, tunnel headers refused on `/internal` | server tests |
| Worker: allow-list, only Show / XLS / paging pressed, at most 2 sign-ins then stop, traps never touched | worker tests (50) against the local mock portal only |
| WhatsApp toggle: click-to-chat default, linked session needs risk acknowledgement, rate limit, consent, fallback | server tests with a fake socket |
| Supervisor takes ownership and assigns; technician starts and finishes on a 375 px screen; notifications created | in a browser at phone size on the dev server |
| Web builds, PWA manifest and service worker are served | web tests (33) and build |

## Not verified yet

| What | Why / what is needed |
|---|---|
| `docker compose up` from a clean checkout | Docker Desktop's engine was not running on this computer. The Dockerfiles were reviewed by reading and the same build steps pass without Docker. |
| Web push arriving on a phone | Needs the installed app over HTTPS (Cloudflare Tunnel) on a real phone. The in-app browser used for testing does not register service workers. Server side is tested with a mocked push service. |
| Parsers against real Marafiq exports | Only synthetic files were used. Needed: one real export of each list (kept out of the repository). |
| RFE file accepted by Marafiq | Needs one RFE Excel that Marafiq accepted: Line Type as label or code, WR No as number or text, Mark Up handling. |
| Marafiq connection against the real portal | Never run by design. The admin follows the checklist in `worker/README.md`. The XLS export rule name is unverified; if it differs, the guard blocks it and the result names it. Lists that call the portal's generic SQL rule on load will fail and are reported, not worked around. `wr_dashboard` and `rfe_post_box` will probably need manual upload. |
| WhatsApp linked session | The `baileys` library is not installed because it depends on GPL-3.0 `libsignal`; the owner decides. |
| Template choice and design approval (design 15) | `web/UI-SHORTLIST.md` lists options for the owner; the build uses plain shadcn/ui until then. RTL and Arabic / Hindi labels are not done. |
| Photo upload from the phone camera in the browser | Tested through the API (smoke script); the camera picker itself was not driven in the browser. |

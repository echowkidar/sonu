# SONU API — notifications, push, WhatsApp, Marafiq connection

All `/api` routes need the session cookie; mutating ones need `X-Requested-With: sonu`. Admin routes: `contractor_admin` (own contractor) or `platform_admin` with `?contractorId=`. Errors: `{ error: { code, message, details? } }`.

## Notifications and web push (any signed-in user)

| Route | Request | Response |
|---|---|---|
| `GET /api/notifications` | `?unread=1&limit=50&offset=0` | `{ items: [{ id, event, title, body, link, url, whatsapp: {url,to}\|null, record, entityType, entityId, workRequestId, createdAt, readAt }], unread, total, limit, offset }` |
| `POST /api/notifications/:id/read` | — | `{ ok }` (404 if not yours) |
| `POST /api/notifications/read-all` | — | `{ ok, marked }` |
| `GET /api/push/public-key` | — | `{ publicKey }` (VAPID, base64url) |
| `POST /api/push/subscribe` | `PushSubscription.toJSON()` = `{ endpoint (https), keys: { p256dh, auth }, expirationTime? }` | `{ ok }` |
| `POST /api/push/unsubscribe` | `{ endpoint }` | `{ ok, removed }` |
| `POST /api/push/test` | — | `{ devices, sent, removed, failed, lastError }` |

Push payload (service worker `push` event, JSON): `{ title, body, url, id, event }`. When `item.whatsapp` is set (click-to-chat mode), show an "Open in WhatsApp" button with `whatsapp.url`.

## WhatsApp

| Route | Request | Response |
|---|---|---|
| `GET /api/whatsapp/link` (any user) | `?to=+97455550199&text=…` | `{ url: "https://wa.me/97455550199?text=…", qrSvg: "<svg…>" }` — 400 for a bad number; 8-digit numbers get 974 |
| `GET /api/admin/messaging` | — | `{ whatsappMode: "click_to_chat"\|"linked_session", pushEnabled, quietHoursStart, quietHoursEnd, rateLimit: { minIntervalSeconds, dailyLimit, hardCaps }, riskWarning, riskAcknowledgedAt, linkedSession: <status>, updatedAt }` |
| `PUT /api/admin/messaging` | any of `{ whatsappMode, acknowledgeRisk, pushEnabled, quietHoursStart, quietHoursEnd ("HH:MM"\|null), rateLimit: { minIntervalSeconds 10–3600, dailyLimit 1–500 } }` | same as GET. Switching to `linked_session` without `acknowledgeRisk: true` → 400 `risk_not_acknowledged`. Show `riskWarning` exactly. |
| `GET /api/admin/whatsapp/status` | — | `<status>` = `{ mode, state: off\|qr_pending\|connecting\|connected\|disconnected\|banned_or_logged_out, available, reason, linkedNumber (masked), lastError, sentToday, dailyLimit, minIntervalSeconds, fallbackToClickToChat }` |
| `POST /api/admin/whatsapp/link/start` | — | `{ state, qrSvg\|null, expiresAt, lastError }` (QR valid ~60 s; poll status, call again for a new QR). 409 if mode is not linked_session; 503 `unavailable` + reason if the library is not installed |
| `POST /api/admin/whatsapp/disconnect` | — | `<status>` (logged out, stored session wiped) |

Contractor quiet hours apply only to automatic sends through a linked number; each user's own quiet hours (profile) defer their e-mail / push / WhatsApp. Linked session: only to users with WhatsApp on (or sub-contractor contacts with consent), 1 message per 20 s and 200 per day by default; not connected → links instead.

## Marafiq connection (admin)

| Route | Request | Response |
|---|---|---|
| `GET /api/admin/marafiq-connection` | — | `{ id, baseUrl, project, username, hasPassword, mode: off\|read_only, paused, state: idle\|running\|ok\|error\|needs_attention, schedule, enabledLists, availableLists, lastSuccess, lastSignInAt, lastError, updatedAt }` |
| `PUT /api/admin/marafiq-connection` | any of `{ baseUrl (https), project, username, password (write-only), clearPassword, mode, schedule, enabledLists }` | same as GET. Saving a password clears `needs_attention`. |
| `POST …/test` | — | 202 `{ ok, jobId }`; 409 `not_ready` (off / paused / needs attention / no password) or `job_open` |
| `POST …/pause` / `POST …/resume` | — | same as GET (resume also clears `needs_attention`) |
| `GET …/health` | — | `{ state, mode, paused, hasPassword, lastSignInAt, lastError, lists: [{ key, lastSuccessAt, lastRows, lastErrorAt, lastError }], recentRuns, recentJobs, worker: { lastPollAt, running, hint } }` |

`schedule` = `{ serviceHours: { start: "07:30", end: "15:30" }, serviceDays: [0..6] (0 = Sunday; default Sun–Thu), lists: { <key>: { inHoursMinutes, outHoursMinutes } } }` (minutes ≥ 15, `null` = not read then). Empty `enabledLists` = all lists.

Internal worker API: as in ARCHITECTURE.md (`/internal/worker/jobs/next`, `…/:id/file`, `…/:id/result`). The file answer is `{ ok, rowsRead, batchId?, error?, errorCode?, missingCaptions? }`; 503 `{ ok:false, error:"imports not available" }` when `app.importRunner` is not decorated (ops module, decorated at root with fastify-plugin).

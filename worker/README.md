# @sonu/worker — read-only Marafiq connection

Optional background worker. It signs in to the Marafiq portal (ARCHIBUS Web Central) with a dedicated
account, opens a fixed set of lists, presses **Show** and **XLS**, and hands each export file to the SONU
server, which imports it through the same path as a manual upload. It never changes anything on the portal.
Design: `../../design/14-admin-panel-and-marafiq-connector.md` section 4; contract: `../docs/ARCHITECTURE.md`
("Internal worker API").

## How it works

1. Every `POLL_SECONDS` (15) it calls `GET /internal/worker/jobs/next` on the SONU server
   (`Authorization: Bearer hex(HMAC-SHA256(ENCRYPTION_KEY bytes, "sonu-worker-v1"))`).
2. For each job it starts a fresh headless Chromium with an honest user agent ending in
   `SONU-connector/<version> (read-only)`, signs in with Project / Username / Password, and keeps that
   session for all lists of the job.
3. `kind: "test"` — signs in, opens the first allow-listed list, checks that the **Show** button is there,
   presses nothing, reports.
   `kind: "sync"` — for each requested list: open view → Show → XLS → upload to
   `POST /internal/worker/jobs/:id/file` → next list. A failing list is reported and the others continue.
   Unknown list keys are ignored and reported.
4. Posts `POST /internal/worker/jobs/:id/result` with `status`, `signInAttempts`, per-list results and a
   message (which also names any request the guard blocked, by address and rule id only).
5. The browser, the temp folder and the password are dropped when the job ends.

| File | Role |
|---|---|
| `src/allowlist.ts` | The **only** place that knows portal addresses: list key → view, login page, permitted button labels, rule-channel policy. Frozen. |
| `src/guard.ts` | Enforcement: request filter, navigation filter, rule-call inspection, `clickAllowed`. |
| `src/session.ts` | Sign-in and the sign-in budget (max 2 per job). |
| `src/portal.ts` | One list: open → Show → XLS → save the download. |
| `src/run.ts`, `src/main.ts` | Job execution, poll loop, graceful shutdown (SIGTERM/SIGINT finish the current list, report the rest as not read). |
| `mock-portal/` | Local imitation of the portal for tests (fictional data and credentials). |

## Safety rules (enforced in code and tested)

- **Allow-list of lists.** Only the 11 views in `src/allowlist.ts`. Navigation to anything else is aborted.
- **Only Show, XLS, Previous, Next.** `clickAllowed()` is the only code that clicks; any other label
  (Save, Issue, Complete, Delete, Submit, Approve …) throws before the page is touched. A source test fails
  the build if another click, fill or page-script call is added anywhere.
- **No script in the portal page.** No `page.evaluate`, no calls to portal functions. The only fields filled
  are the three login fields; the login form is submitted with Enter.
- **Same origin only.** Every request to another origin (CDNs, analytics, anything) is aborted; WebSockets
  are closed; service workers and pop-ups are blocked.
- **Rule channel, default deny.** POSTs to `/archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr` are
  parsed; they pass only during a list read, only for `workflow.runWorkflowRule`, only with a rule id in
  `PERMITTED_READ_RULES`, and only when every view named is the open list's view. The generic SQL rule
  `AbCommonResources-executeCustomSQL` (analysis/01 §8.2) and `saveRecord` are always refused, as is any rule
  id that looks like a write. Real portal pages fire SQL calls on load; the guard stops them (the mock does the same, and the tests prove it).
- **At most 2 sign-in attempts per job, in total** (including re-sign-in after an expired session), then
  `signin_failed`. The counter lives in one class (`SignInBudget`) that cannot be raised above 2.
- **Human pace.** One page at a time, random 1.5–4 s pauses, exponential back-off after errors.
- **Password** is only in memory for the job, registered with the logger's redaction, never logged; a test
  greps all captured logs for it.
- **Downloads** go to a private temp folder, must be `.xls`/`.xlsx`, are size-capped (`MAX_DOWNLOAD_BYTES`,
  50 MB), are never opened or executed by the worker, and are deleted after upload.
- **https only.** A job whose portal address is not https is refused, unless `ALLOW_INSECURE_PORTAL=1` and the
  host is `localhost`, `127.0.0.1` or a compose service name (for the mock only).
- **Container:** official Playwright image, non-root `pwuser`, no published ports, no database access.

### Assumptions to confirm on the first supervised Test connection

The analysis documents do not record these, so they are standard ARCHIBUS defaults. If one is wrong the
guard blocks the request (safe failure) and the result message names it; update `src/allowlist.ts` only
after review.

- Login page address `/archibus/login.axvw` and a classic form post (field labels Project/Username/Password are confirmed).
- Data-read and export rule ids `AbCommonResources-getDataRecords`, `AbSystemAdministration-generateGridXLSReport`.
- Export files served from `/archibus/projects/users/<user>/<file>.xls(x)`.
- `wr_dashboard`: the 22-column grid appears only after clicking a cross-table count, which the worker may not
  do; expect a caption error for this list. `rfe_post_box` has no Show button; unverified whether XLS works without it.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `APP_URL` | — | SONU server on the compose network, e.g. `http://sonu:3000` |
| `ENCRYPTION_KEY` | — | Same 32-byte base64 key as the server (only used to derive the bearer token) |
| `POLL_SECONDS` | 15 | Poll interval |
| `HEADLESS` | 1 | `0` shows the browser (local debugging only) |
| `ALLOW_INSECURE_PORTAL` | unset | `1` only with the mock portal |
| `PACE_MIN_MS` / `PACE_MAX_MS` | 1500 / 4000 | Pause between steps |
| `MAX_DOWNLOAD_BYTES` | 52428800 | Export size cap |

## Run the tests

```
cd worker
npm install
npx playwright install chromium   # once per machine
npm run build
npm test
```

Tests run real Chromium against `mock-portal/` (on 127.0.0.1) and a tiny fake SONU server. They never
contact the real portal. Manual mock: `npm run mock` (prints its fictional sign-in; trap log at `/__trap-log`,
counters at `/__stats`). The mock serves `../fixtures/*<list_key>*.xlsx` when started with `MOCK_FIXTURES`.

## CHECKLIST — contractor admin: first "Test connection" against the real portal

1. **Dedicated account.** Ask QF for a Marafiq account just for SONU (same role and work teams as your
   contractor users). Do not use a person's own account.
2. **Tell QF** (ideally in writing) that SONU will read these lists automatically, read-only, at human pace,
   with the user agent `SONU-connector/… (read-only)`, and that QF can switch the account off at any time.
3. In SONU **Admin → Marafiq connection**: portal address (`https://…`), project, user name, and the
   password. Enter the password **only there** — never in e-mail, chat, Excel or a ticket.
4. Ask whoever runs the server to enable the worker: `docker compose --profile worker up -d`.
5. Press **Test connection** and wait up to a minute. Meaning of the result:
   - **OK** — signed in, the first list opened, its Show button was found. Nothing was pressed.
   - **Sign-in failed** — two attempts were made and the worker stopped (no third try, so the account is not
     locked). Check user name / password / project; "Internal error" from the portal has been seen before —
     wait a few minutes, then save the password again or press Resume to allow one new job.
   - **Error, "guard blocked …"** — the portal asked for something outside the read-only allow-list (for
     example a different login page or rule name). Nothing was sent. Pass the message to SONU support; the
     allow-list is changed only after review.
   - **Error, "refused: portal address must be https"** — fix the address.
6. If anything looks wrong, press **Pause**. The worker gets no further jobs until you press Resume.
   Manual XLS import keeps working meanwhile.

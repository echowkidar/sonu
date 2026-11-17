# SONU

**Hinglish summary:** SONU Marafiq ke upar chalne wali companion app hai, jo contractor ki tracking aur team kaam aasan banati hai.
Marafiq hi asli system of record rehta hai; XLS file manual upload karna hamesha kaam karta hai.
Marafiq se background connection optional hai aur by default OFF rehta hai.

## What it is

SONU is a companion web app (PWA) for a facilities contractor working on the Marafiq portal.

- **Marafiq stays the system of record.** SONU keeps a mirror of the exported lists plus the contractor's own columns (owner, criterion, contractor status, remarks), deadlines, RFE helpers, field jobs, notifications and a Master workbook export. It never writes to Marafiq.
- **Manual XLS upload always works.** Export a list from Marafiq, upload it in SONU.
- **Background connection is optional and OFF by default.** A separate read-only worker (Playwright) can fetch the same exports with a dedicated account. See `worker/README.md`.

Packages (each has its own `package.json` and lockfile; no root workspace): `packages/core` (pure library), `server` (Fastify 5 + PostgreSQL, also serves the built web app), `web` (Vite + React), `worker` (optional). Run-time files are in `assets/`, synthetic fixtures in `fixtures/`. Contract: `docs/ARCHITECTURE.md`, `docs/API-ops.md`, `docs/API-comm.md`.

## Local run

Node 22 or newer.

```
# build the shared library once (the server depends on it)
cd packages/core && npm install && npm run build

# API server with an embedded PostgreSQL (leave DATABASE_URL empty)
cd server && npm install && npm run dev

# web app (second terminal)
cd web && npm install && npm run dev
```

Alternatively use a real dev database: `docker compose -f docker-compose.dev.yml up -d`, then set
`DATABASE_URL=postgres://sonu:sonu-dev@localhost:54329/sonu`. Copy `.env.example` to `.env` for variables (never commit `.env`).

Tests, per package: `cd packages/core && npm test`; `cd server && npm test` (embedded PostgreSQL); `cd web && npm test`;
`cd worker && npm install && npx playwright install chromium && npm run build && npm test` (runs against a local mock portal only, never the real portal).

## Deploy with Portainer (Docker)

1. **Stacks -> Add stack -> Repository.**
2. Repository URL `https://github.com/echowkidar/sonu.git`. If the repository is private, enable authentication in Portainer and enter Git credentials there (a GitHub fine-grained token with read-only "Contents" access). You type the token in Portainer only; never put it in the repo.
3. Compose path: `docker-compose.yml`.
4. Add the environment variables below, then **Deploy the stack**. The image is built on the server (core, server and web are built inside the Dockerfile).

| Variable | Meaning | Default | Required |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Database password (long random string); also used to build `DATABASE_URL` | none | yes |
| `ENCRYPTION_KEY` | 32 random bytes, base64: `openssl rand -base64 32`. Encrypts stored passwords | none | yes |
| `PUBLIC_URL` | Address users open, e.g. `https://sonu.example.com` (invitation and reset links) | none | yes |
| `SONU_PORT` | Host port mapped to the app (container port is 3000) | `8091` | no |
| `TRUST_PROXY` | `1` = trust the private-network proxy in front (Cloudflare Tunnel): real client IP, Secure cookies on https. `0` if exposed directly | `1` | no |

The database is not published to the host. Named volumes: `sonu-db` (PostgreSQL) and `sonu-uploads` (photos and documents).

**Cloudflare Tunnel.** If `cloudflared` runs on the host, set the public hostname service URL to `http://localhost:<SONU_PORT>` (default `http://localhost:8091`). If it runs as a container, uncomment the `networks` lines in `docker-compose.yml` (in the app service and the bottom `cloudflared` external network) and use `http://sonu-app:3000`.

### First admin sign-in

On first start with no users, the app prints a one-time setup code once in the `sonu-app` container log (Portainer: Containers -> sonu-app -> Logs). Open `PUBLIC_URL/setup`, enter the code and create the platform admin. There is no default password. Other accounts are created by invitation or bulk import only.

### Enabling the Marafiq worker (optional)

Redeploy with the compose profile `worker` (`docker compose --profile worker up -d`; in Portainer set `COMPOSE_PROFILES=worker` as a stack variable). Then follow the checklist in `worker/README.md` (dedicated account, tell QF, enter the password only in Admin -> Marafiq connection, press Test connection). The worker has no published ports and no database access; it polls the app at `http://app:3000`. Never set `ALLOW_INSECURE_PORTAL` in production (mock portal only).

### Mail, push, WhatsApp

- **Mail:** the contractor admin enters the sender under **Admin → E-mail** (`/admin/email`: SMTP, or Microsoft 365 / Google Workspace sign-in) and presses **Send test e-mail**. Until then mails are not sent; they go to the app log and the `mail_outbox` table, so invitation links still work in a local run.
- **Web push** needs HTTPS (the tunnel provides it). Users enable it per device.
- **WhatsApp:** the default is click-to-chat (SONU builds a `wa.me` link/QR; a person presses send). The optional "linked session" mode needs the `baileys` package, which pulls the GPL-3.0 `libsignal`. It is **not installed by default**; the owner decides whether to accept that licence (see `LICENSES.md`).

### Backup and restore

```
docker exec sonu-db pg_dump -U sonu sonu > backup.sql             # backup
docker exec -i sonu-db psql -U sonu -d sonu < backup.sql          # restore into an empty database
```

Also back up the `sonu-uploads` volume, for example
`docker run --rm -v sonu-uploads:/d -v "$PWD":/b alpine tar czf /b/uploads.tgz -C /d .`
(Portainer may prefix volume names with the stack name; check `docker volume ls`.)

**Keep a copy of `ENCRYPTION_KEY` outside the server.** If it is lost, saved passwords (Marafiq, mail) must be entered again and WhatsApp must be re-linked.

## Data rules

The repository holds no secrets, no real exports and no personal data. Fixtures and tests use synthetic data only (fictional names, `user@example.com`). `.env`, uploads and real export files are git-ignored. Third-party licences: `LICENSES.md`.

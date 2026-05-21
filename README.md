# Axiom — Minecraft AFK Bot Dashboard

A self-hosted Minecraft AFK bot system that keeps **multiple accounts logged
in to a server in parallel**, each as its own isolated mineflayer instance,
controllable from a modern web dashboard.

The original `BennettSchwartz/minecraft-afkbot` only supported *switching*
between stored credentials — one bot at a time. Axiom fixes that: every
added account runs its own bot concurrently, with per-account configuration,
behaviors, and chat streams.

Defaults to Minecraft Java **1.8.9** (overridable per account).

---

## Features

- **True multi-account** — N accounts, N concurrent mineflayer bots
- **Microsoft device-code auth** (premium accounts) and **offline mode**
  (cracked/LAN) — both supported per account
- **Encrypted token storage** — Microsoft tokens encrypted at rest in
  Postgres via AES-256-GCM, never logged
- **Start / stop bots** individually from the dashboard, including a
  reconnect-suppression `stopped` state so the bot doesn't auto-reconnect
- **Per-account anti-AFK behaviors**
  - **Wiggle** — jittered look/sneak actions
  - **Chat ping** — *fixed-interval* chat messages rotating through a list
  - **Login commands** — sequenced `/login`, `/warp`, etc. with delays
- **Templated commands** — use `{{ordinal}}`, `{{username}}`, `{{label}}`
  in any command/message. E.g. set the default login command to
  `/f warp cac{{ordinal}}` and account #1 runs `/f warp cac1`, account #2
  runs `/f warp cac2`, etc.
- **Real-time UI** — WebSocket pub/sub, no polling. Live status pills,
  chat streams, lifecycle events
- **Dark mode**, mobile-responsive, single shared dashboard token
- **Exponential reconnect** with jitter, capped at 5 min, with a hard
  retry limit so dead accounts don't loop forever

---

## Quick start (Docker)

You need: Docker, Docker Compose, and 30 seconds.

```sh
git clone <this repo>
cd Axiom

# Create the env file
cp .env.example .env

# Generate two random 32-byte hex secrets
openssl rand -hex 32  # → paste as DASHBOARD_TOKEN
openssl rand -hex 32  # → paste as TOKEN_ENCRYPTION_KEY
# Set POSTGRES_PASSWORD to anything you want

# Bring it up
docker compose up -d
```

Open `http://localhost:5005`, enter your `DASHBOARD_TOKEN`, and add your
first account.

---

## How auth works

### Dashboard auth
A single shared bearer token (`DASHBOARD_TOKEN`). Required on every REST
request as `Authorization: Bearer <token>`, and on the WebSocket upgrade
as `?token=<token>`. Failed attempts are rate-limited and IP-logged.

This is a single-user self-host tool — there are no user accounts.

### Microsoft account auth (per bot)
**Device-code flow only.** When you add a Microsoft account:

1. Dashboard shows you a code like `ABCD-EFGH`
2. You go to `microsoft.com/link`, paste it, sign in with the Microsoft
   account that owns the Minecraft profile
3. Dashboard polls until success, then stores the refresh token blob
   encrypted in Postgres and immediately connects the bot

After that, the user never sees a code again until the refresh token
expires (~90 days, and mineflayer refreshes it transparently on every use).

**Microsoft password (ROPC) auth is intentionally not supported.**
Microsoft's Xbox Live SISU endpoint blocks password flow for 2FA accounts,
breaks regularly under policy changes, and is a major security smell.
Device code is the only sane path in 2026.

---

## Architecture

Three Docker services on a private network. Only the frontend port is
exposed to the host; the backend talks to Postgres over the internal
bridge.

```
┌──────────┐       ┌──────────────┐       ┌──────────────┐
│ browser  │──────▶│   frontend   │──────▶│    backend   │──┐
│ :5005    │       │ nginx + Vite │       │ Express + WS │  │
└──────────┘       │ proxies /api │       │ AccountMgr   │  │
                   │ + /ws        │       │ N mineflayer │  │
                   └──────────────┘       └──────┬───────┘  │
                                                 │          │
                                                 ▼          ▼
                                          ┌──────────┐  ┌────────┐
                                          │ Postgres │  │  MC    │
                                          │  16      │  │ server │
                                          └──────────┘  └────────┘
```

**Stack**

- Backend: Bun + TypeScript (strict), Express, `mineflayer`,
  `prismarine-auth`, Prisma + Postgres, Pino, Zod, `ws`
- Frontend: React 18 + Vite + TypeScript, Tailwind, shadcn/ui, Zustand,
  React Router
- Prod serving: nginx in the frontend container, reverse-proxying `/api/*`
  and `/ws` to the backend service

---

## Project structure

```
Axiom/
├── backend/             # Express + mineflayer
│   ├── src/
│   │   ├── minecraft/   # AccountManager, BotInstance, behaviors, MS auth
│   │   ├── routes/      # REST + WS
│   │   ├── db/          # Prisma client + crypto helpers
│   │   ├── middleware/  # auth, rate-limit, error handling
│   │   └── index.ts
│   ├── prisma/schema.prisma
│   ├── tests/
│   └── Dockerfile
├── frontend/            # React + Vite + shadcn/ui
│   ├── src/
│   │   ├── routes/      # Login, AccountList, AccountDetail, Settings
│   │   ├── components/  # AccountCard, ChatLog, BehaviorConfigForm, etc.
│   │   ├── lib/         # api, ws, types, utils
│   │   └── store/       # Zustand stores
│   ├── nginx.conf
│   └── Dockerfile
├── docker-compose.yml
├── docker-compose.dev.yml
└── .env.example
```

---

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `DASHBOARD_TOKEN` | yes | Bearer token to log in to the UI. Use a long random string. |
| `TOKEN_ENCRYPTION_KEY` | yes | Exactly 64 hex chars (32 bytes). Used to AES-256-GCM-encrypt Microsoft refresh tokens at rest. **Rotating this means existing MS accounts must re-auth.** |
| `POSTGRES_PASSWORD` | yes | Database password. |
| `POSTGRES_DB` / `POSTGRES_USER` | no | Default `afkbot`. |
| `ALLOWED_ORIGIN` | no | CORS origin. Default `http://localhost:5005`. |
| `HOST_PORT` | no | Host port to publish the frontend on. Default `5005`. |
| `LOG_LEVEL` | no | Pino level. Default `info`. |

Generate the secrets:
```sh
openssl rand -hex 32   # DASHBOARD_TOKEN
openssl rand -hex 32   # TOKEN_ENCRYPTION_KEY
```

---

## Operations

### Backups
The Postgres volume (`postgres-data`) holds everything important: account
configuration, settings, and the encrypted Microsoft token blobs. Back it
up like any other Postgres database:

```sh
docker compose exec postgres pg_dump -U afkbot afkbot > backup.sql
```

Restoring this on another host requires the **same** `TOKEN_ENCRYPTION_KEY`
to decrypt the cached tokens — otherwise Microsoft accounts will need to
re-auth once.

### Rotating `TOKEN_ENCRYPTION_KEY`
1. Stop all bots from the dashboard (or `docker compose down`)
2. Update `TOKEN_ENCRYPTION_KEY` in `.env`
3. Bring the stack back up — Microsoft accounts will show as needing
   re-auth on next connect; click the account → run the device-code flow
   again. Offline accounts are unaffected.

### Updating
```sh
git pull
docker compose build
docker compose up -d
```

Schema changes are applied automatically by `prisma migrate deploy` on
backend startup.

---

## Security notes

- HTTPS is **not** terminated by this stack. Put a reverse proxy
  (Caddy, Traefik, nginx, Cloudflare Tunnel) in front if you expose this
  to the public internet. The dashboard token is the only thing standing
  between an attacker and full control of your bot accounts.
- The backend container runs as a non-root user (`app`).
- The backend is not published to the host port — only the frontend's
  nginx is reachable from outside the compose network.
- Logs redact `Authorization` headers and any field named `*token`,
  `*password`, `*encryptionKey`.

---

## Server compatibility & ToS

**Hypixel and most large 1.8.9 servers explicitly ban AFK bots** in their
rules. This tool is intended for private SMPs, faction servers where
automation is allowed, and your own test servers. If you're not sure your
server permits this, **assume it doesn't** and ask the operator. Getting
your account banned is not the bot's fault.

---

## Development

```sh
pnpm install
pnpm --filter backend prisma:generate

# Backend (needs Postgres reachable — start it with docker compose -f docker-compose.yml -f docker-compose.dev.yml up postgres)
pnpm --filter backend db:migrate:dev
pnpm --filter backend dev

# Frontend (uses the Vite dev proxy at port 5173 → backend at 3000)
pnpm --filter frontend dev

# Tests
pnpm --filter backend test

# Typecheck everything
pnpm typecheck
```

---

## Out of scope

- Discord control (REST + WS surface is already factored to support it; not built)
- Pathfinding, combat, farming — AFK only
- Multi-user / multi-tenant — single shared token, single self-host
- Mojang auth (dead since 2022)
- Microsoft password / ROPC auth (broken + insecure — use device code)

---
title: Quick start
description: Run fastapi-react-admin locally — PostgreSQL and Redis in Docker, five commands, then sign in at localhost:8888 as admin / 123456.
sidebar:
  order: 1
---

Five commands bring up the whole stack locally: PostgreSQL and Redis in Docker, the FastAPI backend on port 8088, the React frontend on port 8888 and a Celery worker. Sign in as `admin` / `123456`.

## What do I need installed?

- Node.js ≥ 22.13 (pnpm is pinned in `package.json` and installed by corepack)
- Python ≥ 3.10 and [uv](https://docs.astral.sh/uv/)
- Docker

## How do I run it?

```bash
docker compose -f docker-compose.dev.yml up -d          # PostgreSQL 16 + Redis
pnpm install:all                                        # JS workspace, Python deps, git hooks, Playwright Chromium
cp apps/api/backend/.env.example apps/api/backend/.env  # defaults already match the containers above
pnpm db:init                                            # create tables + seed data (first run only)
pnpm dev                                                # api :8088 · web :8888 · celery worker
```

Open <http://localhost:8888> and sign in as `admin` / `123456`.

:::caution
`pnpm db:init` drops and recreates every table. Run it on the first setup or when you want a clean database; after that, schema changes go through `pnpm db:upgrade` (Alembic).
:::

## Why does the sign-in page ask for a captcha?

The image captcha is on by default. To skip it locally, set `LOGIN_CAPTCHA_ENABLED` to `false` under **System → Config**; it takes effect immediately. To type it instead, take the `uuid` from the `GET /api/v1/auth/captcha` response and read the answer from Redis:

```bash
docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"
```

## How do I use SQL Server, MySQL or S3 instead?

Everything optional is in the same `docker-compose.dev.yml`; turn it on and change `DATABASE_*` in `.env`.

| To use | Command | Notes |
|---|---|---|
| **SQL Server** | `docker compose -f docker-compose.dev.yml --profile sqlserver up -d mssql` | The host also needs [Microsoft ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server) — the backend connects through `aioodbc`, so the driver inside the container doesn't count |
| **MySQL** | bring your own MySQL 8.x | `DATABASE_TYPE='mysql'`, charset `utf8mb4` |
| **S3-compatible storage** (RustFS) | `docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs` | Set `STORAGE_ENCRYPT_SECRET_KEY` in `.env` (`openssl rand -hex 32`) before adding a storage under **System → Storage** |

:::caution
Keep `DATABASE_PK_MODE='snowflake'` (the default). Seed data only exists for snowflake IDs; in autoincrement mode the seed step is skipped silently and you end up with tables but no `admin` account.
:::

See [Databases](/en/features/databases/) for how the three databases are supported and tested.

## What runs where?

| Process | Port | Started by |
|---|---|---|
| FastAPI backend (uvicorn, `--reload`) | 8088 | `pnpm dev` |
| React frontend (Vite) | 8888 (fixed — `strictPort`) | `pnpm dev` |
| Celery worker with embedded beat | — | `pnpm dev` |
| PostgreSQL / Redis | 5432 / 6380 | `docker compose` |

The frontend port is fixed on purpose: CORS, OAuth2 redirect URIs and the desktop app's dev URL all point at 8888, so Vite fails instead of drifting to 8889.

## Where to go next

- [Feature overview](/en/features/overview/) — what you can build on.
- [Deployment](/en/getting-started/deployment/) — run it on a server from prebuilt images.
- [CONTRIBUTING.md](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md) — tests, branches and releases (in Chinese; the commands are language-independent).

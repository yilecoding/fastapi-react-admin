---
title: Quick start
description: Run fastapi-react-admin locally — PostgreSQL and Redis in Docker, five commands, set the admin password during init, then sign in at 127.0.0.1:8888.
sidebar:
  order: 1
---

Five commands bring up the whole stack locally: PostgreSQL and Redis in Docker, the FastAPI backend on port 8088, the React frontend on port 8888 and a Celery worker. The account is `admin`, with the password you set during `pnpm db:init`.

## What do I need installed?

- Node.js ≥ 22.13 (pnpm is pinned in `package.json` and installed by corepack)
- Python ≥ 3.11 and [uv](https://docs.astral.sh/uv/)
- Docker

## How do I run it?

```bash
docker compose -f docker-compose.dev.yml up -d          # PostgreSQL 16 + Redis
pnpm install:all                                        # JS workspace, Python deps, git hooks, Playwright Chromium
cp apps/api/backend/.env.example apps/api/backend/.env  # defaults already match the containers above
pnpm db:init                                            # tables + seed data + a new admin password (first run only)
pnpm dev                                                # api :8088 · web :8888 · celery worker
                                                        # open http://127.0.0.1:8888
```

Open <http://127.0.0.1:8888> and sign in as `admin` with the password you set during `pnpm db:init`.

:::note[Why not admin / 123456?]
The seed's `123456` is not allowed to survive initialization: `pnpm db:init` asks for a new admin password (non-interactively it reads `FBA_INIT_ADMIN_PASSWORD`) and disables the sample `test` account. `admin` / `123456` is only the [live demo](https://fra.wubunan.com/sign-in) account.
:::

:::caution[Use 127.0.0.1, not localhost]
The frontend calls `http://127.0.0.1:8088` directly. Opened from `localhost:8888`, the browser treats that as cross-site and does not keep the refresh-token cookie: sign-in works, but **a page refresh sends you back to the sign-in page**.
:::

### How do I know each step worked?

| Step | Check |
|---|---|
| `docker compose … up -d` | `docker ps` shows `fba_postgres` and `fba_redis` as `healthy` |
| `pnpm install:all` | finishes without errors, and `apps/api/.venv` exists |
| `pnpm db:init` | the last line says the new database was stamped at the migration head; `pnpm db:current` shows a revision marked `(head)` |
| `pnpm dev` | the sign-in page shows a **captcha image** — the backend serves it, so seeing it means frontend and backend are connected |
| Sign in | you land on the dashboard, which starts with "you have N things waiting" |

Stuck on a step? Search the error text in the [FAQ](/en/reference/faq/).

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
Keep `DATABASE_PK_MODE='snowflake'` as in `.env.example`. Seed data only exists for snowflake IDs; in autoincrement mode (or if `.env` lacks the line — the code default is `autoincrement`) initialization exits with an error saying the seed has no admin account.
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

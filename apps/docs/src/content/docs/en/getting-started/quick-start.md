---
title: Quick start
description: Start PostgreSQL and Redis in Docker, install dependencies, initialize a development database and sign in locally. Each step includes a check.
sidebar:
  order: 1
---

Follow these four steps to reach your local dashboard. The default stack uses PostgreSQL and Redis, with the API, web app and Celery worker running locally.

**Working directory: the repository root**, which contains `pnpm-workspace.yaml`. Run every command below there.

<span id="what-do-i-need-installed"></span>

## Before you start

| Tool | Requirement |
|---|---|
| Node.js | ≥ 22.13; use Corepack to install the pnpm version pinned in `package.json` |
| Python | ≥ 3.11, with [uv](https://docs.astral.sh/uv/) installed |
| Docker | Docker is running and `docker compose` is available |

<span id="how-do-i-run-it"></span>

## 1. Start the database and Redis

```bash
docker compose -f docker-compose.dev.yml up -d
```

Check their status:

```bash
docker compose -f docker-compose.dev.yml ps
```

**Expected result:** both `fba_postgres` and `fba_redis` report `healthy`. On the first start, wait for their health checks before continuing.

## 2. Install dependencies and prepare configuration

```bash
pnpm install:all
```

This installs JavaScript and Python dependencies, Git hooks and Playwright Chromium. **Continue when it finishes without errors and `apps/api/.venv` exists.**

Copy the backend configuration, keeping an existing `.env` file:

```bash
cp -n apps/api/backend/.env.example apps/api/backend/.env
```

The example defaults match the containers above. If you already had a configuration file, check its database and Redis connections.

Keep `DATABASE_PK_MODE='snowflake'`. The seeds use snowflake IDs; switching to autoincrement or omitting this line makes initialization fail to find the admin account.

## 3. Initialize the development database

:::caution[Confirm the target database can be cleared]
`pnpm db:init` deletes and recreates the **entire configured database**. Check the connections and `DATABASE_SCHEMA` in `apps/api/backend/.env` (the example uses `fba`), and any environment variables overriding them. To preserve existing data, back it up and use `pnpm db:upgrade` for schema changes.
:::

```bash
pnpm db:init
```

Follow the prompts to confirm the target and set a new password for `admin`. Keep this password for sign-in. Initialization also disables the sample `test` account; automation supplies the password through `FBA_INIT_ADMIN_PASSWORD`.

**Expected result:** the last message says the new database was stamped at the migration head. Check the revision:

```bash
pnpm db:current
```

The revision should be marked `(head)`.

<span id="how-do-i-know-each-step-worked"></span>

## 4. Start the app and sign in

```bash
pnpm dev
```

Leave this terminal running and open <http://127.0.0.1:8888>.

:::note[Local address]
Use `127.0.0.1:8888`. The default API is at `127.0.0.1:8088`; accessing it from `localhost:8888` is cross-site, so the browser cannot keep the refresh-token cookie and a page refresh returns you to sign-in.
:::

Check these in order:

1. The sign-in page shows a captcha image, confirming the frontend reaches the backend (captcha is enabled by default).
2. Sign in as `admin` with **the password you set during initialization** and reach the dashboard.
3. Refresh the page and remain signed in.

Your local environment is ready once all three work. Next time, check the containers are running and run `pnpm dev`.

## Common questions

<details>
<summary>Why does admin / 123456 fail?</summary>

Use the password chosen during initialization. `admin` / `123456` belongs to the [live demo](https://fra.wubunan.com/sign-in); initialization refuses to keep the seed password.

</details>

<span id="why-does-the-sign-in-page-ask-for-a-captcha"></span>

<details>
<summary>Can I disable the captcha locally?</summary>

Yes. After signing in, set `LOGIN_CAPTCHA_ENABLED` to `false` under **System → Config**; it takes effect immediately. Database settings can override `.env`; see [captcha configuration troubleshooting](/en/reference/faq/#login_captcha_enabledfalse-is-set-in-env-but-sign-in-still-asks-for-a-captcha).

For debugging, use the `uuid` from `GET /api/v1/auth/captcha` to read the answer in Redis:

```bash
docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"
```

</details>

<span id="what-runs-where"></span>

<details>
<summary>Which ports are used? What if 8888 is occupied?</summary>

| Service | Port | Started by |
|---|---|---|
| FastAPI (uvicorn, auto-reload) | 8088 | `pnpm dev` |
| React (Vite) | 8888 | `pnpm dev` |
| Celery worker with embedded beat | — | `pnpm dev` |
| PostgreSQL / Redis | 5432 / 6380 | `docker compose` |

The frontend uses a fixed port: CORS, OAuth2 callbacks and the desktop dev URL all use 8888. If it is occupied, Vite fails; identify the process before deciding whether to stop it. For other startup failures, search the error text in the [FAQ](/en/reference/faq/).

</details>

<span id="how-do-i-use-sql-server-mysql-or-s3-instead"></span>

<details>
<summary>Can I use SQL Server, MySQL or S3?</summary>

Yes. Optional services are listed below; switching databases also requires changing `DATABASE_*` in `.env`.

| Service | Setup |
|---|---|
| SQL Server | `docker compose -f docker-compose.dev.yml --profile sqlserver up -d mssql`; also install [ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server) on the host |
| MySQL | Bring MySQL 8.x; set `DATABASE_TYPE='mysql'` and use `utf8mb4` |
| S3-compatible storage (RustFS) | `docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs`; set `STORAGE_ENCRYPT_SECRET_KEY` (generate with `openssl rand -hex 32`) before adding storage in the UI |

Continue with [Databases](/en/features/databases/) or [File storage](/en/features/file-storage/).

</details>

## Where to go next

- [Feature overview](/en/features/overview/): what the system can do.
- [Sign-in and security](/en/features/login-security/): password policies and two-factor setup.
- [Deployment](/en/getting-started/deployment/): deploy prebuilt images to a server.
- [Contributing](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md): tests, branches and releases (in Chinese).

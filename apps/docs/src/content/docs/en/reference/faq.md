---
title: FAQ and troubleshooting
description: Troubleshooting indexed by the exact error text — 25 common problems with local setup, sign-in, database migrations, frontend work and production deploys.
sidebar:
  order: 1
---

Copy the error text from your terminal or browser and find it on this page with Ctrl+F or the site search. Each entry gives the cause, the fix, and the source note in the repository it comes from.

## Installation and local setup

### `Port 8888 is already in use`

**Cause**: the frontend port is fixed at 8888 with `strictPort: true` in `apps/web/vite.config.ts`. When the port is taken, Vite exits instead of moving to 8889. It does this on purpose: the backend CORS allow-list, the OAuth2 redirect URIs and the desktop dev script all have 8888 hard-coded.

**Fix**: find the process holding 8888 (usually a `pnpm dev` that didn't shut down cleanly), stop it, and start again. If you really need another port, change four places together: `vite.config.ts`, `CORS_ALLOWED_ORIGINS` in `backend/core/conf.py`, the two `OAUTH2_FRONTEND_*_REDIRECT_URI` entries in `backend/plugin/oauth2/plugin.toml`, and the `DEV_SERVER_URL` default in `apps/desktop/scripts/dev.mjs`.

```bash
lsof -i :8888     # who is holding the port
```

Source: [`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md), section 「本地起服务」 (running locally)

### `Can't open lib 'ODBC Driver 18 for SQL Server'`

**Cause**: with SQL Server, the backend connects through `aioodbc` using the ODBC driver **on the host**. The driver inside the SQL Server container doesn't count, so the container runs fine and the backend fails on its first connection.

**Fix**: install [Microsoft ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server) on the machine that runs the backend. `DATABASE_DRIVER` in `.env` (default `ODBC Driver 18 for SQL Server`) must match a name printed by the command below exactly. The production image `apps/api/Dockerfile.prod` already installs `msodbcsql18`, and the worker and beat use the same image.

```bash
odbcinst -q -d
```

Source: [`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md), [`apps/api/Dockerfile.prod`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/Dockerfile.prod)

### `Login failed for user 'sa'` (SQL Server error 18456)

**Cause**: `DATABASE_PASSWORD` in `.env` doesn't match the SQL Server instance's real password. The usual trigger is changing `MSSQL_SA_PASSWORD` in `docker-compose.dev.yml`: SQL Server keeps its data in a persistent volume, and an instance that has already been initialized keeps its old password.

**Fix**: set `DATABASE_PASSWORD` to the instance's current sa password. If you really want the new password, delete the data volume so the instance initializes again. When `pnpm db:init` hits this error it prints 「数据库登录失败：…（SQL Server 错误 18456）」.

Source: [`apps/api/backend/cli.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/cli.py) (`_format_database_connection_error`)

### `ModuleNotFoundError` from `pnpm test` or `pnpm db:upgrade` after pulling, although `pnpm dev` works

**Cause**: `uv` manages the Python dependencies, so `pnpm install` doesn't install them. `dev`, `db:init` and `db:reset` use a bare `uv run`, which syncs dependencies automatically. `test`, `test:db`, `db:upgrade`, `e2e:server` and `celery:*` pass `--no-sync`, so they fail as soon as a package is missing. A working `pnpm dev` therefore doesn't prove the dependencies are complete.

**Fix**: sync once whenever `pyproject.toml` has changed.

```bash
pnpm --filter api exec uv sync     # or pnpm install:all
```

Source: [`apps/api/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/AGENTS.md)

### Worker log shows `Received unregistered task of type '…'` and your own tasks sometimes vanish

**Cause**: the Celery broker defaults to Redis database 1 (`CELERY_BROKER_REDIS_DATABASE=1`). If another project's Celery on the same machine uses database 1 of the same Redis, both sets of workers consume one queue. Their tasks land on your worker and show up as "unregistered"; your tasks land on theirs and disappear without a trace.

**Fix**: point `CELERY_BROKER_REDIS_DATABASE` in your local `.env` at an empty database and restart the worker. Check first that nobody uses it:

```bash
docker exec fba_redis redis-cli -n 7 DBSIZE    # must return 0
```

Source: [`apps/api/backend/app/task/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/AGENTS.md)

## Sign-in and sessions

### Signing in at `http://localhost:8888` works, but reloading the page sends you back to the sign-in page

**Cause**: the frontend calls `http://127.0.0.1:8088` directly by default (`API_BASE` in `packages/platform/src/api-client/client.ts`). When the page is opened from `localhost`, that is a cross-site request, and the browser doesn't store the refresh-token cookie. Sign-in itself succeeds, but after a full reload `/auth/refresh` returns 401.

**Fix**: open <http://127.0.0.1:8888> for local development, not `localhost:8888`.

Source: [`apps/docs/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/docs/AGENTS.md)

### `admin` / `123456` doesn't work after `pnpm db:init`

**Cause**: after loading the seed data, `fba init` forces the seeded admin password `123456` to be replaced. In a terminal it asks you for a new password. In a non-interactive run (`--auto`, CI, no TTY) it reads the `FBA_INIT_ADMIN_PASSWORD` environment variable and fails if that is missing. It also disables the seeded demo account `test` and gives it a random password.

**Fix**: sign in with the password you set during initialization. For a non-interactive run:

```bash
FBA_INIT_ADMIN_PASSWORD='<strong password>' pnpm db:reset
```

`123456` only works in the `fba_test` database used by pytest and E2E, which `pnpm --filter api test:db` builds separately.

Source: [`apps/api/backend/cli.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/cli.py) (`_set_admin_password`)

### `Too many requests, please try again later` (HTTP 429) on sign-in

The Chinese UI shows 「请求过于频繁，请稍后重试」.

**Cause**: the sign-in endpoints are rate-limited per IP and path to 5 requests a minute; the captcha endpoint `/auth/captcha` allows 5 every 30 seconds. A few wrong passwords in a row, or a script that signs in to several accounts, hits the limit quickly. The `Retry-After` response header says how many seconds to wait.

**Fix**: wait and try again. A rate-limited attempt doesn't consume the captcha, so the page keeps the current captcha image and you can reuse it. When you seed a lot of data locally, you can start the backend with `REQUEST_LIMITER_ENABLED=false` for a while (production refuses this setting).

Source: [`apps/docs/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/docs/AGENTS.md), [`apps/api/backend/app/admin/api/v1/auth/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/api/v1/auth/auth.py)

### `LOGIN_CAPTCHA_ENABLED=false` is set in `.env`, but sign-in still asks for a captcha

**Cause**: at runtime this switch is read from the `sys_config` table. The seed data includes a `LOGIN_CAPTCHA_ENABLED` row, and the backend loads it over whatever `.env` says.

**Fix**: change `LOGIN_CAPTCHA_ENABLED` to `false` under System → Parameters (「系统管理 → 参数配置」); it takes effect immediately. To keep the captcha and still sign in locally, note the `uuid` from the `GET /api/v1/auth/captcha` response and read the answer from Redis:

```bash
docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"
```

Source: [`apps/web/e2e/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/AGENTS.md), [`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)

## Database and migrations

### All existing data is gone after `pnpm db:init`

**Cause**: `pnpm db:init` (`fba init`) runs `drop_all` and then `create_all`, loads the seed data and stamps Alembic at head. It is meant for a fresh environment and asks for confirmation first (the default answer is `n`).

**Fix**: run it only for a first setup or when you really want to wipe the data. To update the schema of an existing database, migrate:

```bash
pnpm db:upgrade
```

Source: [`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md), [`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)

### `种子数据里没有 admin 账号，初始化流程可能已经变了` (no admin account in the seed data)

**Cause**: `DATABASE_PK_MODE` isn't `'snowflake'`. The seed SQL for all three databases only exists in the snowflake-ID form (`init_snowflake_test_data.sql`). In autoincrement mode no seed file is found and the step is skipped without a message. The database ends up with no admin account, and init then fails when it tries to set the admin password. The default for this setting in `core/conf.py` is `'autoincrement'`, so an `.env` without this line hits the same problem.

**Fix**: put `DATABASE_PK_MODE='snowflake'` in `apps/api/backend/.env` (`.env.example` already has it) and run `pnpm db:init` again.

Source: [`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md), [`apps/api/backend/cli.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/cli.py)

### Changed a model and the backend reloaded, but the table didn't change

**Cause**: `--reload` in `pnpm dev` only restarts the process and re-imports the models. It never alters existing tables.

**Fix**: after changing a model, generate a migration, read the generated file, then upgrade:

```bash
pnpm db:revision 'add xxx column'
pnpm db:upgrade
```

If you changed columns, also update `backend/sql/*/init_snowflake_test_data.sql`. Those INSERTs list their columns explicitly, and a stale one breaks initialization of new environments.

Source: [`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md), [`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)

### `Cannot insert explicit value for identity column in table '…' when IDENTITY_INSERT is set to OFF. (544)`

**Cause**: this only happens on SQL Server, and only on tables **created by a migration**. Alembic autogenerate can't render the model's Python-side `default=snowflake.generate`. The id column it writes gets created as `IDENTITY` on SQL Server, and every INSERT fails after that. Tables built by `create_all` don't have this problem, so development and test databases never show it.

**Fix**: in any migration that creates a table, declare the snowflake primary key with `autoincrement=False`. The guard test `test_created_tables_declare_snowflake_pk_as_non_autoincrement` checks the `create_table` calls in `alembic/versions/` for it.

Source: [`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)

### The first pytest or E2E run fails with a database connection error

**Cause**: both test suites run against a separate `fba_test` database, not the development database `fba`. It has to be created once by hand; until then the only symptom is a SQLAlchemy connection error that says nothing about the cause.

**Fix**: create an empty `fba_test` database first (the script won't, because `CREATE DATABASE` has to run from another database), then let the script build the tables and load the seed data:

```bash
docker exec fba_postgres createdb -U postgres fba_test   # default PostgreSQL; once only
pnpm --filter api test:db     # rebuild tables from the models, seed, stamp head
pnpm test
```

If tests later fail with errors like `Invalid column name …` after a model change, run `test:db` again.

Source: [`apps/api/backend/tests/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/tests/AGENTS.md), [`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)

## Frontend development

### ID `2049629108245233664` became `2049629108245233700` and an update or delete hit the wrong record

**Cause**: snowflake IDs are around 2^61, larger than JavaScript's `Number.MAX_SAFE_INTEGER` (2^53-1). Parsing one as a number loses precision, and consecutive IDs can collapse into the same value, so sending it back targets a different record. Route parameters have the same problem, because TanStack Router runs `JSON.parse` on search values by default.

**Fix**: treat every ID as a string and never call `Number()` on it. The backend already sends IDs as strings (`backend/utils/serializers.py`), and `apps/web/src/lib/search-params.ts` keeps out-of-range integers in the URL as strings. Before adding a search parameter that carries an ID, check that this custom parser is still wired into `router.ts`.

Source: [`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md), hard rule 6

### `pnpm e2e -- tests/xxx.spec.ts` runs the whole suite instead of one file

**Cause**: pnpm passes the `--` through to Playwright, which then ignores the file name and the arguments after it. The full suite runs (more than ten minutes), and it looks as if that one file is just slow.

**Fix**: drop the `--` and run it from `apps/web`:

```bash
cd apps/web && pnpm e2e tests/dept-crud.spec.ts
```

Source: [`apps/web/e2e/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/AGENTS.md)

### Docs build fails with `Node.js v22.23.3 is not supported by Astro!`

**Cause**: the docs site (`apps/docs`) is locked to Astro 7.3.x. `astro@7.4.4` needs Node ≥ 22.23.4, while the repository's `engines` field says ≥ 22.13. If the dependency was bumped to 7.4 (for example by `pnpm update`), older Node 22 releases fail with this message. `pnpm build` builds the docs site through turbo, so the whole-repo build fails as well.

**Fix**: go back to the version in the lockfile (`pnpm install --frozen-lockfile`) or upgrade Node to 22.23.4 or later. Upgrading Astro for real means deciding on the `engines` field in the root `package.json` and the Node version in CI first.

Source: [`apps/docs/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/docs/AGENTS.md)

## Deployment and operations

### `ENVIRONMENT=prod，但有 N 项配置不合格，拒绝启动` (production config check failed)

**Cause**: with `ENVIRONMENT=prod`, the backend validates its configuration before starting and refuses to start if anything fails. The checks cover the strength of `TOKEN_SECRET_KEY`, `DATABASE_PASSWORD` and `REDIS_PASSWORD`; `LOGIN_CAPTCHA_ENABLED` and `REQUEST_LIMITER_ENABLED` must be true; `CORS_ALLOWED_ORIGINS` must not contain `*`, `localhost` or `127.0.0.1`; and `DATABASE_USER` must not be a superuser such as `sa`, `root` or `postgres`.

**Fix**: fix `.env.server` item by item, following the numbered list in the error. To generate a signing key:

```bash
python -c "import secrets;print(secrets.token_urlsafe(32))"
```

Source: [`apps/api/backend/core/conf.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/core/conf.py)

### `ENVIRONMENT=prod，数据库检查未通过，拒绝启动` (production database check failed)

**Cause**: in production the backend never creates tables itself. At startup it checks the database, and three things stop it:

- `数据库里没有 alembic_version 表` (no `alembic_version` table): the database was built by `create_all` but never stamped.
- `数据库迁移版本 … 不等于 head` (migration version is not head): the migrations weren't run before deploying the new version.
- `这些账号仍在使用种子数据里的默认密码（123456）` (accounts still use the seeded password 123456): the seed SQL was loaded directly instead of through `fba init`.

**Fix**: respectively, build the database with `fba init` (it stamps head automatically) or run `alembic stamp <current revision>` on an existing one; run `alembic upgrade head` before starting; change the passwords of the listed accounts.

Source: [`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md), [`apps/api/backend/core/registrar.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/core/registrar.py)

### `PermissionError: [Errno 13] Permission denied` while the container loads its config

**Cause**: the image runs as user `fba` (uid 1000), and the deploy check requires `.env.server` to be exactly mode `600`. If root owns the file, the permissions look fine on the host, but the process in the container can't read it. The error is raised deep inside pydantic-settings, so it is easy to mistake for a typo in the configuration.

**Fix**:

```bash
chown 1000:1000 .env.server
chmod 600       .env.server
```

Source: [`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)

### The API container is up, but its health check can never reach the database

**Cause**: the database or Redis runs on the host (as with the ones bundled with the BT/aaPanel control panel), and `.env.server` says `127.0.0.1`. On the container's bridge network, `127.0.0.1` is the container itself.

**Fix**: set `DATABASE_HOST` / `REDIS_HOST` to the host's address on the docker bridge (usually `172.17.0.1`; check with `ip addr show docker0`), or add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service and use `host.docker.internal`.

Source: [`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)

### `docker compose pull` hangs on a server in mainland China

**Cause**: GHCR is often throttled to a few dozen KB/s from mainland China. Nothing errors out; it looks stuck, but one layer takes hours.

**Fix**: set `FBA_PULL_MIRROR` (a mirror domain) in the `.env` next to the compose file. `prod.sh pull` then pulls from the mirror and retags the images back to `ghcr.io/…`. Don't put the mirror into the image names in the compose file. If the layer progress bars don't move for a few minutes, retry with another mirror.

Source: [`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)

### `/healthz` stays green while the API is down

**Cause**: `/healthz` is answered by the nginx inside the web container with a plain `return 200`; it only proves nginx is alive. Probing a path that doesn't exist through the domain is no better: the frontend's history fallback answers it with 200 and `index.html`.

**Fix**: point external monitoring only at `https://<domain>/api/health/status`. It reports api, database, Redis, scheduler and worker one by one, returning 200 when all are healthy and 503 when any one is not. Look at the response body, not just the status code.

Source: [`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md), [`deploy/README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/README.md)

### `Failed to fetch dynamically imported module` after a release

**Cause**: this isn't a server error but a version mismatch. The open browser tab is still running the old frontend, and the code chunk it wants to load no longer exists in the new deployment.

**Fix**: reload the page. The frontend recognizes this error and shows "A new version is available" with a reload button instead of a 500 page.

Source: [`apps/web/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/AGENTS.md)

### `Multiple artifacts named "github-pages" were unexpectedly found for this workflow run`

**Cause**: re-running a failed job in GitHub Actions runs another attempt under the same run ID. `upload-pages-artifact` creates a new `github-pages` artifact every time instead of replacing the previous attempt's, and `deploy-pages` exits with this error when it finds two with the same name.

**Fix**: delete this run's existing `github-pages` artifacts before uploading. The repository's CI `pages` job does exactly that (it needs the `actions: write` permission); copy that step if you deploy the docs site from a fork.

Source: [`.github/workflows/ci.yml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/.github/workflows/ci.yml) (`pages` job)

## Didn't find your problem?

Make sure you went through every step of the [quick start](/en/getting-started/quick-start/) and [deployment](/en/getting-started/deployment/) guides. If it still fails, open a [GitHub issue](https://github.com/yilecoding/fastapi-react-admin/issues) and paste the exact error text.

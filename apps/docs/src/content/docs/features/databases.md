---
title: "Databases: PostgreSQL, SQL Server, MySQL"
description: One FastAPI codebase and one Alembic migration chain for PostgreSQL (default), SQL Server and MySQL. Switch with DATABASE_TYPE; CI runs the full suite on two.
sidebar:
  order: 8
---

The backend runs on PostgreSQL, SQL Server or MySQL with the same models, the same Alembic migration chain and a seed file for each dialect. You choose one with `DATABASE_TYPE` in `apps/api/backend/.env`; PostgreSQL is the default. The backend is a fork of [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture) (FBA), which supports PostgreSQL and MySQL. SQL Server support was added in this fork, upstream declined to merge it, and so the fork is permanent.

## Which databases are supported, and how is each verified?

| | Driver | Local setup | Verification |
|---|---|---|---|
| **PostgreSQL** (default) | `asyncpg` | `docker compose -f docker-compose.dev.yml up -d` (PostgreSQL 16) | CI job `pytest · PostgreSQL`: full backend suite on every run, plus a migration step on an empty database |
| **SQL Server** | `aioodbc` + Microsoft ODBC Driver 18 | `--profile sqlserver` in the same compose file (SQL Server 2022) | CI job `pytest · SQL Server`: full backend suite; CI job `playwright · E2E`: the browser tests run against a SQL Server backend |
| **MySQL** | `asyncmy` | bring your own MySQL 8.x | **Not in CI.** Run by hand on 2026-10-31 (MySQL 8.4.13): 1,451 tests, 1,433 passed, 18 skipped, 0 failed |

That MySQL run also covered the upgrade path. A database created by v0.0.1's `fba init` was upgraded with `alembic upgrade head` through the whole chain, ending with 56 tables and no structural differences from the models (one comment differed).

:::note
SQL Server 2022 is the only version this repo has tested. Versions before 2016 differ in T-SQL (`OFFSET … FETCH`, filtered unique indexes); validate those yourself before relying on them.
:::

## How do I switch to SQL Server?

1. Start the container: `docker compose -f docker-compose.dev.yml --profile sqlserver up -d mssql`.
2. Install [Microsoft ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server) **on the host**. The backend connects through `aioodbc`, and the driver inside the container doesn't count. Without it, the database starts and the backend fails on its first connection with `Can't open lib ... ODBC Driver 18`.
3. Edit `apps/api/backend/.env`:

   ```ini
   DATABASE_TYPE='sqlserver'
   DATABASE_PORT=1433
   DATABASE_USER='sa'
   DATABASE_PASSWORD='...'          # MSSQL_SA_PASSWORD from docker-compose.dev.yml
   DATABASE_PK_MODE='snowflake'     # keep this, see below
   ```

4. Run `pnpm db:init`. It creates the `fba` database, builds the tables, loads `sql/sqlserver/init_snowflake_test_data.sql` and stamps Alembic at head.

`DATABASE_DRIVER` (default `ODBC Driver 18 for SQL Server`) must match a name listed by `odbcinst -q -d`. The production image (`apps/api/Dockerfile.prod`) installs `msodbcsql18`, so the same image serves all three databases. The worker and beat containers need it too: Celery's result backend connects via `mssql+pyodbc`.

## How do I switch to MySQL?

Set `DATABASE_TYPE='mysql'` and `DATABASE_PORT=3306`, point the host and user at your MySQL 8.x server, and run `pnpm db:init`. It creates the database with `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` (`DATABASE_CHARSET`, default `utf8mb4`).

:::caution
Keep `DATABASE_PK_MODE='snowflake'`. All three seed files exist only in the snowflake-ID form. With `autoincrement`, `fba init` finds no seed file and skips it without an error, so you end up with tables but no `admin` account. Also note that `pnpm db:init` drops and recreates the database.
:::

## What did SQL Server support require?

None of these problems show up on PostgreSQL, which is the local default. Only the `pytest · SQL Server` CI job catches them.

| Problem on SQL Server | What the code does |
|---|---|
| `VARCHAR` stores Chinese text by code page and garbles it | Text columns use `UniversalStr(n)` → `NVARCHAR(n)` and `UniversalText` → `NVARCHAR(MAX)`; it avoids `NTEXT`, which is deprecated |
| `OFFSET … FETCH` requires `ORDER BY` | Paginated queries always carry an explicit `ORDER BY` (`select_order`) |
| A `UNIQUE` constraint treats `NULL`s as equal, so a second user without an email is rejected | Filtered unique index on SQL Server only, e.g. `uk_sys_user_email_deleted` with `mssql_where='email IS NOT NULL'` |
| A table created *by a migration* gets an `IDENTITY` snowflake ID, so every insert fails with error 544 | `id_key` declares `autoincrement=False`, and a guard test scans `alembic/versions/` for `create_table` calls missing it |
| Making an indexed column `NOT NULL` is blocked (Msg 5074); the reverse is allowed | Downgrades drop the index, alter the column, then recreate the index |
| `alter_column(comment=…)` compiles to *adding* `MS_Description`, which fails if it exists | Migrations that backfill old changes are written to be idempotent |
| Raw `text()` with a timezone-aware datetime loses its offset through aioodbc/pyodbc (+08:00 is stored as +00:00) | Write time columns through Core/ORM so the `TimeZone` type binds them (the test suite follows this rule) |
| Seeding with `sqlcmd` fails with Msg 1934 because of the filtered index | `sqlcmd` runs with `-I` (`QUOTED_IDENTIFIER ON`) |

The connection URL uses `mssql+aioodbc` with `LongAsMax=Yes` so `NVARCHAR(MAX)` / `VARBINARY(MAX)` values aren't truncated.

## What do the other two dialects need?

- **PostgreSQL** aborts the whole transaction after one failed statement, so "try it, ignore if already applied" steps run inside a SAVEPOINT. On SQL Server, rolling back that SAVEPOINT fails, so the same step uses a plain `suppress`. `_tolerate_already_applied()` in the `c0000000comments` migration handles both. The PostgreSQL CI job runs `alembic upgrade c0000000comments` on an empty database to exercise that branch.
- **MySQL** `DATETIME` defaults to whole seconds. Recycle-bin restore finds the attachment links of "the same delete" by an equal `deleted_time`. At one-second precision, links removed by hand in that same second were re-attached too (issue #132). `TimeZone` now maps to `DATETIME(6)` on MySQL, and migration `q0000000mysqldt` upgrades existing columns. `MODIFY` redefines a whole column and would silently drop `NOT NULL` and comments, so the migration reads both from `information_schema` and writes them back.
- **Data migrations** never use dialect-specific upserts (`MERGE` / `ON CONFLICT` / `INSERT IGNORE`). They check for a row by business key (`sys_menu.name`, `sys_role.code`) before inserting. Seed IDs differ between dialects (PostgreSQL roles start at `4000000000000000…`, the other two at `3000000000000000…`).

## How do migrations work?

```bash
pnpm db:revision 'add xxx column'   # after changing a model (--autogenerate); read the file before committing
pnpm db:upgrade                      # upgrade to head
pnpm db:current                      # where this database is
pnpm db:history                      # the chain
```

A new database comes from `pnpm db:init` (create tables from the models, load the seed, `alembic stamp head`), not from replaying migrations. The baseline revision `b0000000baseline` is intentionally empty and the models stay the single source of truth, so the chain can't be replayed from an empty database. That is by design. In production, a one-shot `migrate` container runs `alembic upgrade head` before the API and workers start. With `ENVIRONMENT=prod` the app refuses to start unless the database is at head. See [Deployment](/getting-started/deployment/).

## How it is tested

Guards in [`app/task/tests/test_migrations.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tests/test_migrations.py):

| Test | Catches |
|---|---|
| `test_model_matches_migrations` | a model changed without a migration |
| `test_single_head` · `test_every_revision_is_reachable_from_base` | branched or broken chains |
| `test_fresh_database_is_stamped_at_head` | a new database that would replay old migrations later |
| `test_migrations_compile_offline_for_every_supported_dialect` | a migration that doesn't compile for one of the three dialects |
| `test_created_tables_declare_snowflake_pk_as_non_autoincrement` | the SQL Server `IDENTITY` trap above |
| `test_seed_files_have_a_matching_data_migration_decision` | seed SQL changed without a data migration for existing databases |

In [`backend/tests/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/tests), `test_seed_dialects.py` checks that the three seed files have the same tables, row counts and columns, and that link tables point at IDs that exist. `test_timezone_type.py` compiles the time-column DDL for all three dialects without connecting to MySQL.

## Where it lives in the code

- [`apps/api/backend/database/db.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/database/db.py): connection URL per dialect
- [`apps/api/backend/common/model.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/model.py): `UniversalStr`, `UniversalText`, `TimeZone`, `id_key`
- [`apps/api/backend/.env.example`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/.env.example) and `core/conf.py`: `DATABASE_*` settings
- [`apps/api/backend/sql/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/sql): one seed file per dialect
- [`apps/api/backend/alembic/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/alembic) and its [`AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md): migrations and every dialect pitfall with its evidence
- [`.github/workflows/ci.yml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/.github/workflows/ci.yml): the PostgreSQL, SQL Server and E2E jobs

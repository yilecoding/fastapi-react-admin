---
title: "数据库：PostgreSQL / SQL Server / MySQL"
description: 同一套代码、同一条 Alembic 迁移链支持 PostgreSQL（默认）、SQL Server、MySQL，改 DATABASE_TYPE 即可切换。
sidebar:
  order: 8
---

后端可以跑在 PostgreSQL、SQL Server 或 MySQL 上：模型是同一套，Alembic 迁移链是同一条，三种库各有一份初始数据。选哪个由 `apps/api/backend/.env` 里的 `DATABASE_TYPE` 决定，默认 PostgreSQL。后端 fork 自 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)（FBA），上游支持 PostgreSQL 和 MySQL。SQL Server 支持是本仓库加的，上游明确不合并，所以这是一次永久分叉。

## 支持哪几种库？各自验证到什么程度？

| | 驱动 | 本地怎么起 | 验证情况 |
|---|---|---|---|
| **PostgreSQL**（默认） | `asyncpg` | `docker compose -f docker-compose.dev.yml up -d`（PostgreSQL 16） | CI 的 `pytest · PostgreSQL` job：每次跑后端全套，外加一步空库上的迁移容错 |
| **SQL Server** | `aioodbc` + 微软 ODBC Driver 18 | 同一份 compose 的 `--profile sqlserver`（SQL Server 2022） | CI 的 `pytest · SQL Server` job 跑后端全套；`playwright · E2E` 的前端端到端测试也连 SQL Server |
| **MySQL** | `asyncmy` | 自备 MySQL 8.x | **不在 CI 里。** 2026-10-31 本地在 MySQL 8.4.13 上跑全套：1451 条，1433 过、18 跳过、0 红 |

同一次 MySQL 验证还走了升级路径：用 v0.0.1 的 `fba init` 建库，再拿当前代码 `alembic upgrade head` 把整条链走完。结果是 56 张表，和模型比对结构差异为 0（只剩 1 条注释差异）。

:::note
本仓库只实测过 SQL Server 2022。2016 以下的版本 T-SQL 有差异（`OFFSET … FETCH`、筛选唯一索引），要用的话先自己验一遍。
:::

## 怎么切到 SQL Server？

1. 起容器：`docker compose -f docker-compose.dev.yml --profile sqlserver up -d mssql`。
2. **在宿主机上**装 [Microsoft ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)。后端走 `aioodbc`，容器里的那份驱动不算数。不装的表现是：库起来了，后端一连就报 `Can't open lib ... ODBC Driver 18`。
3. 改 `apps/api/backend/.env`：

   ```ini
   DATABASE_TYPE='sqlserver'
   DATABASE_PORT=1433
   DATABASE_USER='sa'
   DATABASE_PASSWORD='...'          # 即 docker-compose.dev.yml 里的 MSSQL_SA_PASSWORD
   DATABASE_PK_MODE='snowflake'     # 保持不动，原因见下
   ```

4. 跑 `pnpm db:init`：建 `fba` 库、建表、灌 `sql/sqlserver/init_snowflake_test_data.sql`，最后把 Alembic 标到 head。

`DATABASE_DRIVER`（默认 `ODBC Driver 18 for SQL Server`）要和 `odbcinst -q -d` 列出来的名字一致。生产镜像 `apps/api/Dockerfile.prod` 里装了 `msodbcsql18`，所以三种库用的是同一个镜像。worker / beat 也离不开它：Celery 的 result backend 走的是 `mssql+pyodbc`。

## 怎么切到 MySQL？

把 `DATABASE_TYPE` 改成 `'mysql'`、`DATABASE_PORT` 改成 `3306`，主机和账号指向你的 MySQL 8.x，然后跑 `pnpm db:init`。建库语句是 `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`（字符集取 `DATABASE_CHARSET`，默认 `utf8mb4`）。

:::caution
`DATABASE_PK_MODE` 必须保持 `'snowflake'`。三种库的初始数据都只有雪花 ID 版本，改成 `autoincrement` 后 `fba init` 找不到种子文件，会**一声不响地跳过**：表建好了，`admin` 账号却没有。另外，`pnpm db:init` 会先删库再重建。
:::

## 支持 SQL Server 要解决哪些问题？

下面这些在本地默认的 PostgreSQL 上都测不出来，只有 CI 的 `pytest · SQL Server` 能拦住。

| SQL Server 上的问题 | 代码里的做法 |
|---|---|
| `VARCHAR` 按代码页存中文，会截断或乱码 | 存中文的列用 `UniversalStr(n)` → `NVARCHAR(n)`，长文本用 `UniversalText` → `NVARCHAR(MAX)`（不用已废弃的 `NTEXT`） |
| `OFFSET … FETCH` 强制要求 `ORDER BY` | 分页查询一律显式带 `ORDER BY`（`select_order`） |
| `UNIQUE` 约束把多个 `NULL` 视为相等，第二个不填邮箱的用户会被拒绝 | 仅在 SQL Server 下改用筛选唯一索引，如 `uk_sys_user_email_deleted` 带 `mssql_where='email IS NOT NULL'` |
| **迁移**建出来的表，雪花主键会变成 `IDENTITY`，任何 INSERT 都报 544 | `id_key` 显式写 `autoincrement=False`，另有守卫测试扫描 `alembic/versions/` 里的 `create_table` |
| 被索引的列改成 `NOT NULL` 会被挡住（Msg 5074），反方向放行 | downgrade 先删索引、改列、再重建索引 |
| `alter_column(comment=…)` 被编译成**新增** `MS_Description`，已存在就报错 | 「补历史遗留」类的迁移一律写成幂等的 |
| 用裸 `text()` 写带时区的时间，aioodbc/pyodbc 会丢掉偏移（+08:00 存成 +00:00） | 时间列走 Core / ORM 写入，由 `TimeZone` 类型负责绑定（测试套件也守这条） |
| 用 `sqlcmd` 灌种子时，因为有筛选索引而报 Msg 1934 | `sqlcmd` 加 `-I`（`QUOTED_IDENTIFIER ON`） |

连接串是 `mssql+aioodbc`，带 `LongAsMax=Yes`，保证 `NVARCHAR(MAX)` / `VARBINARY(MAX)` 不被截断。

## 另外两种库要注意什么？

- **PostgreSQL** 里一条语句失败，整个事务就作废了。所以「执行，已经做过就忽略」这类迁移步骤要包在 SAVEPOINT 里。到了 SQL Server，回滚 SAVEPOINT 反而会失败，只能用普通的 `suppress`。`c0000000comments` 迁移里的 `_tolerate_already_applied()` 两边都照顾到了。PostgreSQL 那个 CI job 会在空库上跑 `alembic upgrade c0000000comments`，专门把这条分支走一遍。
- **MySQL** 的 `DATETIME` 默认只精确到秒。回收站「还原」按 `deleted_time` 相等来认「同一次删除」解开的关联，精度只到秒时，同一秒内手动移除的附件也被挂了回去（issue #132）。现在 `TimeZone` 在 MySQL 上映射为 `DATETIME(6)`，已有的库由迁移 `q0000000mysqldt` 升上来。`MODIFY` 会把整列重新定义，没写上的 `NOT NULL` 和注释会被静默丢掉，所以这条迁移先从 `information_schema` 读出可空性和注释，再原样写回去。
- **数据迁移**不用任何方言专属的 upsert（`MERGE` / `ON CONFLICT` / `INSERT IGNORE`），而是先按业务键（`sys_menu.name`、`sys_role.code`）查一遍在不在，再决定插不插。三种库的种子 ID 本来就不同（PostgreSQL 的角色在 `4000000000000000…` 段，另两个在 `3000000000000000…` 段）。

## 迁移怎么用？

```bash
pnpm db:revision '加 xxx 列'   # 改完模型生成迁移（--autogenerate），提交前要读一遍
pnpm db:upgrade                # 升到 head
pnpm db:current                # 当前库在哪个版本
pnpm db:history                # 看整条链
```

新库走 `pnpm db:init`（按模型建表、灌种子、`alembic stamp head`），不靠重放迁移。基线 `b0000000baseline` 刻意是空的，唯一的真相源仍然是模型，所以整条链**不能**从空库重放，这是设计如此。生产上由一次性的 `migrate` 容器先跑 `alembic upgrade head`，跑完才起 API 和 worker。`ENVIRONMENT=prod` 时，库不在 head 应用就拒绝启动。详见[部署](/getting-started/deployment/)。

## 有哪些开关？

数据库连接只在 `.env` 里配，改完重启后端和 worker（模板见 [`.env.example`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/.env.example)）：

| 键 | `.env.example` 里的值 | 说明 |
|---|---|---|
| `DATABASE_TYPE` | `postgresql` | `postgresql` / `sqlserver` / `mysql` |
| `DATABASE_HOST` · `DATABASE_PORT` | `127.0.0.1` · `5432` | SQL Server 是 1433，MySQL 是 3306 |
| `DATABASE_USER` · `DATABASE_PASSWORD` | `postgres` · `postgres` | 生产环境的弱密码会被启动检查拒绝 |
| `DATABASE_SCHEMA` | `fba`（`conf.py` 默认） | 库名；跑测试、拍截图时换一个就是一套隔离的库 |
| `DATABASE_PK_MODE` | `snowflake` | **必须是 `snowflake`**。`conf.py` 里的默认值是 `autoincrement`，但三种库的种子数据只有雪花版，用自增的话 `fba init` 找不到种子文件会静默跳过，库建好了却没有 admin 账号 |
| `DATABASE_DRIVER` | `ODBC Driver 18 for SQL Server` | 只对 SQL Server 生效，要和 `odbcinst -q -d` 列出的名字一致 |
| `DATABASE_TRUST_SERVER_CERTIFICATE` | `true` | 只对 SQL Server 生效 |
| `DATABASE_CHARSET` | `utf8mb4` | 只对 MySQL 生效 |
| `DATABASE_SOURCES` | `{}` | 额外的数据源，如 `{"read": "postgresql+asyncpg://…"}`；名字不能是空或 `default` |
| `DATABASE_ECHO` · `DATABASE_POOL_ECHO` | `false` | 打印 SQL / 连接池日志，排查时临时打开 |

## 怎么测的

[`app/task/tests/test_migrations.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tests/test_migrations.py) 里的守卫：

| 测试 | 挡什么 |
|---|---|
| `test_model_matches_migrations` | 改了模型却没生成迁移 |
| `test_single_head` · `test_every_revision_is_reachable_from_base` | 迁移链分叉或断链 |
| `test_fresh_database_is_stamped_at_head` | 新库没 stamp，日后会把旧迁移重跑一遍 |
| `test_migrations_compile_offline_for_every_supported_dialect` | 某条迁移在三种方言之一上编译不过 |
| `test_created_tables_declare_snowflake_pk_as_non_autoincrement` | 上面那个 SQL Server `IDENTITY` 坑 |
| `test_seed_files_have_a_matching_data_migration_decision` | 改了种子 SQL，却没给已有的库补数据迁移 |

[`backend/tests/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/tests) 下，`test_seed_dialects.py` 核对三份种子的表、每张表的行数和列清单一致，并检查关联表引用的 ID 确实存在。`test_timezone_type.py` 为三种方言编译时间列的 DDL，不需要连 MySQL。

## 代码在哪

- [`apps/api/backend/database/db.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/database/db.py)：按方言拼连接串
- [`apps/api/backend/common/model.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/model.py)：`UniversalStr`、`UniversalText`、`TimeZone`、`id_key`
- [`apps/api/backend/.env.example`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/.env.example) 与 `core/conf.py`：`DATABASE_*` 配置
- [`apps/api/backend/sql/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/sql)：每种方言一份种子
- [`apps/api/backend/alembic/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/alembic) 及其 [`AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)：迁移，以及每个方言坑的实测证据
- [`.github/workflows/ci.yml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/.github/workflows/ci.yml)：PostgreSQL、SQL Server、E2E 三个 job

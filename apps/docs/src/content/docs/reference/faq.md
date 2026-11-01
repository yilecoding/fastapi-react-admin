---
title: 常见问题
description: 按报错原文排的排障清单：本地起服务、登录、数据库迁移、前端开发和生产部署里最常撞到的 25 个问题，各附原因、处理和出处。
sidebar:
  order: 1
---

把终端或浏览器里的报错原文复制下来，用 Ctrl+F 或站内搜索在本页查找；每条都写了原因、处理办法，以及记录这条结论的源码笔记。

## 安装与本地启动

### `Port 8888 is already in use`

**原因**：前端端口固定在 8888，`apps/web/vite.config.ts` 里写了 `strictPort: true`。端口被占时 Vite 直接退出，不会自己换到 8889，因为后端的 CORS 白名单、OAuth2 回跳地址和桌面端开发脚本都写死了 8888。

**处理**：找出占着 8888 的进程（常见的是上一次没退干净的 `pnpm dev`），关掉后重新起。如果确实要换端口，四处要一起改：`vite.config.ts`、`backend/core/conf.py` 的 `CORS_ALLOWED_ORIGINS`、`backend/plugin/oauth2/plugin.toml` 里两条 `OAUTH2_FRONTEND_*_REDIRECT_URI`、`apps/desktop/scripts/dev.mjs` 的 `DEV_SERVER_URL` 默认值。

```bash
lsof -i :8888     # 看是谁占着
```

出处：[`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md)「本地起服务」一节

### `Can't open lib 'ODBC Driver 18 for SQL Server'`

**原因**：切到 SQL Server 后，后端通过 `aioodbc` 连库，用的是**宿主机**上的 ODBC 驱动。SQL Server 容器里自带的那份驱动不算数，所以容器起来了，后端一连库就报这一句。

**处理**：在跑后端的机器上装 [Microsoft ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)。`.env` 里的 `DATABASE_DRIVER`（默认 `ODBC Driver 18 for SQL Server`）要和下面这条命令列出的名字完全一致。生产镜像 `apps/api/Dockerfile.prod` 已经装了 `msodbcsql18`，worker / beat 用的也是这个镜像。

```bash
odbcinst -q -d
```

出处：[`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)「换数据库 / 接对象存储」、[`apps/api/Dockerfile.prod`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/Dockerfile.prod)

### `Login failed for user 'sa'`（SQL Server 错误 18456）

**原因**：`.env` 里的 `DATABASE_PASSWORD` 和 SQL Server 实例的实际密码对不上。最常见的情况是改了 `docker-compose.dev.yml` 里的 `MSSQL_SA_PASSWORD`：SQL Server 用了持久化卷，已经初始化过的实例不会跟着改密码。

**处理**：让 `DATABASE_PASSWORD` 和实例当前的 sa 密码一致；确实想用新密码，就删掉那个数据卷，让实例重新初始化。`pnpm db:init` 撞到这个错误时会打印「数据库登录失败：…（SQL Server 错误 18456）」。

出处：[`apps/api/backend/cli.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/cli.py)（`_format_database_connection_error`）

### 拉了新代码后 `pnpm test` / `pnpm db:upgrade` 报 `ModuleNotFoundError`，但 `pnpm dev` 跑得起来

**原因**：Python 依赖归 `uv` 管，`pnpm install` 不会装它们。`dev`、`db:init`、`db:reset` 用的是裸 `uv run`，会自动同步依赖；`test`、`test:db`、`db:upgrade`、`e2e:server`、`celery:*` 带了 `--no-sync`，缺包就直接报错。所以 `pnpm dev` 能跑，不代表依赖已经装齐。

**处理**：`pyproject.toml` 变了以后同步一次依赖。

```bash
pnpm --filter api exec uv sync     # 或者 pnpm install:all
```

出处：[`apps/api/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/AGENTS.md)「`pnpm install` 补不了后端依赖」

### worker 日志里出现 `Received unregistered task of type '…'`，自己的任务时有时无

**原因**：Celery broker 默认用 Redis 的 1 号库（`CELERY_BROKER_REDIS_DATABASE=1`）。本机另一个项目的 Celery 也用同一个 Redis 的 1 号库时，两边的 worker 消费的是同一个队列：对方的任务被这边收走，报「未注册」；这边的任务被对方收走，悄无声息地丢了。

**处理**：在本地 `.env` 里把 `CELERY_BROKER_REDIS_DATABASE` 改成一个空库，然后重启 worker。改之前先确认那个库确实没人在用：

```bash
docker exec fba_redis redis-cli -n 7 DBSIZE    # 返回 0 才是空库
```

出处：[`apps/api/backend/app/task/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/AGENTS.md)「Redis 和别的项目共用时，broker 要换一个没人用的库」

## 登录与会话

### 用 `http://localhost:8888` 能登录，一刷新页面就回到登录页

**原因**：前端默认直接请求 `http://127.0.0.1:8088`（`packages/platform/src/api-client/client.ts` 的 `API_BASE`）。从 `localhost` 打开页面时，那是一次跨站请求，浏览器不会保存刷新令牌的 cookie。登录本身能成功，但整页刷新后 `/auth/refresh` 返回 401，就被送回了登录页。

**处理**：本地开发打开 <http://127.0.0.1:8888>，不要用 `localhost:8888`。

出处：[`apps/docs/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/docs/AGENTS.md)「截图怎么重拍」

### `pnpm db:init` 之后用 `admin` / `123456` 登录不上

**原因**：`fba init` 灌完种子后，会强制把 admin 的默认密码 `123456` 换掉：在终端里运行会提示你输入新密码；非交互环境（`--auto`、CI、没有 TTY）读环境变量 `FBA_INIT_ADMIN_PASSWORD`，两者都没有就直接失败。种子里的示例账号 `test` 也会被停用，并换成随机密码。

**处理**：用初始化时设置的那个密码登录。非交互初始化这样写：

```bash
FBA_INIT_ADMIN_PASSWORD='<强口令>' pnpm db:reset
```

`123456` 只在 pytest / E2E 用的 `fba_test` 测试库里有效，那个库由 `pnpm --filter api test:db` 单独建。

出处：[`apps/api/backend/cli.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/cli.py)（`_set_admin_password`）

### 登录提示 `请求过于频繁，请稍后重试`（HTTP 429）

**原因**：登录相关接口按「IP + 路径」限流，每分钟 5 次；验证码接口 `/auth/captcha` 是每 30 秒 5 次。连续输错、或者写脚本连续登录多个账号，很快就会撞上。响应头里的 `Retry-After` 是要等待的秒数。

**处理**：等一会儿再试。触发限流的那次失败不会换验证码，因为验证码还没被消费，继续用当前这张就行。本地批量造数据时可以临时用 `REQUEST_LIMITER_ENABLED=false` 启动后端（生产环境会拒绝这个配置）。

出处：[`apps/docs/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/docs/AGENTS.md)「截图怎么重拍」、[`apps/api/backend/app/admin/api/v1/auth/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/api/v1/auth/auth.py)

### `.env` 里设了 `LOGIN_CAPTCHA_ENABLED=false`，登录页还是要验证码

**原因**：这个开关在运行时以数据库 `sys_config` 表里的值为准。种子数据里有一条 `LOGIN_CAPTCHA_ENABLED`，后端加载后会覆盖 `.env` 里的值。

**处理**：到「系统管理 → 参数配置」里把 `LOGIN_CAPTCHA_ENABLED` 改成 `false`，改完立即生效。要照常输入验证码的话，可以记下 `GET /api/v1/auth/captcha` 响应里的 `uuid`，到 Redis 里查答案：

```bash
docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"
```

出处：[`apps/web/e2e/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/AGENTS.md)「验证码不能只靠 `.env.e2e` 关」、[`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)「本地开发」

## 数据库与迁移

### `pnpm db:init` 之后原来的数据全没了

**原因**：`pnpm db:init`（即 `fba init`）会先 `drop_all` 再 `create_all`，然后灌种子数据并把 Alembic 标到 head。它是给全新环境用的，执行前会让你确认（默认是 `n`）。

**处理**：只在首次搭环境或确实想清空数据时运行它。已有的库要更新表结构，用迁移：

```bash
pnpm db:upgrade
```

出处：[`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)、[`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)

### `种子数据里没有 admin 账号，初始化流程可能已经变了`

**原因**：`DATABASE_PK_MODE` 不是 `'snowflake'`。三种数据库的种子 SQL 都只有雪花 ID 版本（`init_snowflake_test_data.sql`），自增模式下找不到种子文件，这一步会被跳过，没有任何提示，于是库里没有 admin 账号，初始化在最后设置管理员密码时失败。注意 `core/conf.py` 里这个配置的默认值是 `'autoincrement'`，`.env` 漏写这一行时同样会踩到。

**处理**：在 `apps/api/backend/.env` 里写上 `DATABASE_PK_MODE='snowflake'`（`.env.example` 里已经有这一行），然后重新运行 `pnpm db:init`。

出处：[`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)「换数据库 / 接对象存储」、[`apps/api/backend/cli.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/cli.py)

### 改了模型，后端也自动重启了，可表结构没变

**原因**：`pnpm dev` 里的 `--reload` 只会重启进程、重新 import 模型，不会改已经存在的表。

**处理**：改完模型就生成迁移，读一遍生成的文件，然后升级：

```bash
pnpm db:revision '加 xxx 列'
pnpm db:upgrade
```

如果改的是字段，还要同步 `backend/sql/*/init_snowflake_test_data.sql`。那些是写了显式列名的 INSERT，漏改会让全新环境初始化失败。

出处：[`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md)「数据库结构改动一律走 alembic」、[`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)

### `Cannot insert explicit value for identity column in table '…' when IDENTITY_INSERT is set to OFF. (544)`

**原因**：这个错误只出现在 SQL Server 上，并且只出现在**由迁移建出来的表**上。Alembic autogenerate 渲染不出模型里 Python 侧的 `default=snowflake.generate`，写出来的 id 列被 SQL Server 建成了 `IDENTITY`，之后任何 INSERT 都会失败。用 `create_all` 建的表不会这样，所以开发库和测试库都看不出问题。

**处理**：手写或生成建表迁移时，雪花主键列要显式加上 `autoincrement=False`。仓库里的守卫测试 `test_created_tables_declare_snowflake_pk_as_non_autoincrement` 会扫描 `alembic/versions/` 里的 `create_table` 检查这一点。

出处：[`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)「迁移建表时雪花主键会变成 IDENTITY」

### 第一次跑 pytest 或 E2E 就报数据库连接错误

**原因**：两套测试都跑在独立的 `fba_test` 库上，不用开发库 `fba`。这个库要先手工建一次，没建的时候报的只是一句 SQLAlchemy 连接错误，看不出原因。

**处理**：先建一个空的 `fba_test` 库（`CREATE DATABASE` 要在别的库上执行，脚本不替你做），再让脚本建表、灌种子：

```bash
docker exec fba_postgres createdb -U postgres fba_test   # 默认的 PostgreSQL；只需一次
pnpm --filter api test:db     # 按模型重建表、灌种子，并 stamp 到 head
pnpm test
```

模型加了列以后，测试报 `Invalid column name …` 之类的错，也是重跑一次 `test:db`。

出处：[`apps/api/backend/tests/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/tests/AGENTS.md)、[`CONTRIBUTING.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)「几个容易卡住的地方」

## 前端开发

### ID `2049629108245233664` 变成了 `2049629108245233700`，更新或删除改错了记录

**原因**：雪花 ID 大约是 2^61，超过了 JavaScript 的 `Number.MAX_SAFE_INTEGER`（2^53-1）。一旦当数字解析，就会丢失精度，连续几个 ID 甚至会变成同一个值，拿它回传就会命中别的记录。路由参数也会出这个问题：TanStack Router 默认对 search 值做 `JSON.parse`。

**处理**：所有 ID 一律当字符串处理，永远不要 `Number()`。后端在 `backend/utils/serializers.py` 里已经把它们转成字符串下发；路由那边由 `apps/web/src/lib/search-params.ts` 拦住超出安全范围的纯整数。新增带 ID 的 search 参数前，先确认这个自定义解析还接在 `router.ts` 上。

出处：[`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md) 硬纪律 6

### `pnpm e2e -- tests/xxx.spec.ts` 只想跑一个文件，结果跑了全部用例

**原因**：pnpm 会把 `--` 原样传给 Playwright，后面的文件名和参数全被忽略，于是跑的是全套（十几分钟），看起来只像是「这个文件好慢」。

**处理**：去掉 `--`，在 `apps/web` 目录下运行：

```bash
cd apps/web && pnpm e2e tests/dept-crud.spec.ts
```

出处：[`apps/web/e2e/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/AGENTS.md)

### 文档站构建报 `Node.js v22.23.3 is not supported by Astro!`

**原因**：文档站（`apps/docs`）锁在 Astro 7.3.x。`astro@7.4.4` 要求 Node ≥ 22.23.4，而仓库 `engines` 写的是 ≥ 22.13。如果依赖被升到了 7.4（比如跑了 `pnpm update`），在较老的 Node 22 上就会报这一句。`pnpm build` 会经 turbo 构建文档站，所以整仓构建也会挂。

**处理**：回到锁文件里的版本（`pnpm install --frozen-lockfile`），或者把 Node 升到 22.23.4 以上。要正式升级 Astro，得先在根 `package.json` 的 `engines` 和 CI 的 Node 版本上做决定。

出处：[`apps/docs/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/docs/AGENTS.md)「Astro 锁在 7.3.x」

## 部署与运维

### `ENVIRONMENT=prod，但有 N 项配置不合格，拒绝启动`

**原因**：`ENVIRONMENT=prod` 时后端启动前会校验配置，不合格就拒绝启动。检查项包括：`TOKEN_SECRET_KEY`、`DATABASE_PASSWORD`、`REDIS_PASSWORD` 的强度；`LOGIN_CAPTCHA_ENABLED` 和 `REQUEST_LIMITER_ENABLED` 必须为 true；`CORS_ALLOWED_ORIGINS` 不能包含 `*`、`localhost`、`127.0.0.1`；`DATABASE_USER` 不能是 `sa`、`root`、`postgres` 这类超级用户。

**处理**：按报错里逐条列出的问题改 `.env.server`。签名密钥可以这样生成：

```bash
python -c "import secrets;print(secrets.token_urlsafe(32))"
```

出处：[`apps/api/backend/core/conf.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/core/conf.py)

### `ENVIRONMENT=prod，数据库检查未通过，拒绝启动`

**原因**：生产环境的后端不会自己建表，启动时会检查数据库，有三种情况会被拦下：

- `数据库里没有 alembic_version 表`：库是 `create_all` 建的，但没有 stamp；
- `数据库迁移版本 … 不等于 head`：部署新版本前没跑迁移；
- `这些账号仍在使用种子数据里的默认密码（123456）`：绕过 `fba init` 直接灌了种子 SQL。

**处理**：分别对应：用 `fba init` 建库（它会自动 stamp head），或对已有库 `alembic stamp <当前版本>`；先跑 `alembic upgrade head` 再启动；把列出的账号的密码改掉。

出处：[`apps/api/backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)、[`apps/api/backend/core/registrar.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/core/registrar.py)

### 容器里加载配置时报 `PermissionError: [Errno 13] Permission denied`

**原因**：镜像里的进程以 `fba` 用户（uid 1000）运行，而部署检查要求 `.env.server` 的权限严格是 `600`。文件属主是 root 时，宿主机上看权限没问题，容器里却读不到它。这个报错出在 pydantic-settings 内部，很容易被当成配置内容写错了。

**处理**：

```bash
chown 1000:1000 .env.server
chmod 600       .env.server
```

出处：[`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)「`.env.server` 属主必须是 uid 1000」

### API 容器起来了，健康检查一直连不上数据库

**原因**：数据库或 Redis 跑在宿主机上（宝塔面板自带的就是这种），而 `.env.server` 里写的是 `127.0.0.1`。在容器的桥接网络里，`127.0.0.1` 指向的是容器自己。

**处理**：`DATABASE_HOST` / `REDIS_HOST` 填宿主机在 docker 网桥上的地址（一般是 `172.17.0.1`，可以用 `ip addr show docker0` 查），或者给服务加上 `extra_hosts: ["host.docker.internal:host-gateway"]`，再填 `host.docker.internal`。

出处：[`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)「容器连宿主机上的数据库，不能填 127.0.0.1」

### 国内服务器上 `docker compose pull` 卡住不动

**原因**：GHCR 在国内经常被限速到每秒几十 KB。不会报错，看着像卡住了，其实是一层镜像要下好几个小时。

**处理**：在 compose 同级的 `.env` 里配置 `FBA_PULL_MIRROR`（加速器域名），`prod.sh pull` 会从加速器拉，再 retag 回 `ghcr.io/…`。不要把加速器地址直接写进 compose 的镜像名。层进度条几分钟都不动，就换一个加速器域名重试。

出处：[`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)「GHCR 在国内会被限速到几十 KB/s」

### `/healthz` 一直是绿的，但 API 其实已经挂了

**原因**：`/healthz` 是 web 容器里的 nginx 自己 `return 200`，只能证明 nginx 还活着。经域名去探一个不存在的路径，也会被前端的 history fallback 接住，返回 200 加 `index.html`。

**处理**：外部监控只探 `https://<域名>/api/health/status`。它会逐项列出 api、数据库、Redis、调度器、worker 的状态，全部正常返回 200，任何一项异常返回 503。判断前看一眼响应 body，不要只看状态码。

出处：[`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)「健康检查」、[`deploy/README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/README.md)「外部监控探哪几条」

### 发版后页面报 `Failed to fetch dynamically imported module`

**原因**：这不是服务器错误，而是前后版本不一致。浏览器里开着的还是旧版前端，它要加载的代码分片在新部署里已经不存在了。

**处理**：刷新页面即可。前端已经识别这类错误，会显示「已发布新版本」和一个刷新按钮，不再显示成 500。

出处：[`apps/web/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/AGENTS.md)「错误页分两支」

### `Multiple artifacts named "github-pages" were unexpectedly found for this workflow run`

**原因**：在 GitHub Actions 里「重跑失败的 job」时，同一个 run 会再跑一次 attempt。`upload-pages-artifact` 每次都会新建一个名为 `github-pages` 的 artifact，不会覆盖上一次留下的那份，`deploy-pages` 读到两份同名的就报错退出。

**处理**：上传之前，先把本次 run 里同名的旧 artifact 删掉。仓库 CI 的 `pages` job 就是这么做的（需要 `actions: write` 权限），fork 后自己部署文档站可以照抄那一步。

出处：[`.github/workflows/ci.yml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/.github/workflows/ci.yml)（`pages` job）

## 没找到你的问题？

先看[快速开始](/getting-started/quick-start/)和[部署到服务器](/getting-started/deployment/)的步骤是否都走过；仍然不行，到 [GitHub Issues](https://github.com/yilecoding/fastapi-react-admin/issues) 贴上报错原文。

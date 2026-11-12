---
title: 快速开始
description: 用 Docker 启动 PostgreSQL 和 Redis，安装依赖、初始化开发库，再登录本地工作台。每一步都有检查方法。
sidebar:
  order: 1
---

跟着下面四步，在本地打开工作台。默认使用 PostgreSQL 和 Redis，同时启动 API、网页和 Celery worker。

**执行目录：仓库根目录**，也就是包含 `pnpm-workspace.yaml` 的目录。下文命令都在这里运行。

<span id="需要装什么"></span>

## 开始前准备什么？

| 工具 | 要求 |
|---|---|
| Node.js | ≥ 22.13；pnpm 版本由 `package.json` 锁定，通过 Corepack 安装 |
| Python | ≥ 3.11，并安装 [uv](https://docs.astral.sh/uv/) |
| Docker | Docker 服务已启动，能运行 `docker compose` |

<span id="怎么跑起来"></span>

## 1. 启动数据库和 Redis

```bash
docker compose -f docker-compose.dev.yml up -d
```

检查容器状态：

```bash
docker compose -f docker-compose.dev.yml ps
```

**看到什么算成功：** `fba_postgres` 和 `fba_redis` 都显示 `healthy`。首次启动需要等健康检查完成，再继续下一步。

## 2. 安装依赖，准备配置

```bash
pnpm install:all
```

这会安装 JavaScript 和 Python 依赖、Git 钩子以及 Playwright Chromium。**命令无报错结束，且生成 `apps/api/.venv` 目录后，依赖就准备好了。**

复制后端配置；已有 `.env` 时保留原文件：

```bash
cp -n apps/api/backend/.env.example apps/api/backend/.env
```

新复制的默认配置与上面的容器一致。已有配置时，请核对其中的数据库和 Redis 连接信息。

保持 `DATABASE_PK_MODE='snowflake'`：当前种子数据使用雪花 ID，改成自增模式或漏掉这一行，会导致初始化找不到 admin 账号。

## 3. 初始化开发库

:::caution[先确认目标库可以清空]
`pnpm db:init` 会删除并重建配置指向的**整个数据库**。执行前检查 `apps/api/backend/.env` 中的连接信息和 `DATABASE_SCHEMA`（示例值为 `fba`），以及终端里是否设置了覆盖它们的环境变量。已有数据需要保留时，先备份，并使用 `pnpm db:upgrade` 升级结构。
:::

```bash
pnpm db:init
```

按提示确认目标库，并给 `admin` 设置新密码，记下这个密码。初始化也会停用示例账号 `test`；自动化环境通过 `FBA_INIT_ADMIN_PASSWORD` 提供密码。

**看到什么算成功：** 最后出现「已把新库标记到迁移 head」。再检查迁移版本：

```bash
pnpm db:current
```

输出的版本应带有 `(head)`。

<span id="每一步怎么算成功"></span>

## 4. 启动并登录

```bash
pnpm dev
```

保持终端运行，在浏览器打开 <http://127.0.0.1:8888>。

:::note[本地访问地址]
请使用 `127.0.0.1:8888`。默认 API 地址是 `127.0.0.1:8088`；从 `localhost:8888` 访问会被浏览器视为跨站请求，无法保存刷新令牌的 cookie，刷新页面后会回到登录页。
:::

按顺序检查：

1. 登录页显示验证码图片，说明前后端已经连通（默认配置下验证码开启）。
2. 用 `admin` 和**初始化时设置的密码**登录，进入工作台。
3. 刷新页面，仍然保持登录。

完成这三项，本地环境就可以用了。下次启动只需确认容器在运行，再执行 `pnpm dev`。

## 常见问题

<details>
<summary>为什么 admin / 123456 登录失败？</summary>

本地使用的是初始化时设置的密码。`admin` / `123456` 只用于[在线演示](https://fra.wubunan.com/sign-in)，初始化不允许保留种子数据里的默认密码。

</details>

<span id="登录页为什么要输验证码"></span>

<details>
<summary>本地开发能关闭验证码吗？</summary>

可以。登录后到「系统管理 → 参数配置」，将 `LOGIN_CAPTCHA_ENABLED` 改为 `false`，立即生效。数据库配置可能覆盖 `.env`，详见[验证码配置排查](/reference/faq/#env-里设了-login_captcha_enabledfalse登录页还是要验证码)。

调试时也可以用 `GET /api/v1/auth/captcha` 响应的 `uuid` 查询 Redis 中的答案：

```bash
docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"
```

</details>

<span id="各个进程在哪"></span>

<details>
<summary>各服务使用什么端口？8888 被占用怎么办？</summary>

| 服务 | 端口 | 启动方式 |
|---|---|---|
| FastAPI（uvicorn，自动重载） | 8088 | `pnpm dev` |
| React（Vite） | 8888 | `pnpm dev` |
| Celery worker（内嵌 beat） | — | `pnpm dev` |
| PostgreSQL / Redis | 5432 / 6380 | `docker compose` |

前端固定使用 8888：CORS、OAuth2 回调和桌面端开发地址都与它对应。被占用时 Vite 会直接报错；请先确认占用进程，再决定是否停止。其他启动报错可按原文搜索[常见问题](/reference/faq/)。

</details>

<span id="换成-sql-servermysql-或-s3"></span>

<details>
<summary>可以换用 SQL Server、MySQL 或 S3 吗？</summary>

可以。下面是可选服务的启动方式，数据库切换还需修改 `.env` 中的 `DATABASE_*`。

| 服务 | 准备方式 |
|---|---|
| SQL Server | `docker compose -f docker-compose.dev.yml --profile sqlserver up -d mssql`；宿主机还需安装 [ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server) |
| MySQL | 自备 MySQL 8.x，设置 `DATABASE_TYPE='mysql'`，字符集用 `utf8mb4` |
| S3 兼容存储（RustFS） | `docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs`；在存储管理中添加前先设置 `STORAGE_ENCRYPT_SECRET_KEY`（可用 `openssl rand -hex 32` 生成） |

继续阅读[数据库](/features/databases/)和[文件存储](/features/file-storage/)。

</details>

## 接下来

- [功能总览](/features/overview/)：了解系统能做什么。
- [登录与安全](/features/login-security/)：设置密码策略和二次验证。
- [部署](/getting-started/deployment/)：用现成镜像部署到服务器。
- [参与开发](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)：测试、分支和发版流程。

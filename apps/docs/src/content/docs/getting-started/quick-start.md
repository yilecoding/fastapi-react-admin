---
title: 快速开始
description: 在本地跑起 fastapi-react-admin：Docker 起 PostgreSQL 和 Redis，五条命令，打开 localhost:8888 用 admin / 123456 登录。
sidebar:
  order: 1
---

五条命令在本地起全套：Docker 里的 PostgreSQL 和 Redis、8088 端口的 FastAPI 后端、8888 端口的 React 前端，外加一个 Celery worker。账号 `admin` / `123456`。

## 需要装什么

- Node.js ≥ 22.13（pnpm 版本由 `package.json` 锁定，corepack 会自动装）
- Python ≥ 3.10 和 [uv](https://docs.astral.sh/uv/)
- Docker

## 怎么跑起来

```bash
docker compose -f docker-compose.dev.yml up -d          # PostgreSQL 16 + Redis
pnpm install:all                                        # JS 依赖、Python 依赖、git 钩子、Playwright Chromium
cp apps/api/backend/.env.example apps/api/backend/.env  # 默认值已经和上面的容器对齐
pnpm db:init                                            # 建表 + 灌种子数据（只在首次跑）
pnpm dev                                                # api :8088 · web :8888 · celery worker
```

打开 <http://localhost:8888>，用 `admin` / `123456` 登录。

:::caution
`pnpm db:init` 会 DROP 并重建所有表，只在首次搭环境或想清空数据时跑；之后的表结构变化一律走 `pnpm db:upgrade`（Alembic）。
:::

## 登录页为什么要输验证码

图形验证码默认开启。本地想省掉，在「系统管理 → 参数配置」里把 `LOGIN_CAPTCHA_ENABLED` 改成 `false`，改完立即生效。想照常输入的话，先记下 `GET /api/v1/auth/captcha` 响应里的 `uuid`，再去 Redis 里查答案：

```bash
docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"
```

## 换成 SQL Server、MySQL 或 S3

可选的依赖都在同一份 `docker-compose.dev.yml` 里，按需打开，再改 `.env` 里的 `DATABASE_*`：

| 要用 | 命令 | 备注 |
|---|---|---|
| **SQL Server** | `docker compose -f docker-compose.dev.yml --profile sqlserver up -d mssql` | 宿主机还要装 [Microsoft ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)——后端走 `aioodbc` 连库，容器里那份驱动不算 |
| **MySQL** | 自备 MySQL 8.x | `DATABASE_TYPE='mysql'`，字符集用 `utf8mb4` |
| **S3 兼容存储**（RustFS） | `docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs` | 在「系统管理 → 存储管理」里新建存储前，`.env` 里要先配 `STORAGE_ENCRYPT_SECRET_KEY`（`openssl rand -hex 32`） |

:::caution
`DATABASE_PK_MODE` 保持默认的 `'snowflake'`。种子数据只有雪花 ID 版，改成自增模式后初始化会**静默跳过**种子——表建好了，却没有 admin 账号。
:::

三种数据库各自怎么支持、怎么测，见[数据库](/features/databases/)。

## 各个进程在哪

| 进程 | 端口 | 由谁启动 |
|---|---|---|
| FastAPI 后端（uvicorn，`--reload`） | 8088 | `pnpm dev` |
| React 前端（Vite） | 8888（固定，`strictPort`） | `pnpm dev` |
| Celery worker（内嵌 beat） | — | `pnpm dev` |
| PostgreSQL / Redis | 5432 / 6380 | `docker compose` |

前端端口是刻意固定的：CORS、OAuth2 回调地址、桌面端的开发地址都写的是 8888，所以端口被占时 Vite 直接报错，而不是漂到 8889。

## 接下来

- [功能总览](/features/overview/)——能在上面做什么。
- [部署](/getting-started/deployment/)——用现成的镜像部署到服务器。
- [CONTRIBUTING.md](https://github.com/yilecoding/fastapi-react-admin/blob/main/CONTRIBUTING.md)——测试、分支模型和发版流程。

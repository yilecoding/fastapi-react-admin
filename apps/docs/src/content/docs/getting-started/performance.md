---
title: 性能与容量
description: 实测：生产镜像默认的 2 个 worker，在带完整鉴权、权限和审计的读接口上约 190 次请求/秒、p95 约 70 毫秒，并发 64 零失败。怎么换算成能支撑多少人、怎么扩容、怎么自己复测。
---

生产镜像默认起 2 个 API worker。实测在 12 个常用读接口混合的负载下，它每秒处理约 **190 次请求**，95% 的请求在 **70 毫秒**内返回；把同时在途的请求加到 64 个，也**没有一个失败**，只是排队变长。单个 worker 吃满一个 CPU 核约 110 次/秒，容量靠加 worker 和 CPU 核扩。

这些数字是在一台笔记本上测的，不是生产服务器基准。下面写清楚了测试条件、怎么换算成用户数，以及怎么在你自己的机器上复测。

## 实测能跑多快？

每个请求走的都是完整链路，没有为压测关掉任何东西：JWT 验签、Redis 里核对会话、按权限码判 RBAC、按数据范围过滤行、查库、序列化，再记一条操作日志（GET 也记）。

| API worker 数         | 单个请求       | 最佳吞吐（并发 8）                | 并发 64                               |
| --------------------- | -------------- | --------------------------------- | ------------------------------------- |
| 1                     | p50 16–19 毫秒 | 113–119 次/秒，p95 92–98 毫秒     | 96–100 次/秒，p95 约 1.1 秒，0 失败   |
| **2（生产镜像默认）** | p50 15 毫秒    | **186–195 次/秒，p95 68–69 毫秒** | 157–172 次/秒，p95 0.8–0.9 秒，0 失败 |

每组跑两轮，表里是两轮的范围。四组共 20 档，**失败率全部为 0**，服务端日志里没有一条错误。

「并发」是同时在途的请求数，不是在线人数。并发超过 worker 的处理能力之后，多出来的请求排队等待：吞吐不再上涨，延迟变长。实测到并发 64 为止没有请求失败；再往上，排队时间超过客户端或连接池的等待上限时就会开始失败。

## 「每秒 190 次请求」能支撑多少人？

先分清两种用户：

- **在线但没在操作的人，几乎不占后端。** 浏览器每 5 分钟发一次心跳，而且只在用户有操作时才发；新消息走 WebSocket 推送，不轮询；检查新版本读的是 nginx 上的静态文件，不经过 API。
- **压力来自正在操作的人。** 打开一个页面、搜索一次、翻一页，都会触发几个接口请求。

所以容量按「同时在操作的人」估算：

> 需要的请求数/秒 ≈ 同时在操作的人数 × 每人每秒的请求数

举个例子，**下面的数是假设，不是实测**：如果一次操作带 3–5 个请求，熟练用户每 10–30 秒操作一次，每人每秒大约 0.1–0.5 次请求。照这个算，默认的 2 个 worker（约 190 次/秒，p95 约 70 毫秒）大约够 **400–1900 人同时操作**。

你们的使用习惯不一样，结果也会不一样。最准的办法是上线前用真实数据量，按[下面的方法](#怎么自己测)测一次。

## 不够用了怎么扩容？

**加 worker 或加副本。** 一个 worker 吃满一个 CPU 核时约 110 次/秒。实测 1 个 worker 到 2 个 worker，吞吐从约 116 涨到约 190 次/秒。这台机器是大小核混合、又跑在 WSL2 里，更多 worker 的扩展效果测不准，要用核心同构的服务器测。

**加 worker 之前先算数据库连接。** 每个进程最多占 `DATABASE_POOL_SIZE + DATABASE_POOL_MAX_OVERFLOW` 个连接（默认 10 + 20）。API worker 数加上 Celery worker 进程数，乘上这个数，不能超过数据库的 `max_connections`。实测在连接上限 100 的 PostgreSQL 上开 8 个 worker，高峰期报 `too many clients`，有请求失败。部署时的检查项见[上线前检查清单](/getting-started/deployment/#上线前检查清单)。

**超出能力时先排队，不是立刻报错。** 实测到并发 64 为止，2 个 worker 的 p95 约 0.9 秒，失败数为 0。这只说明在测过的范围内是平稳变慢，不代表能无限排队。

<details>
<summary>这些数字是在什么条件下测的？</summary>

- **代码**：`main` 上的后端，`uvicorn --workers N`，不带 `--reload`。和 [`Dockerfile.prod`](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/Dockerfile.prod) 的启动方式一致（默认 `--workers 2`），没有经过 nginx。
- **账号**：一个**普通用户**（部门经理角色，授予了全部菜单，带部门数据范围）。超级管理员会跳过权限判断，用它压测会把数字测得偏好看。
- **接口**：用户列表、角色列表、部门树、菜单树、侧边栏、当前用户、权限码、字典、参数配置、未读通知数、通知列表、文件统计，按日常使用频率加权混合，全是 GET。
- **数据量**：`fba init` 灌的种子数据（10 个用户、162 个菜单）。
- **依赖**：PostgreSQL 16 和 Redis 7，跑在同一台机器的 Docker 里。
- **连接池探活**：测试时是开着的（当时的默认值）。现在默认关，每个请求少 3 次数据库往返，实际数字会比表里略好。
- **机器**：Intel Core Ultra 9 285H 笔记本，WSL2。压测程序和服务在同一台机器上。

原始记录在 [`scripts/AGENTS.md`](https://github.com/yile2020/fastapi-react-admin/blob/main/scripts/AGENTS.md) 的「文档站『性能与容量』页的数字出处」一节。

</details>

## 怎么自己测？

仓库里带了压测脚本，只用后端自带的依赖：

```bash
pnpm loadtest --base-url http://127.0.0.1:8088/api/v1 --username <普通用户> --password <密码> --stages 1,8,16,32,64 -d 20
```

- 默认地址是本机 `pnpm dev` 起的 8088；测生产形态时用不带 `--reload` 的 `uvicorn --workers N` 起服务，再把 `--base-url` 指过去。
- 只发 GET，不往库里写业务数据（登录和操作日志除外）。目标不是本机地址时必须加 `--allow-remote`。**不要压生产环境。**
- 开头那行会打印对方自报的服务名和版本。先确认是 `fastapi-react-admin`，本机端口上常有别的项目在跑。
- 用一个**普通用户**压，权限给齐。超级管理员走的代码路径不一样。
- 登录接口限流每分钟 5 次，脚本只登录一次，之后复用 token。验证码开着时加 `--redis-container <Redis 容器名>`，从 Redis 读答案。
- 同一台机器上的其他程序会让结果抖动 ±10%。比较两个版本时多跑几轮。

## 它不保证什么

- **不是生产服务器基准。** 换一台机器、换一个数据库，数字都会变。
- **只测了读接口。** 导出、导入、AI 对话、文件上传这类重操作没有测。
- **数据量是种子数据。** 大表上的列表查询快不快，取决于数据库配置和索引。
- **没有经过 nginx 和网络。** 真实部署还要加上反向代理和网络的耗时。

## 代码在哪

- 压测脚本：[`scripts/loadtest.py`](https://github.com/yile2020/fastapi-react-admin/blob/main/scripts/loadtest.py)；对照服务：[`scripts/loadtest_baseline.py`](https://github.com/yile2020/fastapi-react-admin/blob/main/scripts/loadtest_baseline.py)
- 测试记录和测量方法：[`scripts/AGENTS.md`](https://github.com/yile2020/fastapi-react-admin/blob/main/scripts/AGENTS.md)
- 连接池配置：[`database/db.py`](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/database/db.py)、[`core/conf.py`](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/core/conf.py)
- 中间件：[`middleware/`](https://github.com/yile2020/fastapi-react-admin/tree/main/apps/api/backend/middleware)

<div align="center">

<img src="./apps/web/public/favicon.svg" width="88" alt="fastapi-react-admin">

# fastapi-react-admin

**开箱即用的中后台底座 · FastAPI + React 19 + shadcn/ui**

权限细到数据行 · 多页签真保状态 · 飞书式审批 · 不越权的 AI 助手 · S3 存储与断点续传 · Web / 桌面 / 移动三端

[在线演示](https://fra.wubunan.com/sign-in) · [快速开始](#快速开始) · [功能一览](#功能一览) · [更新记录](https://github.com/yilecoding/fastapi-react-admin/releases) · [English](./README.en.md)

[![Release](https://img.shields.io/github/v/release/yilecoding/fastapi-react-admin?style=flat-square)](https://github.com/yilecoding/fastapi-react-admin/releases)
[![CI](https://github.com/yilecoding/fastapi-react-admin/actions/workflows/ci.yml/badge.svg)](https://github.com/yilecoding/fastapi-react-admin/actions/workflows/ci.yml)
[![E2E 报告](https://img.shields.io/badge/E2E_报告-Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://yilecoding.github.io/fastapi-react-admin/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

> 🚀 在线演示账号 `admin` / `123456` —— 公开实例，任何人都能登录，数据会被访客改动或清空，请勿存放真实信息。

<table>
<tr>
<td width="50%"><img src="./docs/screenshots/dashboard.png" alt="仪表盘"></td>
<td width="50%"><img src="./docs/screenshots/dept.png" alt="部门管理：两级组织架构"></td>
</tr>
<tr>
<td width="50%"><img src="./docs/screenshots/role.png" alt="角色管理：功能权限矩阵"></td>
<td width="50%"><img src="./docs/screenshots/data-permission.png" alt="数据权限：行级过滤规则"></td>
</tr>
<tr>
<td width="50%"><img src="./docs/screenshots/workflow-inbox.png" alt="审批中心：待办 · 进度"></td>
<td width="50%"><img src="./docs/screenshots/workflow-designer.png" alt="审批设计器：表单 + 流程树"></td>
</tr>
</table>

## ✨ 为什么选它

- **权限细到「能看到哪些行」** —— 菜单、按钮之外还有数据范围：同一张用户表，部门经理只看得到自己部门的人。
  规则配在模型的列上，配错了界面会直接提示
- **多页签切走不丢状态** —— 基于 React 19 的 `<Activity>`：填了一半的表单、翻到的页码、展开的树，切回来都还在；
  视图状态写进 URL，刷新也不丢
- **审批流开箱即用** —— 飞书式表单设计器 + 流程树，或签 / 会签、退回、加签、拿回、超时自动处理都有
- **AI 助手不会越权** —— 它能做的事 = 当前登录的人能做的事；写操作先预演、本人确认才执行，全程留审计。
  外部系统还能通过 MCP 网关调用同一套能力
- **大文件也好传** —— 本地盘或 S3 兼容存储，秒传、分片并发、刷新后断点续传，右下角一个上传浮窗看全部进度
- **数据库三选一** —— PostgreSQL、SQL Server、MySQL，同一套代码
- **不止网页** —— Electron 桌面端（三平台安装包 + 自动更新）和原生移动 App
- **质量有底** —— 850+ 条测试打真实数据库和真实浏览器，CI 上后端全套在 PostgreSQL 和 SQL Server 各跑一遍

## 和常见模板的区别

| | 常见做法 | 这里 |
|---|---|---|
| **权限粒度** | 菜单 + 按钮 | 菜单 + 按钮 + **数据范围**，角色决定能看到哪些**行** |
| **多页签** | Vue 靠 `keep-alive` 白送；React 侧大多没有，或者切走就丢状态 | React 19 **`<Activity>`**：已开的页签同时挂载，切走保留 DOM 与状态 |
| **组件基座** | 多数还停在 shadcn 迁移前的 Radix 版本 | 已跟进 shadcn 现在的默认底座 **Base UI**（`@radix-ui` 零引用），附可直接抄代码的组件沙箱 |
| **数据库** | 通常只支持一种 | **三选一**：PostgreSQL（默认）· SQL Server · MySQL |
| **业务能力** | 用户 / 角色 / 菜单 | 另有审批流、AI 助手、开放接口、文件与存储、消息与定时任务 |
| **测试** | 大多不带，带的也多停在组件单测 + mock | 后端 838 条 + 前端 93 条端到端测试，**打真实依赖，不 mock** |

## 功能一览

| 模块 | 能做什么 |
|---|---|
| **权限与组织** | RBAC（菜单 / 按钮 / 数据范围）· 行级数据权限 · 部门树 · 用户与角色 |
| **导入导出** | 服务端导出 xlsx / csv（按当前筛选或勾选的行 · 大批量转后台、完成发站内消息 · 防公式注入）· 通用导入（带下拉的模板 · 预览校验 · 只新增 / 新增并更新 / 只更新 · 错误报告 · 全部成功才导入）· 一份文件建整棵部门树 |
| **登录与安全** | 图形验证码 · 失败锁定 · 密码历史与过期 · OAuth2（GitHub / Google）· 在线会话强制下线 |
| **工作区** | 多页签（固定 / 拖拽 / 重新加载）· 命令面板 ⌘K · 快捷键 · 功能引导 · 列表列显隐与拖拽排序（写进地址栏）· 主题色 / 圆角 / 页签外观 · 每人自己的时区 · 中英双语 |
| **文件与存储** | 文件管理器 + 在线预览（pdf / docx / xlsx / 图片 / 压缩包）· 本地 + S3 兼容存储 · 预签名直连下载 · 回收站 · 秒传 · 分片上传与断点续传 · 可嵌进任何页面的附件面板 |
| **审批流** | 表单设计器 · 流程树（审批 / 抄送 / 条件分支）· 同意 / 驳回 / 转交 / 退回 / 拿回 / 加签 · 超时提醒与自动处理 · 草稿 · 加急 · 离职交接 |
| **AI 助手** | 整页对话 + 侧滑抽屉 · 受权限与数据范围约束的工具调用 · 写操作预演 + 确认 · 调用审计 · MCP 网关 |
| **能力开放** | AK/SK 签名的开放接口 · scope / IP 白名单 / 防重放 / 限流 · 调用日志 · 增量同步 · Python / Node / Java SDK |
| **消息与任务** | 站内消息（实时推送）· 通知公告（富文本 + 附件）· 定时任务（在线调度 · cron 预览 · 执行记录） |
| **运维** | 参数配置 · 数据字典 · 登录 / 操作日志（自动脱敏）· 服务器与 Redis 监控 · 发新版提示 |
| **多端** | Electron 桌面端（静默打印 · 本地硬件 · 自动更新）· Expo 原生移动 App（不是 WebView 套壳） |
| **开发者** | 组件沙箱（每个组件可调、可抄）· 调色盘 · 由 OpenAPI 生成的类型安全前后端契约 |

## 技术栈

| | |
|---|---|
| **前端** | React 19 · TypeScript 6 · Vite 8 · TanStack Router / Query / Table v9 · Tailwind CSS 4 · shadcn/ui（Base UI）· zustand · Tiptap 3 · i18next |
| **后端** | FastAPI · Pydantic 2 · SQLAlchemy 2（async）· Alembic · Redis · Celery · Socket.IO · Apache OpenDAL · pydantic-ai |
| **数据库** | PostgreSQL · SQL Server · MySQL |
| **多端** | Electron 42 · Expo 57 / React Native 0.86 |
| **工程** | pnpm + turbo 单仓 · uv · ruff · pytest · Playwright · GitHub Actions |

## 数据库：三选一

改 `.env` 里的 `DATABASE_TYPE` 就能换，同一套代码、同一条迁移链，三种库各有一份初始数据。

| | 适合 | 验证情况 |
|---|---|---|
| **PostgreSQL**（默认） | 新项目首选，本地 `docker compose up` 就有 | CI 每次跑后端全套 |
| **SQL Server** | 已有微软技术栈的企业 | CI 每次跑后端全套 + 前端端到端 |
| **MySQL** | 已有 MySQL 运维的团队 | 不在 CI 里，按需本地跑全套；最近一次（2026-10-23）全部通过 |

## 快速开始

需要 Node ≥ 22.13、Python ≥ 3.10、[uv](https://docs.astral.sh/uv/) 和 Docker。

```bash
docker compose -f docker-compose.dev.yml up -d          # PostgreSQL + Redis
pnpm install:all                                        # 前后端依赖
cp apps/api/backend/.env.example apps/api/backend/.env  # 默认配置已对齐上面的容器
pnpm db:init                                            # 建表 + 初始数据（首次）
pnpm dev                                                # 打开 http://localhost:8888
```

账号 `admin` / `123456`。换 SQL Server / MySQL、接 S3、跳过验证码、跑测试，见[本地开发指南](./CONTRIBUTING.md#本地开发)。

部署到服务器：`main` 每次通过 CI 都会构建好镜像，服务器上 `bash prod.sh pull && bash prod.sh up` 即可更新，见 [`deploy/README.md`](./deploy/README.md)。

## 质量

后端 767 条 pytest 打真实数据库和 Redis，前端 89 条 Playwright 打真实浏览器、真实接口和真实库 —— **不 mock**。
数据权限是拿 41 个真账号逐个登录验证出来的；关键防线都做过变异检验（故意把代码改坏，确认测试会红）。
`main` 每次跑完的 [E2E 报告](https://yilecoding.github.io/fastapi-react-admin/) 都公开，失败用例带截图和录像。

## 文档

| 想做什么 | 看这里 |
|---|---|
| 本地开发、跑测试、提 PR、发版 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 了解工程约定和踩过的坑 | [CLAUDE.md](./CLAUDE.md) —— 按任务导航，40 多份模块分册，每条结论都带实测证据 |
| 部署到服务器 | [deploy/README.md](./deploy/README.md) |
| 桌面端 | [apps/desktop/README.md](./apps/desktop/README.md) |
| 对接开放接口 | [apps/api/backend/plugin/open/README.md](./apps/api/backend/plugin/open/README.md) |
| 把组件库搬进别的项目 | [packages/ui/PORTING.md](./packages/ui/PORTING.md) |
| 安全须知 | [SECURITY.md](./SECURITY.md) |

## 许可

[MIT](./LICENSE)

## 致谢

后端最初基于 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)（FBA）构建，
三层结构、插件机制、RBAC 与数据权限模型都来自它的设计。感谢 FBA 的作者和贡献者 🙏
上游同为 MIT，原始版权声明保留在 [`apps/api/LICENSE`](./apps/api/LICENSE)。

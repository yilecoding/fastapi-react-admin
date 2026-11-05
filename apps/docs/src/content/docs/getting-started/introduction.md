---
title: fastapi-react-admin 是什么
description: 基于 FastAPI + React 19 + shadcn/ui 的开源中后台底座：Web、桌面、手机三端同一个 monorepo，为和 AI 一起写代码而设计；为什么做它，以及它和常见后台模板的区别。
sidebar:
  order: 0
---

fastapi-react-admin 是一个开源（MIT）的中后台底座：后端 FastAPI，前端 React 19 + shadcn/ui，内部系统迟早要做的那些东西都已经做好了——用户、角色、部门、行级数据权限、审批、文件、消息通知、定时任务、AI 助手。拿去之后在上面写自己的业务页面。

## 为什么在 AI 时代还要做一个后台底座？

因为 AI 让内部系统的需求变多了，而每个系统开头都在重复同一批活。以前排不上队的小工具现在值得做，跑了多年的老系统也该重做了——可登录、权限、组织架构、审批、文件、通知，每次都要从头再来一遍。

这个项目源于公司里几套 Java + Vue 2 小系统的重构（Vue 2 已于 2023 年底停止维护）。没有在旧架构上修补，而是换成 FastAPI + React 19、全部用最新的稳定版本从头搭起，再把每次都要重做的部分沉淀成这个底座：**下一个系统，拉下来就写业务。**

## 一个仓库里有什么？

Web 管理后台、Electron 桌面端、Expo 原生手机 App、后端和文档站，都在同一个 pnpm + turbo monorepo 里，一次 `pnpm install:all` 装好，`pnpm dev` 一条命令起前后端。

```
apps/
├── api          FastAPI 后端（+ Celery worker）
├── web          管理后台 · React 19
├── desktop      Electron 桌面端 · 三平台安装包 · 自动更新 · 静默打印 · 接本地硬件
├── mobile       Expo 原生 App · 不是 WebView 套壳（预览版）
└── docs         文档站 · Astro
packages/        依赖严格单向：i18n / api ← ui ← platform ← web
├── api          由后端 OpenAPI 生成的类型契约 —— web 与手机共用
├── i18n         中英文案 —— web 与手机共用
├── ui           shadcn 组件库 · 零业务 · 可整包搬进别的项目
└── platform     权限 · 多页签 · 业务页面 —— 桌面端直接复用
```

- **桌面端不重写业务。** Electron 外壳装的就是 `apps/web` 的构建产物，外壳只补浏览器做不到的事：静默打印、读卡器等本地硬件、自动更新；后端地址是运行期配置，同一个安装包能发到不同环境。详见[桌面端与移动端](/features/clients/)。
- **手机端是原生 App。** Expo / React Native 单独写界面，接口契约（`@admin/api`）和语言包（`@admin/i18n`）与 web 共用，后端改了字段，两边在类型检查时一起报错。
- **分层有闸门。** 依赖方向写进各包的 `package.json`，`pnpm arch:check` 在 CI 里核对，反向 import 当场变红。

## 为什么说它适合和 AI 一起写代码？

因为 AI 改代码快，而这里每一处改动都有东西兜着：

- **测试兜得住。** AI 一次改十几个文件很常见，靠人手点一遍点不过来。后端 1400+ 条 pytest 连真实数据库和 Redis，前端 150+ 条 Playwright 打真实浏览器，不 mock，CI 每次全跑；失败的用例带截图和录像（[E2E 报告](https://yilecoding.github.io/fastapi-react-admin/e2e/)公开）。
- **契约对不上，编译就不过。** 前后端类型由后端的 OpenAPI 生成（`packages/api/src/schema.d.ts`），AI 改了接口没改页面，`pnpm typecheck` 直接报出来。
- **规矩按目录写给 AI 看。** 仓库里 50 多份 `CLAUDE.md` / `AGENTS.md` 记着实测出来的坑和硬纪律，AI 编码助手改到哪个目录就读到哪一份。
- **后端就在 AI 生态里。** Python + FastAPI，内置的 AI 助手基于 pydantic-ai，接模型、做工具调用不用跨语言。

## 适合谁用

- 要做企业内部系统（OA、ERP 式后台、运营管理台），后端想用 Python、前端想用 React 的团队。
- 已经在用微软技术栈的团队：SQL Server 在这里是一等公民，每次 CI 都和 PostgreSQL 一起跑全量测试。
- 权限要求不止「这个角色能打开哪些菜单」的团队——比如部门经理只能看到本部门的数据。
- 同一套业务要同时出 Web、桌面和手机的团队：桌面端复用 web 页面，手机端共用接口契约和语言包，不用维护三份。
- 正在用 AI 编码助手、又怕它把东西改坏的团队。

## 和常见的后台模板有什么不同

| | 常见模板 | fastapi-react-admin |
|---|---|---|
| **权限粒度** | 菜单 + 按钮 | 菜单 + 按钮 + **数据范围**——角色决定一个人能看到**哪几行** |
| **多页签** | Vue 有 `keep-alive` 天然支持；React 模板大多没有，或者切走就丢状态 | React 19 **`<Activity>`**：打开的页签一直挂载，DOM 和状态切换后都还在 |
| **组件底座** | 多数还停在 shadcn 旧的 Radix 版本 | 已经是 shadcn 现在默认的 **Base UI**（零 `@radix-ui` 引用），另有一个能直接复制代码的组件沙箱 |
| **数据库** | 通常只支持一种 | **三选一**：PostgreSQL（默认）· SQL Server · MySQL |
| **业务功能** | 用户 / 角色 / 菜单 | 另有审批流、AI 助手、开放平台、文件与存储、消息通知、定时任务 |
| **测试** | 大多没有，或者只有带 mock 的组件单测 | 后端 1400+ 条、端到端浏览器 150+ 条，**连真实依赖，不用 mock** |

## 用了哪些技术

| | |
|---|---|
| **前端** | React 19 · TypeScript 6 · Vite 8 · TanStack Router / Query / Table v9 · Tailwind CSS 4 · shadcn/ui（Base UI）· zustand · Tiptap 3 · i18next |
| **后端** | FastAPI · Pydantic 2 · SQLAlchemy 2（异步）· Alembic · Redis · Celery · Socket.IO · Apache OpenDAL · pydantic-ai |
| **数据库** | PostgreSQL · SQL Server · MySQL |
| **客户端** | Electron 桌面端 · Expo / React Native 移动端 |
| **工程** | pnpm + turbo monorepo · uv · ruff · pytest · Playwright · GitHub Actions |

## 它不是什么

- **不是低代码平台。** 业务页面用 React 写，接口用 FastAPI 写；底座提供的是外壳、权限模型和公共组件。
- **不是托管服务。** 需要自己部署，见[部署](/getting-started/deployment/)。
- **不是一次性的脚手架。** 1.0 起按 semver 发版，开放接口、Webhook、数据库迁移链、插件接口、配置键都有兼容承诺；升级前先看[更新记录](https://github.com/yilecoding/fastapi-react-admin/releases)。

## 从哪来的

后端最初 fork 自 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)（FBA）。三层结构（`api → service → crud`）、插件机制、RBAC 与数据权限模型都是 FBA 的设计，FBA 的版权声明保留在 [`apps/api/LICENSE`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/LICENSE)。SQL Server 支持是本项目加的，上游明确不合并这部分，所以是永久分叉，只 cherry-pick 上游的安全补丁。

前端、桌面端和移动端，以及大部分业务功能（审批、AI 助手、开放平台、文件存储、消息渠道路由）是本项目自己写的。

## 下一步

- [快速开始](/getting-started/quick-start/)——五条命令在本地跑起来。
- [功能总览](/features/overview/)——按领域列出所有功能。
- [在线演示](https://fra.wubunan.com/sign-in)——`admin` / `123456`。

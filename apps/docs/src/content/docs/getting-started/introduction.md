---
title: fastapi-react-admin 是什么
description: 基于 FastAPI + React 19 + shadcn/ui 的开源中后台底座：Web、桌面、手机三端同一个 monorepo，为和 AI 一起写代码而设计；为什么做它，以及它和常见后台模板的区别。
sidebar:
  order: 0
---

fastapi-react-admin 是一个开源（MIT）的中后台底座：后端 FastAPI，前端 React 19 + shadcn/ui，内部系统迟早要做的那些东西都已经做好了——用户、角色、部门、行级数据权限、审批、文件、消息通知、定时任务、AI 助手。拿去之后在上面写自己的业务页面。

## 为什么在 AI 时代还要做一个后台底座？

因为 AI 让要做的系统变多了，而每个新系统开头都在重复同一批活。排不上队的小工具值得做了，跑了多年的老系统也该换了——可登录、权限、组织架构、审批、文件、通知，每次都得从头再来。

这个项目起步于公司里几套 Java + Vue 2 小系统的重构。我们没有在旧架构上修补，而是用 FastAPI + React 19 从头搭了一遍，再把每次都要重做的部分沉淀成底座：**下一个系统，从写业务开始。**

## 一个仓库里有什么？

后端、Web 管理后台、桌面端模板、移动端模板和文档站，都在同一个 pnpm + turbo monorepo 里：`pnpm install:all` 一次装好，`pnpm dev` 一条命令起前后端。

```
apps/
├── api        后端 · FastAPI + Celery
├── web        Web 管理后台 · React 19
├── desktop    桌面端模板 · Electron
├── mobile     移动端模板 · Expo / React Native
└── docs       文档站 · Astro
packages/      依赖单向：i18n / api ← ui ← platform ← web
├── api        前后端类型契约，由 OpenAPI 生成
├── i18n       中英文案
├── ui         组件库，不含业务，可整包带走
└── platform   权限、多页签、业务页面
```

- **Web 管理后台**是主体，开箱即用。
- **桌面端模板**直接加载 Web 的构建产物，只补浏览器做不到的事：静默打印、本地硬件、自动更新。见[桌面端与移动端](/features/clients/)。
- **移动端模板**是原生界面，和 Web 共用接口类型（`@admin/api`）与语言包（`@admin/i18n`）。
- **分层有约束。** 依赖严格单向，写在各包的 `package.json` 里，`pnpm arch:check` 在 CI 里把关。

## 为什么说它适合和 AI 一起写代码？

因为 AI 改代码很快，而这里每一处改动都有东西兜底：

- **测试兜底。** AI 一次改十几个文件很常见，人工点一遍点不过来。后端 1400+ 条 pytest 连真实数据库和 Redis，前端 150+ 条 Playwright 跑真实浏览器，不用 mock，CI 每次全量跑；失败的用例带截图和录像，[E2E 报告](https://yilecoding.github.io/fastapi-react-admin/e2e/)公开。
- **类型兜底。** 前后端契约由后端的 OpenAPI 生成（`packages/api/src/schema.d.ts`）。移动端的每个请求都从它推断类型，接口改了而页面没跟上，`pnpm typecheck` 直接报错；网页端还在迁移，请求的返回类型目前在各调用点手写（见[开发者工具](/features/developer-tools/#前后端契约是怎么来的)）。
- **规矩写给 AI 看。** 仓库里 50 多份按目录拆分的 `CLAUDE.md` / `AGENTS.md` 记着实测踩过的坑和硬纪律，编码助手改到哪个目录，就读到哪一份。
- **后端就在 AI 生态里。** Python + FastAPI，内置的 AI 助手基于 pydantic-ai。

## 适合谁用

- 要做企业内部系统（OA、ERP 式后台、运营管理台），后端想用 Python、前端想用 React 的团队。
- 已经在用微软技术栈的团队：SQL Server 在这里是一等公民，每次 CI 都和 PostgreSQL 一起跑全量测试。
- 权限要求不止「这个角色能打开哪些菜单」的团队——比如部门经理只能看到本部门的数据。
- 除了 Web 还要出桌面端或手机端的团队：两个模板已经接好登录、接口类型和语言包，从模板起步，不用从零搭。
- 在用 AI 编码助手、又担心它把东西改坏的团队。

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

- [DeepWiki 项目解析](https://deepwiki.com/yilecoding/fastapi-react-admin) —— 通过 AI 对话快速了解仓库结构和代码。

- [快速开始](/getting-started/quick-start/)——五条命令在本地跑起来。
- [功能总览](/features/overview/)——按领域列出所有功能。
- [在线演示](https://fra.wubunan.com/sign-in)——`admin` / `123456`。

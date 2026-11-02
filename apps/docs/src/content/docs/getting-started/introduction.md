---
title: fastapi-react-admin 是什么
description: 基于 FastAPI + React 19 + shadcn/ui 的开源中后台底座，适合做企业内部系统；以及它和常见后台模板的区别。
sidebar:
  order: 0
---

fastapi-react-admin 是一个开源（MIT）的中后台底座：后端 FastAPI，前端 React 19 + shadcn/ui，内部系统迟早要做的那些东西都已经做好了——用户、角色、部门、行级数据权限、审批、文件、消息通知、定时任务、AI 助手。拿去之后在上面写自己的业务页面。

## 适合谁用

- 要做企业内部系统（OA、ERP 式后台、运营管理台），后端想用 Python、前端想用 React 的团队。
- 已经在用微软技术栈的团队：SQL Server 在这里是一等公民，每次 CI 都和 PostgreSQL 一起跑全量测试。
- 权限要求不止「这个角色能打开哪些菜单」的团队——比如部门经理只能看到本部门的数据。

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
- **还没到 1.0。** 目前发的是 0.x 版本，升级前先看[更新记录](https://github.com/yilecoding/fastapi-react-admin/releases)。

## 从哪来的

后端最初 fork 自 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)（FBA）。三层结构（`api → service → crud`）、插件机制、RBAC 与数据权限模型都是 FBA 的设计，FBA 的版权声明保留在 [`apps/api/LICENSE`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/LICENSE)。SQL Server 支持是本项目加的，上游明确不合并这部分，所以是永久分叉，只 cherry-pick 上游的安全补丁。

前端、桌面端和移动端，以及大部分业务功能（审批、AI 助手、开放平台、文件存储、消息渠道路由）是本项目自己写的。

## 下一步

- [快速开始](/getting-started/quick-start/)——五条命令在本地跑起来。
- [功能总览](/features/overview/)——按领域列出所有功能。
- [在线演示](https://fra.wubunan.com/sign-in)——`admin` / `123456`。

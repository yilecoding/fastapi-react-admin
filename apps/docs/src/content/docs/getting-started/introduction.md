---
title: What is fastapi-react-admin?
description: An open-source admin foundation on FastAPI + React 19 + shadcn/ui for internal and back-office systems, and how it differs from a typical admin template.
sidebar:
  order: 0
---

fastapi-react-admin is an open-source (MIT) foundation for building admin and back-office systems: a FastAPI backend, a React 19 frontend on shadcn/ui, and the parts most internal systems end up needing — users, roles, departments, row-level data permissions, approvals, files, notifications, scheduled jobs and an AI assistant. You clone it and build your own business pages on top.

## Who is it for?

- Teams building an internal system (OA, ERP-style back office, operations console) who want Python on the backend and React on the frontend.
- Teams on the Microsoft stack: SQL Server is a first-class database here, tested in CI on every run alongside PostgreSQL.
- Teams that need permissions finer than "which menus can this role open" — for example, a manager should only see their own department's records.

## How does it differ from a typical admin template?

| | Typical template | fastapi-react-admin |
|---|---|---|
| **Permission granularity** | menus + buttons | menus + buttons + **data scopes** — the role decides which **rows** a user sees |
| **Multi-tab** | free with Vue's `keep-alive`; most React templates don't have it, or lose state when you switch away | React 19 **`<Activity>`**: open tabs stay mounted, DOM and state survive switching |
| **Component base** | most are still on shadcn's older Radix version | **Base UI**, shadcn's current default (zero `@radix-ui` imports), plus a component sandbox to copy code from |
| **Database** | usually one | **pick one of three**: PostgreSQL (default) · SQL Server · MySQL |
| **Business features** | users / roles / menus | plus approval workflow, AI assistant, open API, files & storage, messaging and scheduled jobs |
| **Tests** | mostly none, or component unit tests with mocks | 1,400+ backend + 150+ end-to-end browser tests, **against real dependencies, no mocks** |

## What is it built with?

| | |
|---|---|
| **Frontend** | React 19 · TypeScript 6 · Vite 8 · TanStack Router / Query / Table v9 · Tailwind CSS 4 · shadcn/ui (Base UI) · zustand · Tiptap 3 · i18next |
| **Backend** | FastAPI · Pydantic 2 · SQLAlchemy 2 (async) · Alembic · Redis · Celery · Socket.IO · Apache OpenDAL · pydantic-ai |
| **Databases** | PostgreSQL · SQL Server · MySQL |
| **Clients** | Electron desktop app · Expo / React Native mobile app |
| **Tooling** | pnpm + turbo monorepo · uv · ruff · pytest · Playwright · GitHub Actions |

## What it is not

- **Not a low-code platform.** You write business pages in React and endpoints in FastAPI; the foundation gives you the shell, the permission model and the shared building blocks.
- **Not a hosted service.** You deploy it yourself — see [Deployment](/getting-started/deployment/).
- **Not 1.0 yet.** It is released as 0.x versions; read the [release notes](https://github.com/yilecoding/fastapi-react-admin/releases) before upgrading.

## Where did it come from?

The backend started as a fork of [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture) (FBA). The three-layer structure (`api → service → crud`), the plugin system and the RBAC / data-scope model come from FBA's design; FBA's copyright notice is kept in [`apps/api/LICENSE`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/LICENSE). SQL Server support is what this project added — upstream declined to merge it, so the fork is permanent and only takes upstream security fixes.

The frontend, the desktop and mobile clients, and most business features (approvals, AI assistant, open API, file storage, notification routing) were written for this project.

## Next steps

- [Quick start](/getting-started/quick-start/) — run it locally in five commands.
- [Feature overview](/features/overview/) — everything that ships, by area.
- [Live demo](https://fra.wubunan.com/sign-in) — `admin` / `123456`.

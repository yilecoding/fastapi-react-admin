---
title: What is fastapi-react-admin?
description: An open-source admin foundation on FastAPI + React 19 + shadcn/ui — web, desktop and mobile in one monorepo, built for writing code with AI; why it exists and how it differs from a typical admin template.
sidebar:
  order: 0
---

fastapi-react-admin is an open-source (MIT) foundation for building admin and back-office systems: a FastAPI backend, a React 19 frontend on shadcn/ui, and the parts most internal systems end up needing — users, roles, departments, row-level data permissions, approvals, files, notifications, scheduled jobs and an AI assistant. You clone it and build your own business pages on top.

## Why build an admin base in the age of AI?

Because AI has made more systems worth building, and every new one starts with the same chores. Small tools that never made the roadmap are now worth doing, and systems that have run for years are due for a replacement — yet login, permissions, org structure, approvals, files and notifications get rebuilt from scratch every time.

This project started as a rewrite of a few small Java + Vue 2 systems at work. Rather than patch the old architecture, we rebuilt them on FastAPI + React 19 and distilled everything that gets rebuilt every time into a base: **the next system starts with business logic.**

## What's in the repository?

The backend, the web admin console, a desktop template, a mobile template and the docs site all live in one pnpm + turbo monorepo: one `pnpm install:all`, and one `pnpm dev` starts backend and frontend.

```
apps/
├── api        backend · FastAPI + Celery
├── web        web admin console · React 19
├── desktop    desktop template · Electron
├── mobile     mobile template · Expo / React Native
└── docs       docs site · Astro
packages/      one-way deps: i18n / api ← ui ← platform ← web
├── api        frontend/backend type contract, generated from OpenAPI
├── i18n       Chinese / English strings
├── ui         component library, no business logic, portable as a whole
└── platform   permissions, multi-tab, business pages
```

- **The web admin console** is the core, ready to use.
- **The desktop template** loads the web build and only adds what a browser can't do: silent printing, local hardware, auto-update. See [Desktop and mobile](/en/features/clients/).
- **The mobile template** has native screens and shares the API types (`@admin/api`) and translations (`@admin/i18n`) with web.
- **The layering is enforced.** Dependencies flow one way, declared in each package's `package.json`, and `pnpm arch:check` checks it in CI.

## Why does it suit writing code with AI?

Because AI changes code fast, and every change here has something to catch it:

- **Tests.** An AI touching a dozen files at once is routine, and nobody can click through all of that by hand. 1,400+ backend pytest cases run against a real database and Redis, 150+ Playwright cases drive a real browser, no mocks, on every CI run; failing cases come with screenshots and video, and the [E2E report](https://yilecoding.github.io/fastapi-react-admin/e2e/) is public.
- **Types.** The frontend/backend contract is generated from the backend's OpenAPI schema (`packages/api/src/schema.d.ts`). Mobile infers every request's types from it, so an API change the screens didn't follow fails `pnpm typecheck`; the web client is still migrating, and its call sites currently declare response types by hand (see [Developer tools](/en/features/developer-tools/#where-does-the-frontend--backend-contract-come-from)).
- **Rules written for AI.** 50+ per-directory `CLAUDE.md` / `AGENTS.md` files record pitfalls and hard rules found by testing; a coding assistant reads the one for whatever directory it edits.
- **A backend inside the AI ecosystem.** Python + FastAPI, with the built-in AI assistant on pydantic-ai.

## Who is it for?

- Teams building an internal system (OA, ERP-style back office, operations console) who want Python on the backend and React on the frontend.
- Teams on the Microsoft stack: SQL Server is a first-class database here, tested in CI on every run alongside PostgreSQL.
- Teams that need permissions finer than "which menus can this role open" — for example, a manager should only see their own department's records.
- Teams that need a desktop or mobile app alongside the web one: both templates already have login, API types and translations wired up, so you start from a template rather than from zero.
- Teams using AI coding assistants who worry about them breaking things.

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
- **Not a hosted service.** You deploy it yourself — see [Deployment](/en/getting-started/deployment/).
- **Not a throwaway scaffold.** Since 1.0 it follows semver, with compatibility promises for the open API, webhooks, the migration chain, the plugin interface and config keys; read the [release notes](https://github.com/yilecoding/fastapi-react-admin/releases) before upgrading.

## Where did it come from?

The backend started as a fork of [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture) (FBA). The three-layer structure (`api → service → crud`), the plugin system and the RBAC / data-scope model come from FBA's design; FBA's copyright notice is kept in [`apps/api/LICENSE`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/LICENSE). SQL Server support is what this project added — upstream declined to merge it, so the fork is permanent and only takes upstream security fixes.

The frontend, the desktop and mobile clients, and most business features (approvals, AI assistant, open API, file storage, notification routing) were written for this project.

## Next steps

- [Quick start](/en/getting-started/quick-start/) — run it locally in five commands.
- [Feature overview](/en/features/overview/) — everything that ships, by area.
- [Live demo](https://fra.wubunan.com/sign-in) — `admin` / `123456`.

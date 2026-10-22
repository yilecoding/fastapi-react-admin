<div align="center">

<img src="./apps/web/public/favicon.svg" width="88" alt="fastapi-react-admin">

# fastapi-react-admin

**A batteries-included admin foundation · FastAPI + React 19 + shadcn/ui**

Row-level permissions · multi-tab that keeps state · approval workflow · an AI assistant that can't overreach · S3 storage with resumable uploads · web, desktop and mobile

[Live demo](https://fra.wubunan.com/sign-in) · [Quick start](#quick-start) · [Features](#features) · [Releases](https://github.com/yilecoding/fastapi-react-admin/releases) · [中文](./README.md)

[![Release](https://img.shields.io/github/v/release/yilecoding/fastapi-react-admin?style=flat-square)](https://github.com/yilecoding/fastapi-react-admin/releases)
[![CI](https://github.com/yilecoding/fastapi-react-admin/actions/workflows/ci.yml/badge.svg)](https://github.com/yilecoding/fastapi-react-admin/actions/workflows/ci.yml)
[![E2E report](https://img.shields.io/badge/E2E_report-Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://yilecoding.github.io/fastapi-react-admin/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

> 🚀 Demo account `admin` / `123456` — a public instance anyone can log into; data may be changed or wiped by other visitors, so don't store anything real.

<table>
<tr>
<td width="50%"><img src="./docs/screenshots/dashboard.png" alt="Dashboard"></td>
<td width="50%"><img src="./docs/screenshots/dept.png" alt="Departments"></td>
</tr>
<tr>
<td width="50%"><img src="./docs/screenshots/role.png" alt="Roles: permission matrix"></td>
<td width="50%"><img src="./docs/screenshots/data-permission.png" alt="Row-level data permissions"></td>
</tr>
<tr>
<td width="50%"><img src="./docs/screenshots/workflow-inbox.png" alt="Approval inbox"></td>
<td width="50%"><img src="./docs/screenshots/workflow-designer.png" alt="Approval designer"></td>
</tr>
</table>

## ✨ Why this one

- **Permissions down to which rows you see** — beyond menus and buttons there are data scopes: on the same user table, a department manager only sees their own department. Rules live on model columns, and the UI warns you when a rule is misconfigured
- **Tabs that keep their state** — built on React 19's `<Activity>`: a half-filled form, the page you were on, an expanded tree are all still there when you switch back; view state lives in the URL, so a refresh doesn't lose it either
- **Approval workflow out of the box** — a Feishu-style form designer and flow tree, with or-sign / co-sign, send back, add approvers, take back and timeouts
- **An AI assistant that can't overreach** — it can do exactly what the signed-in user can do; write actions are previewed and only run after the user confirms, and every call is audited. External systems can reach the same tools through an MCP gateway
- **Large files, handled** — local disk or S3-compatible storage, instant upload by hash, parallel chunks, resume after a page refresh, and one upload tray for everything in flight
- **Pick your database** — PostgreSQL, SQL Server or MySQL, same code
- **Beyond the browser** — an Electron desktop app (installers for three platforms with auto-update) and a native mobile app
- **Tested for real** — 850+ tests against real databases and a real browser; CI runs the full backend suite on both PostgreSQL and SQL Server

## Features

| Area | What you get |
|---|---|
| **Access & org** | RBAC (menus / buttons / data scopes) · row-level data permissions · department tree · users & roles · bulk user import from xlsx |
| **Sign-in & security** | captcha · lockout · password history & expiry · OAuth2 (GitHub / Google) · force sign-out of sessions |
| **Workspace** | multi-tab (pin / drag / reload) · command palette ⌘K · shortcuts · guided tour · theme / radius / tab style · per-user time zone · Chinese & English |
| **Files & storage** | file manager with previews (pdf / docx / xlsx / images / archives) · local + S3-compatible storage · pre-signed downloads · recycle bin · instant upload · chunked & resumable uploads · attachment panel for any page |
| **Approval workflow** | form designer · flow tree (approve / CC / conditional branches) · approve / reject / transfer / send back / take back / add approvers · timeout reminders and auto-actions · drafts · urgent · handover |
| **AI assistant** | full-page chat + side drawer · tool calls bound by permissions and data scopes · preview + confirm for writes · audit log · MCP gateway |
| **Open API** | AK/SK-signed endpoints · scopes / IP allow-list / replay protection / rate limits · call logs · incremental sync · Python / Node / Java SDKs |
| **Messages & jobs** | in-app notifications (real-time) · notices (rich text + attachments) · scheduled jobs (online scheduling · cron preview · run history) |
| **Operations** | settings · dictionaries · sign-in / operation logs (redacted) · server & Redis monitoring · new-version prompt |
| **Clients** | Electron desktop (silent printing · local hardware · auto-update) · native Expo app (not a WebView wrapper) |
| **Developers** | component sandbox (every component tweakable and copy-pasteable) · color palette · type-safe API contract generated from OpenAPI |

## Stack

| | |
|---|---|
| **Frontend** | React 19 · TypeScript 6 · Vite 8 · TanStack Router / Query / Table v9 · Tailwind CSS 4 · shadcn/ui (Base UI) · zustand · Tiptap 3 · i18next |
| **Backend** | FastAPI · Pydantic 2 · SQLAlchemy 2 (async) · Alembic · Redis · Celery · Socket.IO · Apache OpenDAL · pydantic-ai |
| **Databases** | PostgreSQL · SQL Server · MySQL |
| **Clients** | Electron 42 · Expo 57 / React Native 0.86 |
| **Tooling** | pnpm + turbo monorepo · uv · ruff · pytest · Playwright · GitHub Actions |

## Databases

Switch with `DATABASE_TYPE` in `.env` — same code, same migration chain, seed data for all three.

| | Good for | How it's verified |
|---|---|---|
| **PostgreSQL** (default) | new projects; `docker compose up` gives you one | full backend suite on every CI run |
| **SQL Server** | teams already on the Microsoft stack | full backend suite + browser E2E on every CI run |
| **MySQL** | teams already running MySQL | not in CI; full suite run locally on demand — last run left one known issue ([#132](https://github.com/yilecoding/fastapi-react-admin/issues/132)) |

## Quick start

You need Node ≥ 22.13, Python ≥ 3.10, [uv](https://docs.astral.sh/uv/) and Docker.

```bash
docker compose -f docker-compose.dev.yml up -d          # PostgreSQL + Redis
pnpm install:all                                        # frontend + backend dependencies
cp apps/api/backend/.env.example apps/api/backend/.env  # defaults match the containers above
pnpm db:init                                            # create tables + seed data (first run)
pnpm dev                                                # open http://localhost:8888
```

Sign in as `admin` / `123456`. Switching to SQL Server / MySQL, S3, skipping the captcha and running tests are covered in [CONTRIBUTING.md](./CONTRIBUTING.md#本地开发) (Chinese; the commands are language-independent).

## Docs

| To… | Read |
|---|---|
| develop locally, run tests, open a PR, release | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| learn the engineering rules and pitfalls | [CLAUDE.md](./CLAUDE.md) — task-indexed, 40+ module notes, every claim backed by a test or measurement |
| deploy to a server | [deploy/README.md](./deploy/README.md) |
| integrate with the open API | [apps/api/backend/plugin/open/README.md](./apps/api/backend/plugin/open/README.md) |
| reuse the component library | [packages/ui/PORTING.md](./packages/ui/PORTING.md) |
| security notes | [SECURITY.md](./SECURITY.md) |

## License

[MIT](./LICENSE)

## Acknowledgements

The backend was originally built on [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture) (FBA) — its three-layer structure, plugin system and RBAC / data-scope model come from FBA's design. Thanks to its author and contributors 🙏 FBA is also MIT-licensed; its original copyright notice is kept in [`apps/api/LICENSE`](./apps/api/LICENSE).

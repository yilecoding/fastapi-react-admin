---
title: Feature overview
description: Everything fastapi-react-admin ships with, by area — access control and data scopes, import/export, approvals, AI assistant, open API, files, messaging, operations and clients.
sidebar:
  order: 0
---

Everything below is on `main`. Areas with their own page are linked.

| Area | What you get |
|---|---|
| **Access & org** | RBAC (menus / buttons / data scopes) · [row-level data permissions](/features/data-permissions/) · department tree · users & roles |
| **Import & export** | server-side xlsx / csv export (current filter or selected rows · large exports run in the background and notify you when done · formula-injection safe) · generic import (templates with dropdowns · preview & validation · insert only / upsert / update only · error report · all-or-nothing) · build a whole department tree from one file |
| **Sign-in & security** | captcha · lockout · password history & expiry · OAuth2 (GitHub / Google) · force sign-out of sessions |
| **Workspace** | [multi-tab that keeps state](/features/multi-tab/) (pin / drag / reload) · command palette ⌘K · shortcuts · guided tour · theme / radius / tab style · per-user time zone · Chinese & English |
| **Files & storage** | [file manager with previews](/features/file-storage/) (pdf / docx / xlsx / images / archives) · local + S3-compatible storage · pre-signed downloads · recycle bin · instant upload · chunked & resumable uploads · attachment panel for any page |
| **Approval workflow** | [form designer · flow tree](/features/approval-workflow/) (approve / CC / conditional branches) · approve / reject / transfer / send back / take back / add approvers · timeout reminders and auto-actions · drafts · urgent · handover |
| **AI assistant** | [full-page chat + side drawer](/features/ai-assistant/) · tool calls bound by permissions and data scopes · preview + confirm for writes · audit log · MCP gateway |
| **Open API** | [AK/SK-signed endpoints](/features/open-api/) · scopes / IP allow-list / replay protection / rate limits · call logs · incremental sync · Python / Node / Java SDKs |
| **Messages & jobs** | [in-app notifications, notices and channel routing](/features/notifications/) (email / SMS / group bots) · scheduled jobs (online scheduling · cron preview · run history) |
| **Operations** | settings · dictionaries · sign-in / operation logs (redacted) · server & Redis monitoring · new-version prompt · one [health URL](/getting-started/deployment/#what-should-external-monitoring-check) for external monitoring |
| **Databases** | [PostgreSQL · SQL Server · MySQL](/features/databases/) with the same code and migration chain |
| **Clients** | [Electron desktop](/features/clients/) (silent printing · local hardware · auto-update) · native Expo app (not a WebView wrapper) |
| **Developers** | component sandbox (every component tweakable and copy-pasteable) · color palette · type-safe API contract generated from OpenAPI |

## How are the engineering rules documented?

The repository keeps its rules and pitfalls next to the code: a root [`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md) and 40+ module notes (`AGENTS.md`), each indexed by task ("adding a list page", "changing the permission model", "writing a migration"). Every entry follows the same shape — symptom, cause, fix, and the measurement or test that proves it — and `pnpm ctx:check` runs in CI to catch notes that point at files, scripts or test IDs that no longer exist.

## Can I try it without installing?

Yes: sign in to the [live demo](https://fra.wubunan.com/sign-in) as `admin` / `123456`. It is shared by everyone, so data may change under you, and it may lag a release or two behind `main`.

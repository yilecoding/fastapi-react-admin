---
title: Feature overview
description: Everything fastapi-react-admin ships with, by area — access control and data scopes, sign-in security, import/export, approvals, AI assistant, open API, files, messaging, operations and clients; which menu each lives in, which plugin provides it, and how much the mobile app covers.
sidebar:
  order: 0
---

Everything below is on `main`. The table matches the Features table in the [README](https://github.com/yilecoding/fastapi-react-admin/blob/main/README.md#features) row for row; areas with their own page link to it in the last column, the rest show "—".

| Area | What you get | Page |
|---|---|---|
| **Access & org** | RBAC (menus / buttons / data scopes) · row-level data permissions · department tree · users & roles | [Data permissions](/en/features/data-permissions/) |
| **Import & export** | server-side xlsx / csv export (current filter or selected rows · large exports run in the background and notify you when done · formula-injection safe) · generic import (templates with dropdowns · preview & validation · insert only / upsert / update only · error report · all-or-nothing) · build a whole department tree from one file | — |
| **Sign-in & security** | captcha · lockout · password history & expiry · SMS code sign-in · two-factor auth (TOTP + recovery codes) · OAuth2 (GitHub / Google) · session management (idle timeout + absolute limit · per-client session caps · tells users why they were signed out · force sign-out) | [Sign-in and security](/en/features/login-security/) |
| **Workspace** | customizable dashboard (cards appear by permission · layout saved per user on the server) · multi-tab (pin / drag / reload) · command palette ⌘K · shortcuts · guided tour · column visibility and drag-to-reorder (kept in the URL) · theme / radius / tab style · per-user time zone · Chinese & English | [Multi-tab](/en/features/multi-tab/) |
| **Files & storage** | file manager with previews (pdf / docx / xlsx / images / archives) · local + S3-compatible storage · pre-signed downloads · recycle bin · instant upload · chunked & resumable uploads · attachment panel for any page | [Files and storage](/en/features/file-storage/) |
| **Approval workflow** | form designer · flow tree (approve / CC / conditional branches) · approve / reject / transfer / send back / take back / add approvers · timeout reminders and auto-actions · drafts · urgent · handover · AI pre-review / form filling / AI approval nodes | [Approval workflow](/en/features/approval-workflow/) |
| **AI assistant** | full-page chat + side drawer · tool calls bound by permissions and data scopes · preview + confirm for writes · audit log · MCP gateway | [AI assistant](/en/features/ai-assistant/) |
| **Open API** | AK/SK-signed endpoints · scopes / IP allow-list / replay protection / rate limits · call logs · incremental sync · Python / Node / Java SDKs · webhook subscriptions (Standard Webhooks signatures · retries · delivery log · bulk resend) | [Open API](/en/features/open-api/) |
| **Messages & notifications** | in-app notifications (real-time) · notices (rich text + attachments · audiences · scheduled publishing · pinned / level / expiry · pop-up after sign-in with required acknowledgement · top banner · sign-in page notices · read stats) · notification routing (email / SMS / Feishu · DingTalk · WeCom group bots · per-event policies · delivery log) · SMS (Alibaba Cloud / Tencent Cloud) | [Messages and notifications](/en/features/notifications/) |
| **Scheduled jobs** | online scheduling · cron preview · run history | — |
| **Operations** | settings · dictionaries · sign-in / operation logs (redacted) · data change history (who changed which field from what to what, when and from where · linked to the operation log) · server & Redis monitoring · new-version prompt · a single [health check URL](/en/getting-started/deployment/#what-should-external-monitoring-check) for external monitoring | — |
| **Clients** | Electron desktop (installers for three platforms · silent printing · local hardware · auto-update) · native Expo app (not a WebView wrapper) | [Desktop and mobile](/en/features/clients/) |
| **Developers** | component sandbox (every component tweakable and copy-pasteable) · color palette · type-safe API contract generated from OpenAPI | — |
| **Databases** | PostgreSQL · SQL Server · MySQL, one codebase and one migration chain | [Databases](/en/features/databases/) |

## Which menu is each feature in, and does it work on the phone?

The desktop app loads the web build directly, so **everything on the web is on the desktop too**; the table compares the web and the mobile app only. The Plugin column is the directory name under `apps/api/backend/plugin/`; empty means core. Menu names are from the seed data and each deployment can change them.

| Feature | Web menu | Plugin | Mobile app |
|---|---|---|---|
| Sign-in and security | Profile · Monitoring → Active sessions · System → Config | SMS sign-in needs `sms`, third-party sign-in needs `oauth2` | Password / SMS sign-in, can enter a two-factor code; users required to enrol must do so on the web first |
| Users · roles · departments · menus | System → Users / Roles / Departments / Menus | | User list → detail → delete (as a pattern to copy) |
| Data permissions | System → Data permissions | | Filtering happens in the backend, so lists in the app are scoped the same way |
| Multi-tab · dashboard | — (shell) · Dashboard | | The home tab is a fixed layout (notices, my approvals, shortcuts); no layout editing, no tabs |
| Import & export | Toolbar of each list page | | None |
| Files and storage | System → Files / Storage | | Notice attachments only |
| Approval workflow | Approvals → Approval center / Workflow definitions / Instance monitor | `workflow` | To-dos, details, starting a request |
| In-app messages · notices | Bell in the top bar · System → Notices | `notification` · `notice` | Readable, not real-time (refreshes on open or pull-down) |
| Notification channels · SMS | Notifications → Notification policy / Delivery records · SMS → SMS configurations / SMS logs | `notification` · `sms` · `email` | None |
| AI assistant | AI assistant | `ai` | None |
| Open API | Open platform → Applications | `open` | None |
| Scheduled jobs | Scheduler → Tasks / Task history | | None |
| Config · dictionaries | System → Config · Dictionaries | `config` · `dict` | None |
| Logs and audit | Logs → Sign-in log / Operation log / Data changes | | None |
| Monitoring | Monitoring → Active sessions / Server / Redis | | Server |

The mobile app has only been checked by hand on Android; see [Desktop and mobile](/en/features/clients/#what-doesnt-the-mobile-app-do-yet) for its scope and limits.

## How are the engineering rules documented?

The repository keeps its rules and pitfalls next to the code: a root [`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md) and 40+ module notes (`AGENTS.md`), each indexed by task ("adding a list page", "changing the permission model", "writing a migration"). Every entry follows the same shape — symptom, cause, fix, and the measurement or test that proves it — and `pnpm ctx:check` runs in CI to catch notes that point at files, scripts or test IDs that no longer exist.

## Can I try it without installing?

Yes: sign in to the [live demo](https://fra.wubunan.com/sign-in) as `admin` / `123456`. It is shared by everyone, so data may change under you, and it may lag a release or two behind `main`.

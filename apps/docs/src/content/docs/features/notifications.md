---
title: Notifications and notices
description: Real-time in-app inbox, notices with rich text, attachments and audiences, and routing to email, SMS and Feishu / DingTalk / WeCom group bots.
sidebar:
  order: 7
---

Notifications in fastapi-react-admin have three parts: an in-app inbox (the bell in the top bar plus a Message center page, updated over Socket.IO), notices that admins publish to everyone or to chosen departments, roles and users, and a routing layer that decides, per notification kind, whether a message also goes out by email, SMS or to a Feishu, DingTalk or WeCom group bot. External sends are written as delivery rows inside the caller's database transaction and sent by a Celery worker, so a rolled-back approval never emails anyone.

## How does the in-app inbox stay real-time?

Inbox rows live in `sys_notification` under four categories: system, announcement, task (background exports) and workflow. When a row is written, the server emits a Socket.IO `notification:new` event **with an empty payload**; the browser refetches the list and unread count over REST. Permission checks therefore happen only in the REST API, and the unread badge is fetched over REST on every page load — a notification that arrived while the socket was disconnected still shows up. If the unread-count request fails, the bell shows `!` instead of an empty badge, which would look the same as "nothing unread".

A broadcast is one row, not one per user; read state is kept per user in `sys_notification_read`. Broadcasts written before an account was created count as read for that account, so a new hire does not log in to dozens of old red dots — except notices that require acknowledgement.

Approvers are not sent inbox rows for new tasks; the Approval center's to-do badge updates through a separate `workflow:todo` socket event (see [Approval workflow](/features/approval-workflow/)).

## What can a notice carry, and who can see it?

A notice has a rich-text body (Tiptap editor), up to 20 attachments, and these switches:

| Setting | Effect |
|---|---|
| Type · level | notice or announcement · normal, important or urgent |
| Pinned | sorts first; pinned + urgent + unread notices also show as a banner (up to 3) |
| Expiry / schedule | hidden after `expire_time`; invisible until `publish_time`. The Celery task `notice.sync_inbox` runs every 60 s to publish scheduled notices and retract expired ones |
| Pop-up | shown in a dialog after sign-in until read (up to 10, with body) |
| Require acknowledgement | the reader must click "I've read this"; "Mark all read" skips these rows. Only allowed together with pop-up (otherwise 422) |
| Show on sign-in page | readable without signing in, rate-limited to 30 requests per minute per IP; returns at most 5 items with a 200-character plain-text summary |
| Audience | departments (including all sub-departments), roles (enabled ones) and users. No audience rows = everyone. Sign-in page + audience is rejected with 422 |

Visibility has one definition, `crud_notice.readable_clause(viewer)` in [`crud_notice.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notice/crud/crud_notice.py): not deleted, shown, published, not expired, and the viewer is in the audience. The reader list, detail, pop-ups, banner and **attachment downloads** all use it, and the inbox reads the same audience table, so "it's in my bell" and "I can open it and download the file" cannot disagree. Hidden, expired, unpublished or out-of-audience notices all return 404 — a 403 would confirm the notice exists. Admins with `sys:notice:add` get read statistics: who in the audience has and has not read it.

Attachments are committed in the same transaction as the notice. Each must exist and not be in the recycle bin, must be readable by the person publishing (otherwise anyone with publish rights could expose someone else's private file), and must not be a public file.

:::caution
Images embedded in the rich-text body are public files (`/uploads/{key}`): an `<img>` tag cannot send an auth header. They stay reachable even when the notice is hidden or limited to an audience. Put confidential material in attachments.
:::

## How does a notification decide between email, SMS and a group bot?

Each plugin declares its notification kinds in a `notification_kinds.py`, which the notification plugin discovers at startup. This is the real declaration from [`plugin/workflow/notification_kinds.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/notification_kinds.py):

```python
register_notification_kind(
    'workflow.remind',
    label='审批催办',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_on', 'sms': 'default_off'},
    sms_template='workflow_remind',
    sms_params=lambda title, content: {'title': title[:_SMS_TITLE_MAX]},
)
```

For each recipient and external channel, the router in [`service/routing.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notification/service/routing.py) combines three things: the admin **policy** (`off`, `default_on`, `default_off` or `forced`, editable under **Notifications → Notification policy**), the user's own **preference** (**Profile → Notifications**; forced cells are locked), and whether the user has an **address**. In-app is always `forced`. A kind that is not declared for a channel cannot be switched on for it. SMS requires a registered SMS template because mainland-China SMS can only send pre-approved templates, and it is only sent to a phone number the user verified themselves — an admin-entered number gets a `skipped / phone_unverified` row instead.

The built-in kinds and their defaults:

| Kind | In-app | Email | SMS | Group bot |
|---|---|---|---|---|
| `workflow.remind`, `workflow.timeout` | forced | on | off | — |
| `workflow.sent_back` | forced | on | — | — |
| `workflow.result` | forced | off | — | yes |
| `workflow.cc`, `workflow.withdrawn` | forced | off | — | — |
| `workflow.task_assigned` ("you have a new task") | no row | off | — | — |
| `announcement` (notices) | forced | — | — | yes |
| `open.webhook.disabled` | forced | on | — | yes |
| `system`, `export.done`, `export.failed` | forced | off | — | — |

Broadcast kinds (notices, the daily greeting) never go to email or SMS: one broadcast row would fan out into a company-wide mass mail.

Calling code uses one entry point, `create_in_tx(db, kind=..., user_ids=..., title=..., content=..., link=...)` in [`notification_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notification/service/notification_service.py). It writes the inbox rows and delivery rows in your transaction, does not commit, and returns a `Dispatch` whose `after_commit()` pushes the socket event and wakes the worker.

## What happens after a delivery row is written?

The Celery task `notification.deliver_pending` runs every 15 seconds and is also kicked right after each commit. A worker claims a row with `UPDATE … SET status = 'sending' WHERE id = ? AND status IN (…)` and sends only if exactly one row changed. Failed sends retry after 60, 300, 1800 and 7200 seconds (default `NOTIFICATION_RETRY_MAX = 4`). For SMS and group bots, a result that **may** have been delivered — the connection was made, then timed out — is recorded as `unknown` and **not** retried, because a retry would mean a duplicate. Email does retry on connection errors and timeouts: a duplicate email costs less than a missed reminder. Rows stuck in `sending` for more than 600 s become `unknown` rather than going back to `pending`.

**Notifications → Delivery records** lists every row with its status (`pending`, `sending`, `sent`, `failed`, `exhausted`, `skipped`, `unknown`) and reason, masks phone numbers and email addresses in the list, and can resend `failed`, `exhausted` or `unknown` rows. Records are kept 30 days by default.

## Which platforms can a group bot post to?

Feishu (including `open.larksuite.com`), DingTalk and WeCom, configured under **Notifications → Group bots**. A bot subscribes to kinds marked `bot=True` — currently notices, approval results and "webhook endpoint disabled". Kinds that address the reader as "you" (CC, new task, sent back) are deliberately not subscribable: everyone in the group would read "you". Notices with an audience are not posted to groups, since a bot posts to the whole group; if the audience is later widened to everyone, the notice is posted once.

- **One delivery row per notification per bot**, regardless of how many people received it.
- **URL allow-list**: the webhook must sit on the platform's official prefix (scheme, host, port and path compared separately; userinfo and `.` / `..` path segments rejected; redirects not followed). Private deployments add `NOTIFICATION_BOT_EXTRA_URL_PREFIXES`, which must be https in production.
- **Signing**: Feishu and DingTalk signatures are supported; WeCom has none, so the `key` in its URL is the credential.
- **Rate limits** are counted before sending: Feishu 100/min and 5/s, DingTalk and WeCom 20/min. Over the limit, the row moves to the next minute without using up a retry.
- **Plain text only**, never markdown: titles are user input, and markdown would let someone post a link that looks system-generated. WeCom text is truncated at 2048 bytes, not characters.
- A read timeout counts as `unknown` and is not retried — a duplicate in a group chat is more visible than a duplicate email.

Links in bot messages and emails are built from `NOTIFICATION_WEB_BASE_URL` (default `http://localhost:8888`); set it to your real address before deploying. The step-by-step setup for a Feishu bot is in the [group bot guide](https://github.com/yilecoding/fastapi-react-admin/blob/main/docs/guides/notify-bot.md).

## How is a webhook URL kept out of logs?

A webhook URL is a credential: whoever has it can post to the group. The URL and signing secret are encrypted with `NOTIFICATION_ENCRYPT_SECRET_KEY` (32 bytes as 64 hex characters; without it, saving a bot is refused rather than storing plaintext). The API only returns a masked `webhook_hint`, and `webhook_url` / `sign_secret` are redacted from the operation log.

The less obvious leak was httpx itself: at INFO level it logs `HTTP Request: POST <full URL>`. The first real Feishu test put the token into the access log. The first fix only covered the API process, but the Celery worker — which does the actual sending — configures logging separately. The fix now sits at module top level in [`common/log.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/log.py) (`logging.getLogger('httpx').setLevel(logging.WARNING)`) and is covered by two tests, one of which configures logging the way `celery -l info` does in a subprocess.

## What has been tested against real services?

| Channel | Real-world evidence (from the plugin notes) |
|---|---|
| Feishu bot | 2026-10-30, signed custom bot: test message delivered in 465 ms; notices delivered by the worker on the first attempt; a wrong secret returned `19021` and was classified as `sign_failed`, not retried |
| DingTalk, WeCom bots | not yet posted to a real group; signing and error codes follow the docs and fake servers |
| SMS plugin | Aliyun sent for real on 2026-10-24 (a verification-code template); Tencent Cloud not yet, covered by contract tests that run the real SDK against a local fake server |
| Email and SMS through the router | the sending layer is faked in tests; for email, the 5xx-permanent / 4xx-retry split follows aiosmtplib's exception hierarchy, not real server replies |

## Limits

- Group bots subscribe by kind only; there is no per-workflow or per-department filter.
- Group delivery is written from the same entry point as person delivery, so a bot-subscribed event with no person recipient (for example, an admin terminating their own request) does not reach the group either. Exercise 2 of the [group bot guide](https://github.com/yilecoding/fastapi-react-admin/blob/main/docs/guides/notify-bot.md) works through how to separate the two.
- The audience pickers on the notice form call the user, department and role list APIs; a notice editor without those permissions sees a "no permission" line instead of options.

## Where it lives in the code

- [`plugin/notification/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/notification) — `kinds.py` (registry), `service/notification_service.py`, `service/routing.py`, `service/delivery_service.py`, `service/senders.py`, `bot_platforms.py` (URL prefixes, signing, payloads, response classification), `audience.py`
- [`plugin/notice/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/notice) — `service/notice_service.py`, `crud/crud_notice.py`; [`plugin/sms/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/sms) — `sms_service.send()` and the Aliyun / Tencent Cloud adapters
- Frontend: [`packages/platform/src/pages/notification/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/notification) (bell, Message center), `notice/` (form, reader drawer, pop-ups, banner), `notify-policy/`, `notify-delivery/`, `notify-bot/`, `profile/notify-prefs-panel.tsx`
- Notes: [`plugin/notification/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notification/AGENTS.md), [`plugin/notice/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notice/AGENTS.md), [`pages/notification/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/notification/AGENTS.md)

## How it is tested

pytest collects 117 cases in `plugin/notification/tests/` (66 for group bots with `httpx.MockTransport` fake platforms, 42 for routing and delivery, 9 for the inbox), 52 for notices in `app/admin/tests/api_v1/test_notice_*.py`, 133 in `plugin/sms/tests/`, and 3 in `plugin/workflow/tests/test_notification_channels.py`. Examples: `test_rollback_takes_the_delivery_rows_with_it`, `test_sms_needs_a_phone_the_owner_verified`, `test_read_all_does_not_acknowledge_for_the_reader`. Per the notes, the notice phase-2 suite passed on PostgreSQL 16, SQL Server 2022 and MySQL 8.4. Playwright covers the bell, notices, policy and preferences, and a bot test that verifies the signature against a fake Feishu endpoint.

## Try it in the demo

Sign in at [fra.wubunan.com](https://fra.wubunan.com/sign-in) with `admin` / `123456`. The bell is in the top bar and **Message center** is in the sidebar; notices are under **System → Notices**; policy, delivery records and group bots are under **Notifications**; your own channel preferences are in **Profile → Notifications**.

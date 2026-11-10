---
title: Open API (AK/SK signed)
description: Read-only /api/open/v1 endpoints signed with AK/SK and HMAC-SHA256, with scopes, IP allow-lists, replay protection, rate limits, call logs and webhooks.
sidebar:
  order: 6
---

The open API plugin lets another system, such as an HR, finance or data-warehouse system, pull users and departments from fastapi-react-admin over `/api/open/v1`, and receive signed webhooks when they change. Each external system gets its own application with an Access Key / Secret Key pair. Every request is signed with HMAC-SHA256 (`FRA1-HMAC-SHA256`) and checked against the application's scopes, IP allow-list, expiry and rate limit. Every request is also written to a call log, whether it succeeds or not.

## Where is it in the UI?

| Screen | Path | Permission code | What it does |
|---|---|---|---|
| **Open platform → Applications** | `/open/app` | `open:app:list`; create `add` · edit `edit` · delete `del` · reset key `reset` | Issue AK/SK; set scopes, IP allow-list, rate limit, expiry, enable / disable |
| Webhook drawer on each application | — | `open:webhook:list`; `add` · `edit` · `del` · `test` · `reset` (signing secret) · `resend` | Register endpoints, subscribe to events, view deliveries, resend in bulk |
| Open API call log (opened from the Applications page, not in the sidebar) | `/open/log` | `open:log:list` | Every open API call; see [What does the call log record?](#what-does-the-call-log-record) |

## What can an external system call?

| Endpoint | Scope | Fields returned |
|---|---|---|
| `GET /api/open/v1/users` | `user:read` | `id` `username` `nickname` `dept_id` `status` `deleted` `created_time` `updated_time` |
| `GET /api/open/v1/depts` | `dept:read` | `id` `parent_id` `code` `name` `sort` `leader_id` `status` `deleted` `created_time` `updated_time` |

There is also `workflow:read`, a scope with no endpoint behind it; it only allows subscribing to approval webhooks. The endpoints are read-only and return the **full** data set, because open-API calls explicitly bypass row-level data scopes. Two things set the boundary: which scopes you grant, and a dedicated outward schema ([`schema/open_v1.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/schema/open_v1.py)) that contains only the promised fields, so fields added to internal schemas don't leak out. The group sits outside `/api/v1` on purpose: internal endpoints come with no compatibility promise, and this one does. An admin can export the OpenAPI JSON for the other team with the **Open API docs** button on the Applications page.

## How do I get an Access Key and Secret Key?

Go to **Open platform → Applications** (`/open/app`, permission `open:app:add`). Creating an application gives you:

- **Access Key** (`fra_ak_…`): a public identifier, fine to put in a config file.
- **Secret Key** (`fra_sk_…`): **shown once**. If it's lost, an admin resets it. Keep it server-side only.

The SK is AES-encrypted, not hashed, because the server has to recompute the HMAC. The encryption key is `OPEN_SECRET_KEY` (64 hex characters in `.env`). Without it, creating an application or resetting a secret fails with an error; nothing is stored in plaintext. List and detail responses show only a short hint of the SK, never the ciphertext.

Each application also has its scopes, an IP allow-list of single addresses or CIDR ranges (empty means any), a requests-per-minute limit (empty means `OPEN_RATE_PER_MINUTE`, default 120), an optional expiry time and an enabled/disabled switch.

## How is a request signed?

Send four headers:

```
X-Access-Key: fra_ak_xxxx
X-Timestamp:  1761009302000
X-Nonce:      8f1c2a9e4b7d4e05
X-Sign:       <hex>
```

`X-Timestamp` is in milliseconds, and `X-Nonce` must be a new random string for every request. To compute `X-Sign`:

1. Build the string to sign by joining six lines with `\n`: the method in upper case, the path exactly as sent on the request line (no query string), the canonical query, the timestamp, the nonce, and `hex(sha256(body))`. An empty body uses the hash of the empty string.
2. Compute `X-Sign = hex(HMAC-SHA256(SK, string_to_sign))`.

To build the canonical query, decode the parameters and re-encode every name and value per RFC 3986: only `A-Z a-z 0-9 - _ . ~` stay unescaped, and a space becomes `%20`, not `+`. Then sort by name, then value, *after* encoding, and join with `&`.

Test vector from the [integration guide](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/README.md): with SK `fra_sk_TEST-ONLY-do-not-use-in-production`, timestamp `1761009302000` and nonce `8f1c2a9e4b7d4e05`, the request `GET /api/open/v1/depts?name=%E5%BC%A0%20%E4%B8%89&b=1&a=2&a=1` must give this string to sign:

```
GET
/api/open/v1/depts
a=1&a=2&b=1&name=%E5%BC%A0%20%E4%B8%89
1761009302000
8f1c2a9e4b7d4e05
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

and `X-Sign = 2717e8c4f65ffb9b621cfd19ba928706143e5cec1e80bb4a15d7b4a35ff0aae0`. The other vectors are in [`sdk/test_vectors.json`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/test_vectors.json). With the Python reference implementation:

```python
import requests
from fra_open_sign import sign_headers

url = 'https://admin.example.com/api/open/v1/users?limit=500'
resp = requests.get(url, headers=sign_headers('GET', url, b'', access_key=AK, secret_key=SK))
```

The guide warns about four common mistakes: sending `+` or `:` unencoded in a query value (send `updated_since=2026-10-20T00%3A00%3A00%2B08%3A00`), signing an object and letting the HTTP library re-serialize it instead of signing the exact bytes you send, a client clock more than 5 minutes off, and reusing a nonce when retrying.

When the signature doesn't match, the 401 response includes `data.string_to_sign`, the server's own string (without the secret), so you can diff it line by line. The Host header is not signed, so a reverse proxy that rewrites Host doesn't break signatures. A proxy that rewrites the **path** does, which is why `apps/web/nginx.conf` passes `/api/` through unchanged.

## How do I stop replayed requests?

Two checks work together ([`gateway/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/auth.py)):

- **Timestamp window:** the server accepts `X-Timestamp` only if it is within `OPEN_SIGN_WINDOW_SECONDS` (300 s) of the server clock. Otherwise it answers 401 and includes `data.server_time`.
- **Nonce:** each nonce is stored per application in Redis with `SET NX` for twice the window (600 s).

Because the nonce lives twice as long as the window, a replay inside the window always hits the nonce check, and a replay after it always hits the timestamp check. The signature is verified **before** the nonce is consumed. A request with a bad signature doesn't use up its nonce, so a client that fixes its signing bug can resend with the same nonce. A genuine replay always carries a valid signature, so it still hits the nonce check. `test_bad_signature_does_not_burn_the_nonce` guards this order; swapping the two steps turned 11 tests red.

The full order of checks:

| # | Check | On failure |
|---|---|---|
| 1 | All four headers present | 400 `open.missing_param` |
| 2 | AK exists, application enabled and not expired | 401 `open.invalid_key` / `open.app_disabled` / `open.app_expired` |
| 3 | Source IP in the allow-list | 403 `open.ip_denied` |
| 4 | Timestamp within the window | 401 `open.timestamp_expired` |
| 5 | Signature matches (constant-time comparison) | 401 `open.sign_mismatch` |
| 6 | Nonce not used before | 401 `open.nonce_reused` |
| 7 | Application granted this endpoint's scope | 403 `open.scope_denied` |
| 8 | Under the rate limit | 429 `open.rate_limited` with `Retry-After` |

Rate limits are counted **per application**, not per IP. The source IP for the allow-list comes from `get_request_ip`, which trusts `X-Forwarded-For` / `X-Real-IP` only when the direct peer is listed in `TRUSTED_PROXIES` (empty by default). Behind nginx or a load balancer, set `TRUSTED_PROXIES`. Otherwise the allow-list sees the proxy's address instead of the caller's.

## What does the call log record?

Every request to `/api/open/v1` adds one row to `open_api_log`, whether it succeeds or fails. That includes requests with an unknown AK, which are logged without an application. Each row records:

- a snapshot of the application's code and name, and the AK that was sent
- the endpoint, plus the scope it requires and whether the application had it
- the source IP and whether it was on the allow-list
- the arguments and the request headers, with secrets redacted
- the response headers and the response body (truncated)
- `ok` or the error code, the number of rows returned, and the duration

`X-Sign` is kept unredacted on purpose: it is single-use, so it can't be replayed, and you need it to compare against the server's signature. Open the log from an application's row on the Applications page (route `/open/log`). It is pruned together with the login and operation logs, using the same retention (180 days by default).

The general operation log only records `/api/v1` requests, and most integration failures happen before the application is even identified. That is why this log is a separate table.

## How does incremental sync work?

Both endpoints accept `updated_since` (ISO 8601 with an offset; leave it out for the first full sync), `cursor` (the previous page's `next_cursor`) and `limit` (1–500, default 100). They return `{"items": [...], "next_cursor": "...", "has_more": true}`. Keep paging until `has_more` is false. For the next sync, pass the largest change time you received.

- Deleted records are returned too, with `deleted: true`. Delete them on your side.
- Records are ordered by change time (`COALESCE(updated_time, created_time)`), then by `id`. The cursor is keyset-based, not an offset, so pages don't skip or repeat rows while data changes. The record right on the boundary may come again; upsert by `id`.
- IDs are strings: 19-digit snowflake IDs exceed JavaScript's safe integer range.

There was one real SQL Server bug here. `datetimeoffset(7)` stores 100 ns, while Python's `datetime` stops at microseconds, so seed rows written by `GETDATE()` were read back slightly truncated. The cursor never moved past them: the same page came back forever. CI's SQL Server job timed out three times, and the hang reproduced locally 58% of the time. The query now casts to `DATETIMEOFFSET(6)` before reading, comparing and sorting ([`service/sync_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/sync_service.py)).

## How do webhooks work?

Under **Open platform → Applications → Webhook**, register a receiving URL (up to 10 per application) and choose events. You can only subscribe to events covered by the application's scopes. The signing secret (`whsec_…`) is shown once and is separate from the SK.

| Events | Required scope |
|---|---|
| `user.created` · `user.updated` · `user.status_changed` · `user.deleted` | `user:read` |
| `dept.created` · `dept.updated` · `dept.deleted` | `dept:read` |
| `workflow.instance.started` · `.approved` · `.rejected` · `.withdrawn` · `.terminated` | `workflow:read` |

The payload carries IDs and status only, with no form content, phone numbers or email addresses; fetch details through the API. Signing follows [Standard Webhooks](https://www.standardwebhooks.com/):

- **Signature:** `base64(HMAC-SHA256(key, "{webhook-id}.{webhook-timestamp}.{raw body}"))`, where `key` is the secret with `whsec_` removed, base64-decoded.
- **Secret rotation:** for 24 hours after a secret reset, `webhook-signature` carries two signatures separated by a space.

A 2xx answer within 15 seconds counts as success. A 3xx answer is a failure, and redirects are never followed. `410 Gone` disables the endpoint immediately. Anything else is retried after 15 s, 5 min, 1 h and 6 h, for 5 attempts in total. Delivery is at-least-once, with no ordering guarantee. Deduplicate on `webhook-id`. An endpoint is auto-disabled after 20 consecutive failures *and* more than 24 hours of failing, and the application's creator gets a [notification](/en/features/notifications/).

To guard against SSRF, receiving URLs must be https. The hostname is resolved again before every attempt, and any non-public address is refused. DNS rebinding between that check and the actual connection is a known remaining risk; it is handled at the deployment level, not in code. The signing code reproduces the example signature from the Standard Webhooks README exactly (`v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`). It has only been tested against mock and local receivers, never against a real public endpoint.

## Which SDKs are there?

| Language | File | Functions |
|---|---|---|
| Python 3.10+ | [`sdk/python/fra_open_sign.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/python/fra_open_sign.py) | `sign_headers`, `verify_webhook` |
| Node.js 18+ | [`sdk/node/fra-open-sign.mjs`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/node/fra-open-sign.mjs) | `signHeaders`, `verifyWebhook` |
| Java 11+ | [`sdk/java/FraOpenSign.java`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/java/FraOpenSign.java) | `signHeaders`, `verifyWebhook` |

Each one is a single file that uses only the standard library; copy it into your project. They implement signing and webhook verification only. They are not generated API clients with typed models.

## How is it tested?

| File | `def test_` | Covers |
|---|---|---|
| `test_open_api.py` | 21 | every route under `/api/open` has the auth dependency, each failure code, replay, rate limit, call log, incremental sync |
| `test_open_signature.py` | 8 | server and SDKs against the test vectors, README shows the same vectors |
| `test_open_apps.py` | 14 | plaintext SK only in the create response and redacted from the operation log, refusal without `OPEN_SECRET_KEY`, reset / disable take effect immediately |
| `test_webhooks.py` | 35 | signing, retries, auto-disable, SSRF, events emitted by real writes |

The Python and Node signing code is checked against the vectors in pytest. The Node and Java webhook verification runs too when `node` or a JDK is installed. Java's `signHeaders` is not in the automated suite; it was last compiled and run by hand against the three vectors on 2026-11-01, and all three signatures matched. The Playwright spec `webhook.spec.ts` starts a local receiver that recomputes each signature per the spec.

## Which settings are there?

**Changed in the UI** (System → Config → **Webhook**), no restart:

| Key | Default | Notes |
|---|---|---|
| `OPEN_WEBHOOK_ENABLED` | `true` | Master switch. Off = events are still recorded but no deliveries are created (anything already queued still goes) |
| `OPEN_WEBHOOK_DISABLE_AFTER` | `20` | After this many consecutive failures, with the first failure of the streak over 24 hours old, the endpoint is disabled and the app's creator is notified |
| `OPEN_WEBHOOK_RETENTION_DAYS` | `30` | Days to keep events, deliveries and attempts |
| `OPEN_WEBHOOK_MAX_PER_APP` | `10` | Endpoints per application |

**`.env` only**, restart the backend after changing:

| Key | Default | Notes |
|---|---|---|
| `OPEN_SECRET_KEY` | empty | Encrypts SKs at rest; empty = creating an app and resetting its key are refused |
| `OPEN_RATE_PER_MINUTE` | `120` | Requests per minute when an app has no limit of its own (per app, not per IP) |
| `OPEN_SIGN_WINDOW_SECONDS` | `300` | Allowed difference between the request timestamp and server time; nonces are kept in Redis for twice as long |
| `OPEN_WEBHOOK_TIMEOUT_SECONDS` | `15` | Timeout for one delivery attempt |
| `OPEN_WEBHOOK_RETRY_BACKOFF_SECONDS` | `15,300,3600,21600` | Retry intervals: 5 attempts over about 7 hours |
| `OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK` | `false` | Allows loopback / private addresses and plain http, **for local testing and E2E only**; keep it `false` in production |

## Where it lives in the code

- [`gateway/signature.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/signature.py): canonical query, string to sign, constant-time verify
- [`gateway/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/auth.py): the eight checks, `DependsOpenApp`, scope registry
- [`gateway/route.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/route.py): call log
- [`service/sync_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/sync_service.py): incremental sync
- [`service/webhook_delivery.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/webhook_delivery.py) · [`service/webhook_sign.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/webhook_sign.py): webhook delivery and signing
- [`plugin.toml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/plugin.toml): settings · [`README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/README.md): integration guide for the external team (in Chinese)

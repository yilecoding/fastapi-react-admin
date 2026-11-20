---
title: Security overview
description: The protections that are on by default, on one page — brute-force protection and two-factor sign-in, session control, permission and data-scope checks on every endpoint in the backend, tamper-evident audit records, encrypted secrets and production start-up checks. Each item links to the details and the tests.
---

This page lists the protections that are on by default, each linked to its details. Most need no setup and work as soon as you install; the things you have to do at deployment are marked separately.

Everything here comes from the code and its automated tests. **It is not a third-party penetration test report.**

## What does sign-in protect against?

- **Image captcha** on by default.
- **Lockout**: 5 failures on one account within 5 minutes lock it for 5 minutes; 30 failures from one IP across accounts within 15 minutes block that IP for the rest of those 15 minutes.
- **Same message and timing for "unknown user" and "wrong password"**: both get the same message, and the timing is evened out. Otherwise an unknown user takes about 5 ms and a password check about 190 ms, and the difference shows at a glance.
- **Rate-limited sign-in**: 5 per minute per IP and endpoint; the captcha endpoint 5 per 30 seconds.
- **Two-factor sign-in**: TOTP codes plus recovery codes, and you can require it for superusers or for everyone.
- **Password policy**: length, complexity, no reuse of the last N passwords, expiry. Changing a password, or having it reset by an admin, ends every session of that account.

See [Sign-in and security](/en/features/login-security/) and [Security configuration](/en/reference/security-config/).

## How are sessions controlled after sign-in?

- **Every sign-in has a server-side session**, with an idle timeout, a maximum lifetime and a device limit per client type. The web client, for example, signs out after 120 idle minutes by default and lasts at most 7 days.
- **Idle means the person isn't doing anything**: background polling doesn't count as activity, so a session still expires when someone walks away.
- **Superusers can force any session out.** On their next request the user lands on the sign-in page and sees why.
- **Access tokens expire after 30 minutes**; the refresh token is swapped for a new one on every use. If the previous one shows up again more than 30 seconds later, the credentials may have been stolen and the whole session ends at once.

See [Session management](/en/features/login-sessions/).

## Where are "can do" and "can see" decided?

- **Endpoints that need a permission check it in the backend.** Hiding a button in the frontend is only cosmetic; the real boundary is in the backend. Write operations on those endpoints also require back-office access. Disabling a directory disables the permissions of every button under it. Endpoints that only require sign-in, such as "current user", don't check a permission code.
- **Data scopes filter rows in the query layer**: on the same user table, a department manager only gets the people in their own department. Endpoints don't have to add the filter by hand.
- **Files you aren't allowed to read return 404**, not 403, so the response doesn't confirm that the ID exists.
- **Permission codes are cross-checked automatically**: every code a frontend button uses must be guarded by a backend endpoint, and every code the backend or frontend uses must exist in the menu data. If one is missing, a [test](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/security/test_permission_codes.py) fails.

See [Users, roles, departments and menus](/en/features/rbac/) and [Data permissions](/en/features/data-permissions/).

## If something happens, can we find out what?

- **Sign-in log**: successful and failed sign-ins (except requests turned away by the rate limiter), plus account lockouts, IP lockouts and forced sign-outs, with IP, location, browser and device.
- **Operation log**: every request under `/api/v1`, GET included. Passwords, tokens and keys are **redacted before truncation**, nested fields included. Request and response bodies declared as JSON that can't be parsed are left out rather than stored as-is; plain text has no fields to redact and is stored truncated.
- **Data change records**: which field changed, the old value and the new one, written in the same transaction as the business data. Every record is signed and chained to the one before, so changing, deleting or inserting a row breaks verification. **It's a real HMAC-SHA256 signature only once `DATA_CHANGE_CHAIN_KEY` is set**; left empty, anyone can recompute the signatures, which only guards against accidental edits straight in the database.
- **Kept for 180 days**, matching the six-month log retention in China's Cybersecurity Law; adjustable.

See [Logs and audit](/en/features/audit-logs/).

## How are secrets and credentials stored?

- **Secrets saved in the UI are encrypted at rest**: AI model API keys, object storage keys, group-bot webhook URLs, the SMTP authorization code in system config and so on, each with its own encryption key. Without that key, saving is **refused**; it never falls back to plain text.
- **Read APIs don't return plain text**: config secrets only say whether they're set, and model keys are masked.
- **Data change records note only that a sensitive field changed**, not its content.

What you need to do: set the encryption keys, and `DATA_CHANGE_CHAIN_KEY` for the audit signatures, before going live; see the [go-live checklist](/en/getting-started/deployment/#checklist-before-going-live).

## What safety nets are there in production?

With `ENVIRONMENT='prod'`, the backend checks all of the following before starting and [refuses to start](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/core/conf.py) if any fails:

- The length and randomness of the signing key and the database and Redis passwords. Replacing a placeholder with something weak like `123` doesn't pass.
- The captcha and API rate limiting can't be turned off in `.env`.
- Demo mode must be off.
- No database superuser (`sa`, `root`, `postgres`) as the connection account.
- No `*` or local address among the allowed CORS origins.

Also:

- The deployment script `prod.sh` refuses to start while the config file still contains `CHANGE_ME` or is readable by other users.
- **Forwarding headers (`X-Forwarded-For` and the like) are only trusted from known proxies**: the app's `TRUSTED_PROXIES` is empty by default, trusting no one, and uvicorn in the production image only trusts the container network. Otherwise a client could get past rate limits and fake the IP in the logs just by changing a header.
- HTTPS sites mark the sign-in cookie `Secure` (`COOKIE_SECURE`).

See [Deploying to a server](/en/getting-started/deployment/).

## How is the open API protected?

- External systems call it with **AK/SK signatures**, compared in constant time.
- **Replay protection**: a 5-minute timestamp window plus a nonce that can't repeat within 10 minutes.
- You can restrict **source IPs** and which endpoints an app may call, and limit the rate **per app**.
- Outgoing webhooks are signed following the Standard Webhooks spec.

See [Open API](/en/features/open-api/).

## What about uploaded files?

- Paths in upload file names are [stripped](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/utils/file_ops.py), so nothing like `../../` gets through; [tests](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/api_v1/test_file.py) guard it.
- Private files aren't served as static files and can only be downloaded with sign-in credentials. Public files must be declared explicitly, and only images are accepted.

See [Files and storage](/en/features/file-storage/).

## What it doesn't do

- The only second factors are TOTP and recovery codes; no passkeys (WebAuthn) or hardware keys.
- No self-service password reset; ask an admin.
- Sessions rely on a single Redis instance and haven't been tested on Redis Cluster.
- Someone who has both the database **and** the signing key can get past the data-change signature chain.
- **The captcha can be turned off under System config**: the production start-up check only reads `.env`, so an admin switching the captcha off at runtime isn't stopped.
- This page is not a third-party security audit or certification.

## How do I report a vulnerability?

Please don't open a public issue. Use GitHub's private vulnerability reporting (repo → Security → Report a vulnerability). Scope and process are in [`SECURITY.md`](https://github.com/yile2020/fastapi-react-admin/blob/main/SECURITY.md).

---
title: Performance and capacity
description: Measured — with the production image's default 2 workers, about 190 requests per second at a p95 of about 70 ms on read endpoints that run full auth, permission and audit checks, with zero failures at 64 concurrent requests. How that maps to users, how to scale, and how to measure it yourself.
---

The production image starts 2 API workers by default. On a mix of 12 everyday read endpoints they handled about **190 requests per second**, with 95% of requests answered within **70 ms**. With 64 requests in flight at once **none failed**; they just queued longer. One worker that saturates a CPU core does about 110 requests per second, and you scale by adding workers and cores.

These numbers come from a laptop, not a production server benchmark. Below are the test conditions, how to turn requests per second into a number of users, and how to rerun the test on your own hardware.

## How fast is it?

Every request takes the full path; nothing was switched off for the test: JWT verification, a session check in Redis, the RBAC permission-code check, row filtering by data scope, the database query, serialization, and an operation-log entry (GET requests are logged too).

| API workers | Single request | Best throughput (8 concurrent) | 64 concurrent |
|---|---|---|---|
| 1 | p50 16–19 ms | 113–119 req/s, p95 92–98 ms | 96–100 req/s, p95 about 1.1 s, 0 failures |
| **2 (production image default)** | p50 15 ms | **186–195 req/s, p95 68–69 ms** | 157–172 req/s, p95 0.8–0.9 s, 0 failures |

Each configuration ran twice; the table shows the range. Across all 20 steps of the four runs the **failure rate was 0** and the server log had no errors.

"Concurrent" means requests in flight at the same time, not users online. Once concurrency goes past what the workers can process, the extra requests wait in line: throughput stops rising and latency grows. Up to 64 concurrent requests nothing failed in the test; beyond that, requests start failing once queueing exceeds the client's or the connection pool's wait limit.

## Under what conditions?

- **Code**: the backend on `main`, `uvicorn --workers N` without `--reload` — the same way [`Dockerfile.prod`](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/Dockerfile.prod) starts it (default `--workers 2`), without nginx in front.
- **Account**: an **ordinary user** (the department manager role, granted every menu, with a department data scope). A superuser skips the permission checks, so testing with one makes the numbers look better than they are.
- **Endpoints**: user list, role list, department tree, menu tree, sidebar, current user, permission codes, dictionaries, system config, unread notification count, notification list and file statistics, weighted by how often they're used — all GET.
- **Data**: the seed data from `fba init` (10 users, 162 menus).
- **Dependencies**: PostgreSQL 16 and Redis 7 in Docker on the same machine.
- **Machine**: an Intel Core Ultra 9 285H laptop under WSL2, with the load generator and the server on the same machine.

The raw record is in [`scripts/AGENTS.md`](https://github.com/yile2020/fastapi-react-admin/blob/main/scripts/AGENTS.md), in the section on where the numbers of the docs' performance page come from.

## How many users is 190 requests per second?

There are two kinds of users:

- **People who are signed in but idle cost the backend almost nothing.** The browser sends a heartbeat every 5 minutes, and only while the user is active; new messages arrive by WebSocket push, not polling; the new-version check reads a static file from nginx and never reaches the API.
- **The load comes from people who are actually working.** Opening a page, searching or paging each sends a few API requests.

So estimate capacity by the number of people working at the same time:

> requests per second needed ≈ people working at the same time × requests per person per second

For example — **these figures are assumptions, not measurements**: if one action sends 3–5 requests and a practiced user acts every 10–30 seconds, each person produces about 0.1–0.5 requests per second. At that rate the default 2 workers (about 190 req/s with a p95 around 70 ms) cover roughly **400–1,900 people working at once**.

Your usage will differ, and so will the result. The reliable way is to test once before going live with realistic data, as described [below](#how-do-i-test-it-myself).

## How do I scale when it's not enough?

**Add workers or replicas.** One worker that saturates a CPU core does about 110 req/s. Going from 1 to 2 workers measured about 116 → 190 req/s. This machine mixes performance and efficiency cores and runs under WSL2, so scaling beyond that couldn't be measured reliably; test it on a server with uniform cores.

**Count database connections before adding workers.** Each process holds up to `DATABASE_POOL_SIZE + DATABASE_POOL_MAX_OVERFLOW` connections (10 + 20 by default). API workers plus Celery worker processes, multiplied by that, must stay below the database's `max_connections`. On a PostgreSQL limited to 100 connections, 8 workers hit `too many clients` at peak load and requests failed. The deployment check is in the [go-live checklist](/en/getting-started/deployment/#checklist-before-going-live).

**Overload queues before it errors.** Up to 64 concurrent requests, the 2 workers had a p95 of about 0.9 s and zero failures. That only shows a smooth slowdown within the tested range; queueing isn't unlimited.

## Where does the time go, and what can I tune?

A request uses about 7–8 ms of CPU, spread across authentication, routing, dependency injection, the database query and serialization; no single part dominates. This release already rewrote three middlewares as plain ASGI, cutting CPU per request by 8.5%.

Two more measured costs stay on by default, because they buy stability and auditability. The method and raw numbers are in the [`middleware` notes](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/middleware/AGENTS.md):

| Item | Saving if turned off | Why it's on by default |
|---|---|---|
| Ping before handing out a connection (`DATABASE_POOL_PRE_PING`) | About 2.6% CPU (about 0.2 ms per request); 3 fewer database round trips each time a connection is checked out | After a database restart or failover, no request gets a dead connection. Can be turned off in `.env` |
| Operation log for every request, GET included | About 13% CPU (about 1 ms per request, including the background batch writes) | "Who looked at what, and when" is part of the audit trail. Logs are redacted inside the request, then written in batches in the background. There is currently no switch to turn it off |

## How do I test it myself?

The repository ships a load-test script that only uses the backend's own dependencies:

```bash
pnpm loadtest --base-url http://127.0.0.1:8088/api/v1 --username <ordinary-user> --password <password> --stages 1,8,16,32,64 -d 20
```

- The default target is port 8088 from `pnpm dev`. To test the production setup, start `uvicorn --workers N` without `--reload` and point `--base-url` at it.
- It only sends GET requests and writes no business data (apart from the sign-in and operation logs). A non-local target needs `--allow-remote`. **Don't load-test production.**
- The first line prints the name and version the server reports. Check it says `fastapi-react-admin`: local ports are often taken by other projects.
- Use an **ordinary user** with full permissions. A superuser takes a different code path.
- The sign-in endpoint is limited to 5 requests per minute, so the script signs in once and reuses the token. With the captcha on, add `--redis-container <redis container>` to read the answer from Redis.
- Other programs on the same machine make results vary by ±10%. Run several rounds when comparing two versions.

## What it doesn't promise

- **It isn't a production server benchmark.** Different hardware or a different database will give different numbers.
- **Only read endpoints were tested.** Heavy operations such as export, import, AI chat and file upload weren't.
- **The data is the seed data.** How fast list queries are on large tables depends on database configuration and indexes.
- **No nginx or network in the path.** A real deployment adds reverse-proxy and network time.

## Where is the code?

- Load-test script: [`scripts/loadtest.py`](https://github.com/yile2020/fastapi-react-admin/blob/main/scripts/loadtest.py)
- Test records and method: [`scripts/AGENTS.md`](https://github.com/yile2020/fastapi-react-admin/blob/main/scripts/AGENTS.md)
- Connection pool settings: [`database/db.py`](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/database/db.py), [`core/conf.py`](https://github.com/yile2020/fastapi-react-admin/blob/main/apps/api/backend/core/conf.py)
- Middlewares: [`middleware/`](https://github.com/yile2020/fastapi-react-admin/tree/main/apps/api/backend/middleware)

---
title: Deploying to a server
description: Deploy fastapi-react-admin with Docker Compose from images CI pushes to GHCR — three files on the server, migrations before start, one health URL, rollback by commit tag.
sidebar:
  order: 2
---

Production runs from Docker images that CI builds and pushes to GitHub Container Registry (GHCR) after every green `main` build. The server only needs Docker and three files: `docker-compose.prod.yml`, the `prod.sh` script and an `.env.server` with your settings. `prod.sh up` runs Alembic migrations first and starts the services only if they succeed.

## What runs in production?

`docker-compose.prod.yml` starts the API, a Celery worker, a separate Celery beat (scheduler) and the web container (nginx serving the built frontend and proxying the API). The database and Redis are yours — point `.env.server` at them.

:::caution
In development the worker runs with an embedded beat (`celery worker -B`). Don't do that in production: with several replicas, every replica would run its own beat and each schedule would fire N times. Production runs exactly one beat container.
:::

## How do I install it on a new server?

No repository clone is needed:

```bash
mkdir -p /srv/fastapi-react-admin && cd $_
base=https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/main
curl -fsSLO $base/docker-compose.prod.yml
curl -fsSL  $base/deploy/prod.sh -o prod.sh
curl -fsSL  $base/apps/api/deploy/backend/docker-compose/.env.server.example -o .env.server

# Fill in every CHANGE_ME, then hand the file to the container user (uid 1000)
vi .env.server
chown 1000:1000 .env.server && chmod 600 .env.server

# Machine-specific values go here; the compose file stays byte-identical to the repo
cat > .env <<'EOF'
FBA_ENV_FILE=./.env.server
FBA_WEB_PORT=8080
EOF

bash prod.sh pull && bash prod.sh up
```

`prod.sh` refuses to start if the config file is missing, readable by group or others, or still contains `CHANGE_ME`. TLS is left to whatever sits in front (a load balancer, Caddy, an nginx reverse proxy): the stack exposes one plain HTTP port.

Back up the database before the first deployment against an existing one.

## Checklist before going live

- [ ] Every `CHANGE_ME` in `.env.server` is replaced. With `ENVIRONMENT='prod'` the backend checks length and randomness and refuses to start on weak values
- [ ] `TOKEN_SECRET_KEY` is freshly generated (`python -c "import secrets;print(secrets.token_urlsafe(32))"`), not copied from another environment
- [ ] `CORS_ALLOWED_ORIGINS` is your real address; behind nginx or a load balancer, `TRUSTED_PROXIES` is set — otherwise rate limits and IP allow-lists see the proxy's address
- [ ] If you use the AI assistant, object storage, group bots or the open platform, their encryption keys are set (`AI_ENCRYPT_SECRET_KEY`, `STORAGE_ENCRYPT_SECRET_KEY`, `NOTIFICATION_ENCRYPT_SECRET_KEY`, `OPEN_SECRET_KEY`) — without them saving those settings fails instead of storing plaintext
- [ ] `NOTIFICATION_WEB_BASE_URL` is your real address, or links in emails and group messages point at `localhost:8888`
- [ ] The admin password is the strong one set during initialization, not the demo's `123456`
- [ ] The database is backed up before the first deployment against it, and scheduled backups exist
- [ ] TLS is provided by the reverse proxy or load balancer, and HTTP redirects to HTTPS
- [ ] External monitoring probes `/api/health/status`, not `/healthz`
- [ ] Log retention meets your compliance requirements. Login and operation logs are kept for 180 days by default, because China's Cybersecurity Law requires network logs to be kept for at least six months. To change it, edit the `days` argument of 清理历史日志 (prune old logs) under Scheduler → Task scheduling; data change records have their own retention setting under System config → Logs. An operation log row averages about 2 KB, so 10,000 rows a day for 180 days is roughly 4 GB; plan disk space accordingly
- [ ] You noted the current image tag (`sha-<commit>`) so you know what to roll back to

## How do I update or roll back?

```bash
bash prod.sh status   # which commit is running, and how far behind main it is
bash prod.sh pull
bash prod.sh up
```

Pushing new images does **not** update servers automatically — deploying is a deliberate step. Every image is also tagged `sha-<short SHA>` and `sha-<full SHA>`, so rolling back is a pull of an older tag, without waiting for a build:

```bash
TAG=sha-abc1234 bash prod.sh pull
TAG=sha-abc1234 bash prod.sh up
```

## What should external monitoring check?

One URL: `https://<your-domain>/api/health/status`. It reports the API, database, Redis, scheduler (beat) and worker, and returns **200** only when all of them are healthy, **503** otherwise.

```json
{"status":"ok","services":{"api":{"status":"ok"},"database":{"status":"ok"},"redis":{"status":"ok"},"scheduler":{"status":"ok","last_seen_seconds":12},"worker":{"status":"ok","last_seen_seconds":31}},"heartbeat_max_age_seconds":180}
```

:::caution
Don't monitor `/healthz`. It is nginx answering `200` by itself and stays green with the API and database down. For the same reason, probing a path that doesn't exist through the domain returns `200` and `index.html` (the frontend's history fallback) — check the body, not just the status.
:::

## Can I build the images myself?

Yes, when the server can't reach GHCR — it needs the full repository on that machine:

```bash
pnpm deploy:prod:build
pnpm deploy:prod
```

Use either `pull` or a local build, not both: otherwise which image `up` runs depends on which command last touched the local image cache.

## Further reading

- [`deploy/README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/README.md) — every command (in Chinese).
- [`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md) — the pitfalls behind these rules, and why automatic deployment was left out on purpose.
- [Desktop and mobile clients](/en/features/clients/) — installers are built by a separate release workflow.

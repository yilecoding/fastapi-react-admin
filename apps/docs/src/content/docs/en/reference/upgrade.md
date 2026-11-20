---
title: Upgrading
description: How to upgrade — image deployments pull new images and migrations run automatically; forks merge the upstream tag and run migrations. With compatibility promises and a checklist.
sidebar:
  order: 2
---

How you upgrade depends on how you use the project. If you **deploy the published images without changing the code**, pull the new images and restart; migrations run automatically. If you **forked it and built your own features on top**, merge the new upstream version into your repository, then run migrations and tests. Every release on [GitHub Releases](https://github.com/yile2020/fastapi-react-admin/releases) has an "升级" (Upgrade) section saying whether there are database migrations or config changes.

## How are versions numbered?

Semver: breaking any of the compatibility rules below bumps the major version (1.x → 2.0), a big feature bumps the minor version (1.0 → 1.1), fixes only bump the patch (1.0.0 → 1.0.1). From 1.0.0 these rules are formally in force.

The mobile app is versioned separately from the web app. It calls the internal API, so how an older app copes with a newer backend is covered by the "Internal API" row below; see "Mobile app" in the README for what it does and what stays on the web.

## What is promised not to break?

From "1.0 起的兼容约定" in the root [`CLAUDE.md`](https://github.com/yile2020/fastapi-react-admin/blob/main/CLAUDE.md). Breaking any of these requires a major version.

| Surface | Promise |
|---|---|
| Open API `/api/open/v1/*` and the three SDKs | Paths, parameters, response fields, error codes and the signing algorithm are not removed or changed in meaning; only optional parameters and new fields are added. A real break gets `/api/open/v2/*`, and v1 stays |
| Webhook events | Event names, payload fields and signing stay; new events and fields may be added |
| Database migration chain | Any released version can `pnpm db:upgrade` to the latest; migrations that shipped in a tag are never edited — fixes are new migrations |
| Plugin interface | `plugin.toml` fields, the install flow and extension points keep working for third-party plugins |
| Config keys | `.env` keys and settings keys are not renamed; if one must be, old and new work side by side for one minor version |
| Internal API `/api/v1/*` | Not a public API, but installed desktop and mobile clients are respected: removals and path changes overlap old and new for one minor version |

Anything not in the table (pages, components, internal exports of `packages/*`) can change between versions. If you edited those directly, expect merge conflicts there.

The migration promise was tested: on 2026-10-31, a MySQL 8.4 database created by v0.0.1 was upgraded through the whole chain to the then-latest version with zero structural differences from the models.

## How do I upgrade an image deployment?

```bash
bash prod.sh status   # which commit the server runs and how far behind main it is
bash prod.sh pull     # pull the new images
bash prod.sh up       # runs migrations first (one-shot migrate container), then starts the services
```

**Check**: `bash prod.sh status` shows the version you upgraded to, and `https://<your-domain>/api/health/status` returns 200.

Back up the database first. If the new version misbehaves, roll back to an older image by commit tag:

```bash
TAG=sha-abc1234 bash prod.sh pull
TAG=sha-abc1234 bash prod.sh up
```

:::caution
Rolling back the image **does not roll back the database**. If the new version brought migrations, make sure the old code runs on the new schema, or restore the backup first. Each release's "Upgrade" section says whether it has migrations.
:::

All commands are in [Deploying to a server](/en/getting-started/deployment/).

## Upgrading from 1.1.0 to 1.1.1 or later

This applies to image deployments and forks alike, and to jumps across versions (for example 1.1.0 straight to 1.1.2).

**1. Set `CONFIG_ENCRYPT_SECRET_KEY` before upgrading.** From 1.1.1, secret values in system config (the SMTP authorization code `EMAIL_PASSWORD`, and any key ending in `PASSWORD`, `SECRET`, `TOKEN`, `API_KEY` and similar) are stored encrypted. The migration `at000000configsecret` encrypts the plaintext values already in the database with this key:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Put the output in `.env.server` (the template leaves this line empty by default; in a fork's development setup, `apps/api/backend/.env`):

```bash
CONFIG_ENCRYPT_SECRET_KEY='<the 64 hex characters generated above>'
```

In `docker-compose.prod.yml` the api, migrate, worker and beat containers all mount the same `.env.server`, so one place is enough.

:::danger
**If the database holds such a value and the key is missing, the migration stops and the new api does not start.** The log only says "Configure a valid CONFIG_ENCRYPT_SECRET_KEY". Add the key and run `bash prod.sh up` again; the migration can be re-run and never encrypts twice.

If nothing like that was ever saved (for example, no SMTP authorization code was entered in the UI), the upgrade goes through, but saving a secret in the UI later needs the key too, so set it anyway.
:::

**Back up this key and do not change it.** If it is changed or lost, the values already encrypted in the database cannot be decrypted.

**2. This version brings two new migrations**: `as000000whsecrets` (webhook signing-secret history) and `at000000configsecret` (config secret encryption). `bash prod.sh up` runs them.

**3. HTTPS deployments add `COOKIE_SECURE=true` to `.env.server`** and restart. The current template already has it; config files copied from an older template do not.

**4. External-link and embedded menu addresses must be full `http://` or `https://` URLs.** Existing menus with relative addresses still display, but editing and saving one is rejected (422) until the address is made absolute.

**5. Rotate the SMTP authorization code.** The system config read API in older versions returned it in plaintext.

:::caution
**Rolling back to 1.1.0 requires restoring the pre-upgrade database backup.** The migration's downgrade does not turn ciphertext back into plaintext, and 1.1.0 cannot read the new format.
:::

## How do I upgrade a fork with my own features?

Add upstream as a remote and **merge a tag** (not `main`, which may contain unreleased changes):

```bash
git remote add upstream https://github.com/yile2020/fastapi-react-admin.git   # once
git fetch upstream --tags
git merge v0.12.0            # the version you are upgrading to
```

After resolving conflicts:

```bash
pnpm install:all             # dependencies may have changed
pnpm db:upgrade              # run upstream's new migrations
pnpm typecheck --force       # don't trust the turbo cache here
pnpm test                    # backend tests (needs a local fba_test database, see CONTRIBUTING.md)
```

**Check**: `pnpm db:current` is at head, `pnpm typecheck --force` and the backend tests pass, and after `pnpm dev` you can sign in and open a few of your own pages.

### What if the merge leaves two migration heads?

If you wrote your own migrations and upstream added some in this version, the chain forks into two heads and `pnpm db:upgrade` reports multiple heads. Create a merge migration with Alembic:

```bash
cd apps/api/backend
uv run alembic heads                       # confirm there are two
uv run alembic merge heads -m "merge upstream v0.12.0"
cd ../../.. && pnpm db:upgrade
```

The repository's guard test `test_single_head` also turns red when there are two heads.

:::caution
**Don't edit upstream's migration files**, even when a conflict lands in one. Databases that already ran an old migration never run it again, so an edit only makes new installs differ from old ones — silently. Fix mistakes with a new migration.
:::

### Where do conflicts usually happen?

In files both you and upstream changed — typically the menu and permission seed data (`backend/sql/*/init_snowflake_test_data.sql`), the frontend page registry (`apps/web/src/lib/page-registry.tsx`), the sidebar and route files. Keeping your features in new files, directories or plugins instead of editing the foundation's files keeps future upgrades quiet.

## How do the desktop and mobile apps upgrade?

- Desktop: download the new installer from [Releases](https://github.com/yile2020/fastapi-react-admin/releases) and install over the old one. In-app auto-update only runs when your pages call the update check — see [Desktop and mobile clients](/en/features/clients/)
- Mobile: rebuild and redistribute the app

Old clients call the new backend with their old frontend, which is why internal API removals keep a one-minor-version overlap.

## Checklist before upgrading

- [ ] Read the "Upgrade" section of the target release (and of every release you skip)
- [ ] Back up the database
- [ ] Know whether this version has migrations or config changes; upgrading from 1.1.0, read [that section](#upgrading-from-110-to-111-or-later) above first
- [ ] Upgrade a test environment first and smoke-test it (sign in, a few core pages, one approval)
- [ ] Have the rollback image tag ready (`sha-<old commit>`)
- [ ] After upgrading production, check that `/api/health/status` returns 200

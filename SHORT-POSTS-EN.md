# English posts

Reddit r/FastAPI and Show HN. Post both at **21:00–23:00 Beijing time** (US morning), Tue–Thu, and stay around for two hours to reply.

Before posting: the demo's seed data (users, notices, approvals) is in Chinese. The UI switches to English from the language menu on the sign-in page. Say so up front, or readers will assume it is a Chinese-only project.

## r/FastAPI

**Flair**: Show and tell (or whatever the project-showcase flair is called at the time)

**Title**:

```
I open-sourced a FastAPI + React 19 admin starter with row-level data permissions (v1.0)
```

**Body**:

```markdown
I kept rebuilding users / roles / menus / approvals for every internal tool, so I turned it into a starter and just tagged 1.0.

- GitHub: https://github.com/yilecoding/fastapi-react-admin
- Docs: https://yilecoding.github.io/fastapi-react-admin/en/
- Live demo: https://fra.wubunan.com (admin / 123456, public instance). The seed data is in Chinese; switch the UI to English from the language menu on the sign-in page.

**Backend side, since this is r/FastAPI:**

- Three layers (api / service / crud) plus a plugin system. Workflow, AI, open API, notifications, OAuth2 etc. are plugins with their own routes, models, seed data and tests
- Row-level data permissions applied in the DAO layer: the current user sits in a ContextVar and every query gets the filter automatically. Celery tasks have no request user, so they must say whose permissions to use, otherwise nothing is filtered
- Snowflake IDs serialized as strings at the encoder level (JS loses precision past 2^53, and it is not only JSON.parse that bites)
- PostgreSQL / SQL Server / MySQL from the same code and the same Alembic chain
- SQLAlchemy 2 async, Pydantic 2, Redis, Celery, Socket.IO, OpenDAL for local disk or S3
- AK/SK-signed open API with Python / Node / Java SDKs, plus Standard Webhooks
- An AI assistant whose tools are exactly the endpoints the current user can call, same permission and data-scope checks, writes need a dry run and the user's confirmation
- 1400+ pytest tests against a real database and Redis, no mocks; CI runs the full suite on PostgreSQL and SQL Server

Frontend is React 19 + TanStack Router / Query + shadcn/ui (Base UI). Tabs use React 19.2's `<Activity>`, so a half-filled form survives switching tabs.

The backend started as a fork of fastapi-best-architecture. MIT licensed.

I'd love feedback on the data-permission design in particular. Happy to answer questions.
```

Screenshots: Reddit allows one image post or a link post, not both. Post it as a text post and let the GitHub README carry the screenshots.

## Show HN

HN rules: the title starts with `Show HN:`, no superlatives, no emoji. Submit the GitHub URL as the link, then post the text below as the **first comment** right away.

**Title** (≤ 80 chars):

```
Show HN: FastAPI and React 19 admin starter with row-level permissions
```

**URL**: `https://github.com/yilecoding/fastapi-react-admin`

**First comment**:

```
Hi HN, I built this because every internal tool I worked on needed the same base: users, roles, menus, departments, approvals, audit logs. Most admin templates stop at "menu + button" permissions. I needed "which rows can this role see", e.g. a department manager only sees users in their own department.

What might be interesting:

- Data permissions live in the DAO layer. The current user is in a ContextVar and every query gets the row filter. Background jobs have no request user, so they have to name whose permissions they run with; otherwise there is no filtering. That rule caught several bugs.
- Tabs keep state using React 19.2's <Activity>: all open tabs stay mounted, hidden ones are just hidden. It works, but it has quiet failure modes (effects re-run on reveal, global DOM queries hit hidden tabs, URL-driven drawers leak across tabs). I wrote these up in the repo docs.
- The AI assistant can only call the endpoints the signed-in user can call, with the same checks. Writes are previewed and need the user's confirmation, and every call is audited.
- Tests hit a real database and browser: 1400+ backend, 150+ Playwright. CI runs the backend suite on PostgreSQL and SQL Server.

Demo: https://fra.wubunan.com (admin / 123456). It's a public instance with Chinese seed data; the UI switches to English from the language menu. The demo has no LLM key, so the AI assistant won't answer there.

It's 1.0 and MIT. I'd appreciate criticism of the permission model and the tab approach.
```

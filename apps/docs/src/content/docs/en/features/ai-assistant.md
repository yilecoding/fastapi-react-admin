---
title: AI assistant
description: A chat assistant whose tool calls run as the signed-in user, with the same permissions and data scope, confirmed writes and every call audited.
sidebar:
  order: 4
---

The AI assistant is a chat interface (a full page, plus a side drawer you can open over any screen) that answers questions and performs admin tasks by calling registered backend tools. Every tool call runs as the signed-in user, inside that user's permission codes and row-level data scope. A write action is previewed first and only runs after the user clicks **Confirm**. Every call, including refused ones, is written to an audit table, and external systems can reach the same tools through an MCP gateway that applies the same checks.

## Where is it in the UI?

| Screen | Path | What it is |
|---|---|---|
| **AI assistant → Chat** | `/ai/chat` | Full-page chat. The open conversation is kept in the URL (`?c=<id>`), so a refresh keeps it |
| Robot icon in the top bar | — | Side drawer. It is non-modal, so the table underneath stays usable while you ask about it. `Esc` closes it, and its width is remembered per device |
| **AI assistant → Model credentials** | `/ai/provider` | Model providers and their API keys |
| **AI assistant → Tool logs** | `/ai/tool-log` | Audit of every tool call |
| **AI assistant → MCP credentials** | `/ai/mcp-client` | Tokens for external systems |

Both chat entry points share one hook ([`use-chat-session.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/ai-chat/use-chat-session.ts)), and the drawer and the page can sit on different conversations. Chatting requires the `ai:chat:use` permission and a back-office (`is_staff`) account, because the chat endpoint is a POST behind the same RBAC check as every other write endpoint. The seed data deliberately gives the AI menus to no non-superuser role. Which roles get them is up to each deployment.

:::note[Live demo]
In the [demo](https://fra.wubunan.com/sign-in) (`admin` / `123456`), these pages are under **AI assistant**. Each deployment configures its own model key, so don't count on the demo chat answering. When no provider is configured, the chat shows an explicit "no model provider configured" error instead of failing silently.
:::

## Which model providers can it use?

Every provider is called through the OpenAI-compatible `POST {base_url}/chat/completions` with streaming. The backend uses plain `httpx` and no vendor SDK ([`llm/client.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/llm/client.py)). The provider type only pre-fills defaults:

| Type | Default `base_url` | Default model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Qwen (DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Custom / self-hosted gateway | — | — |

For each provider you also set a timeout (1–600 s, default 120), whether to verify TLS (turn it off for an internal gateway with a self-signed certificate) and whether to go through the system proxy. Chat uses the provider marked as default, or any enabled one if none is. **Test connection** sends one short message over the same `/chat/completions` path and reports the latency once the first frame arrives. Requests include OpenAI-style `tools` with `tool_choice: "auto"`, so the model behind the gateway must support function calling.

API keys are AES-encrypted with `AI_ENCRYPT_SECRET_KEY` (64 hex characters, kept in `.env`). If that key is empty, saving a provider key fails with an explicit error. Nothing is stored in plaintext. API responses only ever contain a mask such as `sk-abc***xyz`, never the plaintext or the ciphertext.

```toml
# apps/api/backend/plugin/ai/plugin.toml (defaults)
AI_AGENT_ENGINE = "native"            # or "pydantic_ai"; both go through the same dispatcher
AI_CONFIRM_MUTATING_TOOLS = true      # false = write tools run without confirmation
AI_CONFIRM_TOKEN_EXPIRE_SECONDS = 300
AI_MAX_TOOL_ROUNDS = 5                # consecutive tool rounds allowed in one turn
AI_CHAT_RATE_PER_MINUTE = 20          # messages per user per minute (per user, not per IP)
AI_TOOL_DOMAINS = ["system", "role", "dept", "menu", "user", "log", "weather", "workflow"]
AI_MCP_ENABLED = false
```

`native` is a hand-written OpenAI-compatible function-calling loop. `pydantic_ai` hands the tools to pydantic-ai as an external toolset that the framework itself cannot execute. According to the plugin notes, both engines produced the same tool-call sequence for the same prompts on an internal gateway running Qwen3-VL.

## How does the assistant stay inside the user's permissions?

The model, and the engine that drives it, are treated as untrusted. They can only *propose* a tool call. A single module, [`core/dispatcher.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/dispatcher.py), decides whether the call runs, and it is the only layer of the plugin that cannot be swapped out:

1. **The tool list is filtered before the model sees it.** A tool is listed only if the user holds its permission code. The rule is the same one the HTTP RBAC check uses (`user_has_perm` next to `rbac_verify` in [`rbac.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/rbac.py)). Write tools also require `is_staff`. Tools from disabled plugins, and from domains missing from `AI_TOOL_DOMAINS`, are left out.
2. **Every call is checked again when it runs.** A hallucinated tool name, a permission removed mid-conversation, or a write sent through a read-only channel all end as `denied`, and the refusal is audited.
3. **The data scope is set on every call.** Each tool runs inside `scoped_to_user(ctx.user)`, so queries through `DataScopedCRUD` return only the rows that user may see. The dispatcher doesn't rely on the JWT middleware having set this context, because non-JWT entry points such as MCP would otherwise run with no row filter. See [Data permissions](/en/features/data-permissions/).
4. **Engines never hold anything executable.** An engine receives `ToolSchema` objects (name, description, JSON Schema, `mutating`), which are plain data with no handler. A guard test fails if code under `engines/` touches `.handler` or imports the tool registry.

Superusers bypass permission codes and data scopes, so the seeded `admin` account sees every tool. Tool results are sent back to the model provider, so they are trimmed before they leave: results are cut at 4,000 characters, and `user_list` returns at most 30 rows without email or phone number.

## What happens before a write action runs?

12 of the 23 built-in tools change data. For each of them:

1. The model proposes the call, and the dispatcher runs the tool's **preview** inside the user's data scope. Every write tool must have a preview; registering one without it raises `TypeError`. The preview runs the same service validation as the real write (for example `dept_service.check_update`), so the preview and the actual write always apply the same rules.
2. If the preview fails (the department doesn't exist, it is outside your scope, a sibling already has that name…), no confirmation is offered. The reason goes back to the model, which tells the user.
3. Otherwise a one-time token (`cf_…`) is stored in Redis for 300 seconds, along with the tool, arguments, user, preview text and source channel. The chat shows a confirmation card with the preview sentence.
4. On **Confirm**, `POST /api/v1/ai/chat/tools/confirm` checks that the token belongs to the current user, claims it with an atomic Redis `DELETE`, and dispatches the call again with the full permission checks. The card is then replaced by the result, so it can't be clicked twice.

The atomic claim fixed a real bug. Before the fix, five concurrent confirmations of one token ran the change five times. [`tests/test_ai_confirm.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/tests/test_ai_confirm.py) now checks that exactly one wins, against real Redis with a warmed connection pool.

:::caution
Setting `AI_CONFIRM_MUTATING_TOOLS = false` removes step 3, and writes then run as soon as the model asks for them. There are no delete tools at all: deletions can't be undone and cascade to child records, users and role grants.
:::

## Which tools ship with it, and how do I add one?

| Domain | Read | Write (preview + confirm) |
|---|---|---|
| system | `system_health_check`, `system_whoami` | — |
| user | `user_list` | — |
| dept | `dept_list` | `dept_create`, `dept_rename`, `dept_set_leader` |
| role | `role_list` | `role_create`, `role_rename`, `role_set_status`, `role_update_menus` |
| menu | `menu_list` | `menu_create`, `menu_set_status` |
| log | `login_log_list`, `opera_log_list` | — |
| weather | `weather_query` | — |
| workflow | `wf_todo_list`, `wf_instance_detail` | `wf_approve`, `wf_reject`, `wf_transfer` |

The workflow tools live in the workflow plugin ([`ai_tools.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/ai_tools.py)) and go through the same authorization function as the approval buttons. A user can approve from chat only what they could approve on the page. To add a tool, decorate an async function with `@ai_tool` in `plugin/ai/tools/` or in your own plugin's `ai_tools.py`. Both locations are discovered automatically ([`core/registry.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/registry.py)):

```python
@ai_tool(
    name='dept_rename',
    description='…',            # written for the model: when to use this tool
    domain='dept',
    perm='sys:dept:edit',       # an existing RBAC code, not a second permission model
    mutating=True,
    preview=_preview_rename,    # required when mutating=True
)
async def dept_rename(db: AsyncSession, ctx: RunContext, dept_id: str, new_name: str) -> dict[str, Any]:
    ...
```

The JSON Schema the model sees is generated from the function signature. The `db` and `ctx` parameters are injected by the dispatcher and hidden from the model.

## What is recorded in the audit log?

Each call writes one row to `ai_tool_invocation`: user, conversation, tool name, status (success, failed, denied or pending confirmation), permission code, arguments redacted with the operation log's key list (`OPERA_LOG_REDACT_KEYS`), result summary, error, duration and channel (`mcp:<client_id>` for MCP calls).

*Denied* is deliberately kept apart from *failed*. If someone keeps asking the AI to do things they aren't allowed to, those attempts show up on their own instead of being lost among ordinary errors.

The audit insert runs inside a SAVEPOINT, so if it fails, only that one audit row is lost and the conversation carries on (measured in [`test_ai_audit.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/tests/test_ai_audit.py)). The log is under **AI assistant → Tool logs** (permission `ai:log:list`). In the chat itself, each answer shows its tool trace (tool, permission code, outcome, duration) above the text, and the trace is saved with the message.

## How do external systems use the same tools over MCP?

`/api/v1/ai/mcp` speaks MCP Streamable HTTP (stateless, JSON responses). It is off by default: with `AI_MCP_ENABLED = false` it returns 404. The gateway doesn't execute anything itself. It lists tools through the same filter and runs calls through the same dispatcher, so permissions, data scope and audit work exactly as in the web chat. To issue a credential, go to **AI assistant → MCP credentials**. The `fra_mcp_…` token is shown once, and only its SHA-256 hash is stored.

```http
POST /api/v1/ai/mcp
Authorization: Bearer fra_mcp_<token>
X-Acting-User: <username>
```

The external system declares which user it is acting for, so the gateway trusts that claim only as far as the credential allows ([`mcp_gateway/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/mcp_gateway/auth.py)):

- **`act_as` allow-list:** the usernames this credential may act for (`*` means any non-superuser). Acting for a superuser requires `allow_superuser`.
- **Same account checks as login:** a disabled account, department or role can't be acted for.
- **Read-only by default:** with `allow_write` set, a write tool only runs its preview and returns a link, `AI_WEB_BASE_URL/ai/confirm?token=…`. The person being acted for must sign in to the web app and click Confirm there. Anyone else who opens the link gets 403.
- **Optional `tools` allow-list:** it can only narrow what the user could already do.
- **Rate limit per credential:** 120 requests per minute by default, answered with 429 and `Retry-After`. A per-IP limit would put every user of one external system in a single bucket. A per-user limit would let a leaked token get a fresh quota by switching identities.

Disabling, deleting or regenerating a credential takes effect on the next request, because nothing is cached. Disabling the AI plugin closes the gateway. The plugin notes record a test run against a real uvicorn server with the official `mcp` Python client: a STAFF account was refused `dept_list`, a user outside the allow-list got 403 at the HTTP layer, four calls left four audit rows tagged `mcp:e2e`, and with a quota of 5, seven requests returned 5 × 200 and 2 × 429 (`Retry-After: 60`).

## What does it not do?

- It has no delete tools. There is also no "rename menu" tool: menu titles are translated per language, so a rename would appear to succeed but leave the English UI unchanged.
- A preview is a one-sentence description, not a field-by-field diff.
- At most `AI_MAX_TOOL_ROUNDS` (5) rounds of tool calls run per message. The native engine doesn't compress context for long sessions.
- MCP write confirmations always happen on the web page and are never answered by the MCP client.

## How is it tested?

Backend tests run against a real test database and Redis. The counts below are `def test_` functions; parametrized cases add more.

| File | Tests | Covers |
|---|---|---|
| `test_ai_security.py` | 28 | permission parity, data-scope anchoring, engines without executables, secrets kept out of responses, stream parsing |
| `test_ai_mcp.py` / `test_ai_mcp_clients.py` | 21 / 8 | gateway auth, `act_as`, read-only, rate limit, credential lifecycle |
| `test_ai_write_tools.py` / `test_ai_role_menu_tools.py` | 11 / 10 | writes read back from the database, users with a restricted scope |
| `test_ai_pydantic_engine.py` | 10 | the second engine, same event sequence as `native` |
| `test_ai_confirm.py` · `test_ai_audit.py` · `test_ai_chat_limit.py` · `test_ai_read_tools.py` | 3 · 1 · 1 · 2 | token race, audit isolation, 429, every read tool executed |
| `plugin/workflow/tests/test_ai_workflow_tools.py` | 12 | approve / reject / transfer from chat |

For most of these guards, the plugin notes also record a mutation test: the check was removed and the matching test turned red. The Playwright specs `ai-chat-confirm.spec.ts` and `ai-chat-limit.spec.ts` stub the SSE responses with `page.route`, so CI never calls a model.

## Where it lives in the code

- [`plugin/ai/core/dispatcher.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/dispatcher.py): permission filter, data scope, confirmation, audit
- [`plugin/ai/core/registry.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/registry.py): `@ai_tool`, schema generated from the signature, auto-discovery
- [`plugin/ai/service/chat_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/service/chat_service.py): SSE chat and the confirm flow
- [`plugin/ai/engines/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/ai/engines) · [`plugin/ai/tools/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/ai/tools) · [`plugin/ai/mcp_gateway/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/ai/mcp_gateway)
- [`plugin/ai/plugin.toml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/plugin.toml): all settings with comments
- [`packages/platform/src/pages/ai-chat/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/ai-chat): chat page, drawer, confirmation card
- [`plugin/ai/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/AGENTS.md): design notes and measured pitfalls (in Chinese)

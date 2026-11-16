"""投递：抢占 → SSRF 检查 → 签名 POST → 记一次尝试 → 落状态 / 退避 / 自动停用（#167 第四、五节）。

结果判定（Standard Webhooks + Svix 原文）：

| 响应 | 处理 |
|---|---|
| 2xx | 成功 |
| 3xx | 失败，**不跟随重定向**（跟随 = 给 SSRF 开门；规范建议对方改 URL） |
| 410 Gone | 放弃这一条，端点立即停用 |
| 其他 / 超时 / 连接失败 / 地址被拦 | 失败，按退避重试；次数用完 → 放弃 |

自动停用：连续失败 ≥ `OPEN_WEBHOOK_DISABLE_AFTER` **且**这一轮第一次失败已经过去 24 小时。只按次数的话，对方夜里重启
十分钟、正好赶上一批事件，就会被当成死端点（Svix 用的同样是「次数 + 时长」双条件）。停用后给应用创建人发一条通知。
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import time

from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import httpx

from backend import __version__
from backend.common.log import log
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.plugin.open.crud.crud_app import open_app_dao
from backend.plugin.open.crud.crud_webhook import open_event_dao, open_webhook_dao, open_webhook_delivery_dao
from backend.plugin.open.enums import WebhookDeliveryStatus, WebhookDisabledReason
from backend.plugin.open.model import OpenWebhookAttempt
from backend.plugin.open.service import webhook_sign
from backend.plugin.open.service.secret import decrypt
from backend.plugin.open.service.webhook_config import backoff_schedule, max_attempts, webhook_settings
from backend.plugin.open.service.webhook_secrets import active_previous_secrets
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from backend.plugin.open.model import OpenApp, OpenEvent, OpenWebhook, OpenWebhookDelivery

USER_AGENT = f'fastapi-react-admin-webhook/{__version__}'
DISABLE_WINDOW = timedelta(hours=24)

#: 测试用：换成 `httpx.MockTransport`。生产永远是 None（走真实网络）
transport: httpx.AsyncBaseTransport | None = None


# ── SSRF ─────────────────────────────────────────────────────────────────────


async def _resolve(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=0)
    return list(dict.fromkeys(info[4][0] for info in infos))


def _blocked_ip(raw: str) -> bool:
    ip = ipaddress.ip_address(raw.split('%', 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    # is_global = 不是回环 / 私网 / 链路本地 / 保留 / 未指定 / CGNAT …（标准库按 IANA 表算）
    return not ip.is_global or ip.is_multicast


def url_problem(url: str) -> str | None:
    """不连网的那部分检查：协议 + 有没有主机。返回问题描述，没问题返回 None"""
    try:
        parts = urlsplit(url)
    except ValueError:
        return 'invalid_url'
    allow_http = settings.ENVIRONMENT == 'dev' or settings.OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK
    if parts.scheme != 'https' and not (allow_http and parts.scheme == 'http'):
        return 'https_required'
    if not parts.hostname:
        return 'invalid_url'
    return None


async def check_target(url: str) -> str | None:
    """**每次尝试前**都解析一次主机名：命中回环 / 私网 / 链路本地等一律拒绝（返回原因）。

    ⚠️ 残余风险是 DNS 重绑定（检查时是公网 IP、连接时换成内网）。一期不做「按解析出的 IP 连接 + 自带 Host/SNI」；
    部署层把 worker 放在访问不到内部服务的网段（`deploy/AGENTS.md`）。
    """
    problem = url_problem(url)
    if problem:
        return problem
    if settings.OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK:
        return None
    parts = urlsplit(url)
    host = parts.hostname or ''
    port = parts.port or (443 if parts.scheme == 'https' else 80)
    try:
        addresses = await _resolve(host, port)
    except OSError as e:
        return f'dns_failed: {e!s}'
    blocked = [a for a in addresses if _blocked_ip(a)]
    if not addresses or blocked:
        return f'blocked_address: {host} → {", ".join(blocked or addresses)}'
    return None


# ── 发 ───────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class AttemptResult:
    response_code: int | None
    error: str | None
    duration_ms: int
    request_headers: dict[str, str]
    response_headers: dict[str, str] | None = None
    response_body: str | None = None

    @property
    def ok(self) -> bool:
        return self.response_code is not None and 200 <= self.response_code < 300


def _signing_secrets(hook: OpenWebhook) -> list[str]:
    return [decrypt(hook.secret_cipher)] + [
        decrypt(cipher) for cipher, _ in active_previous_secrets(hook, timezone.now())
    ]


async def _read_capped(resp: httpx.Response) -> bytes | None:
    """只读前 `OPERA_LOG_RESPONSE_MAX_SIZE` 字节（再多一个字节，让截断提示知道「被截断了」），其余不读。

    🔴 `client.post()` 会把整个响应读进内存、之后才截断 —— 对方回一个超大 body 就是 worker 的内存（#307）。
    读够就停：连接随 `stream()` 退出直接关掉，不再排空。

    🔴 压缩的响应**一个字节都不读**，返回 None：解压是按网络块整块做的，64 KB 的 gzip 能解出几十 MB，
    读到上限再停已经晚了。请求里声明了 `accept-encoding: identity`，但那只是请求 —— 对方照样可以回压缩的
    """
    if resp.headers.get('content-encoding', '').strip().lower() not in ('', 'identity'):
        return None
    cap = settings.OPERA_LOG_RESPONSE_MAX_SIZE + 1
    buf = bytearray()
    async for chunk in resp.aiter_bytes():
        buf += chunk
        if len(buf) >= cap:
            break
    return bytes(buf[:cap])


def _full_size(resp: httpx.Response) -> str:
    """没读完的响应有多大：对方声明了就用声明值，没声明（分块传输）只知道「超过上限」"""
    declared = resp.headers.get('content-length', '')
    return declared if declared.isdigit() else f'超过 {settings.OPERA_LOG_RESPONSE_MAX_SIZE}'


async def _post(hook: OpenWebhook, event: OpenEvent) -> AttemptResult:
    body = event.payload.encode()
    ts = int(time.time())
    headers = {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        # 不要压缩：响应只读前 10 KB，压缩了反而让一小段网络字节解出一大块内存（见 _read_capped）
        'accept-encoding': 'identity',
        webhook_sign.HEADER_ID: str(event.id),
        webhook_sign.HEADER_TIMESTAMP: str(ts),
    }
    try:
        headers[webhook_sign.HEADER_SIGNATURE] = webhook_sign.signature_header(
            _signing_secrets(hook), str(event.id), ts, body
        )
    except Exception as e:
        # 密钥解不开（OPEN_SECRET_KEY 换了 / 没配）：记成这一次的失败，别让整批卡在 sending 上
        return AttemptResult(None, f'sign_failed: {e!s}', 0, headers)
    # 落库的那份把签名打码：签名本身不能重放出新消息，但没必要让日志表成为第二个保存它的地方
    logged = {**headers, webhook_sign.HEADER_SIGNATURE: '[REDACTED]'}
    started = time.perf_counter()

    def _ms() -> int:
        return int((time.perf_counter() - started) * 1000)

    # 总时长还要明显短于「停在发送中多久算 worker 死了」：否则还在发的这一行会被 reclaim_stale 抢回去再发一遍
    limit = min(settings.OPEN_WEBHOOK_TIMEOUT_SECONDS, settings.OPEN_WEBHOOK_SENDING_STALE_SECONDS / 2)
    try:
        # 🔴 httpx 的 timeout 是 connect / read / write / pool **各自**的上限，不是整次请求的：对方每隔不到 limit 秒
        # 回一个字节，这次投递就一直挂着，直到任务级 with_timeout 把它取消 —— 取消时不落库，这一行停在 sending，
        # attempts / 连续失败都不涨（#307，实测）。所以外面再套一层**总时长**，超了按普通失败落库。
        # SSRF 检查的 DNS 解析也在里面：域名的权威 DNS 是对方的，慢慢回也能拖住
        async with asyncio.timeout(limit):
            blocked = await check_target(hook.url)
            if blocked:
                return AttemptResult(None, blocked, _ms(), logged)
            async with (
                httpx.AsyncClient(
                    timeout=limit,
                    follow_redirects=False,
                    transport=transport,
                    # 代理只认进程环境变量（短信插件那条结论），配置里不做代理字段
                    trust_env=True,
                ) as client,
                client.stream('POST', hook.url, content=body, headers=headers) as resp,
            ):
                content = await _read_capped(resp)
    except (TimeoutError, httpx.TimeoutException):
        return AttemptResult(None, f'timeout: {limit}s', _ms(), logged)
    except httpx.HTTPError as e:
        return AttemptResult(None, f'{type(e).__name__}: {e!s}', _ms(), logged)
    content_type = (resp.headers.get('content-type') or '').split(';')[0].strip().lower()
    if content is None:
        response_body = f'[未记录：对方返回了 {resp.headers.get("content-encoding")} 压缩的响应，没有解压]'
    else:
        raw = OperaLogMiddleware.redact_body(content, content_type)
        response_body = OperaLogMiddleware.truncate_body(raw, full_size=_full_size(resp))
    error = None
    if 300 <= resp.status_code < 400:
        error = f'redirect: 不跟随重定向（Location: {resp.headers.get("location", "")}），请把地址改成最终那一个'
    elif not 200 <= resp.status_code < 300:
        error = f'http_{resp.status_code}'
    return AttemptResult(
        response_code=resp.status_code,
        error=error,
        duration_ms=_ms(),
        request_headers=logged,
        response_headers=OperaLogMiddleware.collect_headers(resp.headers),
        response_body=response_body,
    )


# ── 一条 ─────────────────────────────────────────────────────────────────────


def _app_unusable(app: OpenApp | None) -> str | None:
    if app is None or app.deleted:
        return 'app_missing'
    if app.status != 1:
        return 'app_disabled'
    if app.expire_time is not None and app.expire_time <= timezone.now():
        return 'app_expired'
    return None


def _give_up_reason(
    delivery: OpenWebhookDelivery, hook: OpenWebhook | None, event: OpenEvent | None, app: OpenApp | None
) -> str | None:
    """这一条还发不发：端点 / 事件没了、端点停用了（测试事件除外）、应用停用 / 过期 —— 都不发"""
    if hook is None:
        return 'endpoint_missing'
    if event is None:
        return 'event_missing'
    if hook.status != 1 and delivery.event_type != 'ping':
        # 停用的端点不发（测试事件除外：管理员可能正是要在启用前先测一下）
        return 'endpoint_disabled'
    return _app_unusable(app)


def _settle_values(result: AttemptResult, *, attempts: int, is_ping: bool) -> dict[str, Any]:
    values: dict[str, Any] = {
        'attempts': attempts,
        'last_response_code': result.response_code,
        'last_error': result.error,
        'last_duration_ms': result.duration_ms,
        'next_attempt_time': None,
    }
    if result.ok:
        values |= {'status': WebhookDeliveryStatus.success.value, 'success_time': timezone.now()}
    elif result.response_code == 410 or attempts >= max_attempts() or is_ping:
        # 测试事件不重试：管理员在界面上等着看结果，重试只会让「失败」变成过几小时才出现的一行
        values['status'] = WebhookDeliveryStatus.exhausted.value
    else:
        schedule = backoff_schedule()
        delay = schedule[min(attempts, len(schedule)) - 1]
        values |= {
            'status': WebhookDeliveryStatus.failed.value,
            'next_attempt_time': timezone.now() + timedelta(seconds=delay),
        }
    return values


async def deliver_one(pk: int, *, now_even_if_not_due: bool = False) -> str | None:
    """抢一行、发、落终态。返回新状态（没抢到返回 None）"""
    async with async_db_session.begin() as db:
        if not await open_webhook_delivery_dao.claim(db, pk, any_retryable=now_even_if_not_due):
            return None
    async with async_db_session() as db:
        delivery = await open_webhook_delivery_dao.get(db, pk)
        hook = await open_webhook_dao.get(db, delivery.webhook_id) if delivery else None
        event = await open_event_dao.get(db, delivery.event_id) if delivery else None
        app = await open_app_dao.get(db, hook.app_id) if hook else None
    if delivery is None:
        return None

    give_up = _give_up_reason(delivery, hook, event, app)
    if give_up:
        await _settle(pk, status=WebhookDeliveryStatus.exhausted.value, last_error=give_up, next_attempt_time=None)
        return WebhookDeliveryStatus.exhausted.value

    assert hook is not None and event is not None and app is not None
    result = await _post(hook, event)
    attempts = delivery.attempts + 1
    values = _settle_values(result, attempts=attempts, is_ping=delivery.event_type == 'ping')

    dispatch = None
    try:
        async with async_db_session.begin() as db:
            db.add(
                OpenWebhookAttempt(
                    delivery_id=pk,
                    attempt=attempts,
                    url=hook.url,
                    request_headers=result.request_headers,  # type: ignore[arg-type]
                    response_code=result.response_code,
                    response_headers=result.response_headers,  # type: ignore[arg-type]
                    response_body=result.response_body,
                    error=result.error,
                    duration_ms=result.duration_ms,
                )
            )
            await open_webhook_delivery_dao.settle(db, pk, **values)
            if delivery.event_type != 'ping':
                dispatch = await _track_endpoint(db, hook.id, app, ok=result.ok, gone=result.response_code == 410)
    except Exception as e:
        # 发出去了但结果没落库：停在 sending，超时后 reclaim_stale 改回失败重发 —— 对方按 webhook-id 去重
        log.error(f'Webhook 投递 {pk} 更新结果失败（{values.get("status")}）：{e!s}')
    if dispatch is not None:
        await dispatch.after_commit()
    return values['status']


async def _settle(pk: int, **values: Any) -> None:
    async with async_db_session.begin() as db:
        await open_webhook_delivery_dao.settle(db, pk, **values)


async def _track_endpoint(db: Any, hook_id: int, app: OpenApp, *, ok: bool, gone: bool) -> Any:
    """更新端点的连续失败计数；该停用就停用并通知应用创建人。返回通知的 Dispatch（提交后要 after_commit）"""
    hook = await open_webhook_dao.get(db, hook_id)
    if hook is None:
        return None
    now = timezone.now()
    hook.last_delivery_time = now
    if ok:
        hook.last_success_time = now
        hook.consecutive_failures = 0
        hook.first_failure_time = None
        return None
    hook.consecutive_failures += 1
    hook.first_failure_time = hook.first_failure_time or now
    reason = None
    if gone:
        reason = WebhookDisabledReason.gone
    elif hook.status == 1:
        cfg = await webhook_settings(db)
        if hook.consecutive_failures >= cfg.disable_after and now - hook.first_failure_time >= DISABLE_WINDOW:
            reason = WebhookDisabledReason.auto
    if reason is None or hook.status != 1:
        return None
    hook.status = 0
    hook.disabled_reason = reason.value
    hook.disabled_time = now
    log.warning(f'Webhook 端点 {hook.id}（{hook.url}）已停用：{reason.value}，连续失败 {hook.consecutive_failures} 次')
    return await _notify_disabled(db, hook, app, reason)


def _display_url(url: str) -> str:
    """通知正文里的端点地址：只留协议 + 主机 + 端口 + 路径。

    🔴 这条通知能被群机器人订阅，正文会推到飞书 / 钉钉群里；对接方常把 token 放在查询串或 userinfo 里
    """
    try:
        u = urlsplit(url)
        port = f':{u.port}' if u.port else ''
    except ValueError:
        return '-'
    return f'{u.scheme}://{u.hostname or ""}{port}{u.path}'


async def _notify_disabled(db: Any, hook: OpenWebhook, app: OpenApp, reason: WebhookDisabledReason) -> Any:
    if app.created_by is None:
        return None
    from backend.common.i18n import t
    from backend.plugin.core import check_plugin_installed

    if not check_plugin_installed('notification'):
        return None
    from backend.plugin.notification.service.notification_service import create_in_tx

    return await create_in_tx(
        db,
        kind='open.webhook.disabled',
        user_ids=[app.created_by],
        title=t('open.webhook.disabled_title', name=hook.name),
        content=t(
            f'open.webhook.disabled_{reason.value}',
            app=app.name,
            url=_display_url(hook.url),
            n=hook.consecutive_failures,
        ),
        link=f'/open/app?id={app.id}&tab=webhook',
    )


# ── worker 入口 ──────────────────────────────────────────────────────────────


async def deliver_pending() -> dict[str, int]:
    stats: dict[str, int] = {}
    async with async_db_session.begin() as db:
        stale = await open_webhook_delivery_dao.reclaim_stale(
            db,
            before=timezone.now() - timedelta(seconds=settings.OPEN_WEBHOOK_SENDING_STALE_SECONDS),
            max_attempts=max_attempts(),
        )
    if stale:
        stats['stale'] = stale
        log.warning(f'Webhook 投递：{stale} 行停在「发送中」过久，已改回失败重试')
    last_id = 0
    batch = max(1, settings.OPEN_WEBHOOK_DELIVERY_BATCH)
    while True:
        async with async_db_session() as db:
            ids = await open_webhook_delivery_dao.due_ids(db, after_id=last_id, limit=batch, now=timezone.now())
        if not ids:
            break
        for pk in ids:
            status = await deliver_one(pk)
            key = status or 'skipped_by_other_worker'
            stats[key] = stats.get(key, 0) + 1
        last_id = ids[-1]
        if len(ids) < batch:
            break
    return stats


def attempt_headers_json(value: Any) -> Any:
    """`sa.JSON` 列在不同方言上读回来可能是 str（SQL Server 的 NVARCHAR）"""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value

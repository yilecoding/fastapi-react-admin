"""Webhook 事件订阅（#167）：真实接口 + 测试库 + 假接收端（`httpx.MockTransport`）。

要守的都是「写错了不报错」的那一类：

- 业务改了、对方没收到（漏 fan-out / 漏 scope / 漏踢 worker）—— 或者反过来，没订阅的也收到了
- 签名对不上（body 被序列化了两次 / 轮换期只签了一把）
- 302 被跟随（= SSRF 的门）、410 之后还在重试、对方夜里重启十分钟就被永久停用
- 明文密钥出现在详情、列表、操作日志里
"""

import ast
import base64
import hashlib
import hmac
import json

from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from sqlalchemy import delete, select, update
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.plugin.open.events import WEBHOOK_EVENTS, load_webhook_extensions, matches
from backend.plugin.open.gateway.auth import SCOPES
from backend.plugin.open.model import OpenEvent, OpenWebhook, OpenWebhookAttempt, OpenWebhookDelivery
from backend.plugin.open.service import event_service, webhook_delivery, webhook_sign
from backend.plugin.open.service.webhook_delivery import check_target, deliver_one
from backend.plugin.open.tests.conftest import CODE_PREFIX, SDK_DIR, create_app, run_db
from backend.plugin.open.tests.test_open_api import _dept_id, _hard_delete_dept
from backend.utils.timezone import timezone

HOOKS = '/open-webhooks'
DELIVERIES = '/open-webhook-deliveries'
URL = 'https://hooks.example.test/receive'


class Receiver:
    """假接收端：记下每个请求，按 `status` 回应（可以是一个序列，逐次用）"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status: int | list[int] = 200
        self.headers: dict[str, str] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        code = self.status.pop(0) if isinstance(self.status, list) else self.status
        return httpx.Response(code, headers=self.headers, json={'ok': code < 300})


@pytest.fixture
def receiver(monkeypatch: pytest.MonkeyPatch) -> Receiver:
    r = Receiver()
    monkeypatch.setattr(webhook_delivery, 'transport', httpx.MockTransport(r))
    return r


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[int]]:
    """不连 broker（数踢了几次）；默认放行私网（假接收端的域名解析不了），SSRF 的用例自己关回去"""
    kicks: list[int] = []

    async def _kick() -> None:  # ruff: ignore[unused-async]
        kicks.append(1)

    monkeypatch.setattr(event_service, 'kick', _kick)
    monkeypatch.setattr(settings, 'OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK', True)
    started = timezone.now()
    yield kicks

    async def _purge(db: Any) -> None:
        hook_ids = select(OpenWebhook.id).where(OpenWebhook.name.like(f'{CODE_PREFIX}%'))
        delivery_ids = select(OpenWebhookDelivery.id).where(OpenWebhookDelivery.webhook_id.in_(hook_ids))
        await db.execute(delete(OpenWebhookAttempt).where(OpenWebhookAttempt.delivery_id.in_(delivery_ids)))
        await db.execute(delete(OpenWebhookDelivery).where(OpenWebhookDelivery.webhook_id.in_(hook_ids)))
        await db.execute(delete(OpenWebhook).where(OpenWebhook.name.like(f'{CODE_PREFIX}%')))
        await db.execute(delete(OpenEvent).where(OpenEvent.created_time >= started))

    run_db(_purge)


@pytest.fixture
def kicks(_env: list[int]) -> list[int]:
    return _env


def create_hook(client: TestClient, headers: dict[str, str], app_id: Any, **cfg: Any) -> dict[str, Any]:
    body = {'app_id': str(app_id), 'name': f'{CODE_PREFIX}端点', 'url': URL, 'events': ['dept.*'], **cfg}
    response = client.post(HOOKS, headers=headers, json=body)
    assert response.json()['code'] == 200, response.text
    return response.json()['data']


def create_dept(client: TestClient, headers: dict[str, str], suffix: str) -> int:
    code = f'{CODE_PREFIX}WH{suffix}'
    body = {'code': code, 'name': f'{CODE_PREFIX}事件{suffix}', 'status': 1, 'sort': 0}
    assert client.post('/sys/depts', headers=headers, json=body).json()['code'] == 200
    return run_db(lambda db: _dept_id(db, code))


def deliveries_of(hook_id: Any) -> list[OpenWebhookDelivery]:
    async def _do(db: Any) -> list[OpenWebhookDelivery]:
        stmt = select(OpenWebhookDelivery).where(OpenWebhookDelivery.webhook_id == int(hook_id))
        return list((await db.scalars(stmt.order_by(OpenWebhookDelivery.id))).all())

    return run_db(_do)


def hook_row(hook_id: Any) -> OpenWebhook:
    return run_db(lambda db: db.get(OpenWebhook, int(hook_id)))


def set_hook(hook_id: Any, **values: Any) -> None:
    run_db(lambda db: db.execute(update(OpenWebhook).where(OpenWebhook.id == int(hook_id)).values(**values)))


def verify(secret: str, request: httpx.Request) -> bool:
    return webhook_sign.verify(
        secret,
        request.headers['webhook-id'],
        int(request.headers['webhook-timestamp']),
        request.headers['webhook-signature'],
        request.content,
    )


@pytest.fixture
def subscribed(client: TestClient, token_headers: dict[str, str]) -> dict[str, Any]:
    """一个授权了 user:read + dept:read 的应用，挂一个订阅 dept.* 的端点"""
    app = create_app(client, token_headers)
    hook = create_hook(client, token_headers, app['id'])
    return {'app': app, 'hook': hook}


# ── 事件 → 投递 ──────────────────────────────────────────────────────────────


class TestFanOut:
    def test_dept_change_reaches_the_endpoint_signed(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver, kicks
    ) -> None:
        dept_id = create_dept(client, token_headers, 'A')
        try:
            rows = deliveries_of(subscribed['hook']['id'])
            assert [(r.event_type, r.status) for r in rows] == [('dept.created', 'pending')]
            assert kicks == [1], '提交之后要踢一次 worker（正常路径秒级）'

            assert client.portal.call(deliver_one, rows[0].id) == 'success'
            [request] = receiver.requests
            assert verify(subscribed['hook']['secret_key'], request)
            body = json.loads(request.content)
            assert body['type'] == 'dept.created'
            # 硬纪律 6：ID 一律字符串；thin：只有标识和状态
            assert body['data'] == {
                'id': str(dept_id),
                'code': f'{CODE_PREFIX}WHA',
                'name': f'{CODE_PREFIX}事件A',
                'parent_id': None,
                'status': 1,
            }
            assert request.headers['webhook-id'] == str(rows[0].event_id)
            assert request.headers['user-agent'].startswith('fastapi-react-admin-webhook/')

            detail = client.get(f'{DELIVERIES}/{rows[0].id}', headers=token_headers).json()['data']
            assert detail['status'] == 'success'
            assert detail['payload'] == request.content.decode(), '记下的 payload 就是发出去的那份字节'
            [attempt] = detail['attempts_log']
            assert attempt['response_code'] == 200
            assert attempt['request_headers']['webhook-signature'] == '[REDACTED]'
            assert hook_row(subscribed['hook']['id']).last_success_time is not None
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_unsubscribed_event_is_recorded_but_not_delivered(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], kicks
    ) -> None:
        """订阅的是 dept.*：改用户只记事件，不给这个端点生成投递，也不踢 worker"""
        uid = client.get('/sys/users/me', headers=token_headers).json()['data']['id']
        assert (
            client.put('/sys/users/me/nickname', headers=token_headers, json={'nickname': '管理员'}).json()['code']
            == 200
        )
        events = run_db(lambda db: db.scalars(select(OpenEvent.type).where(OpenEvent.aggregate_id == int(uid)))).all()
        assert 'user.updated' in events, '前置：事件确实产生了'
        assert deliveries_of(subscribed['hook']['id']) == []
        assert kicks == []

    def test_scope_revoked_stops_delivery(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any]
    ) -> None:
        app = subscribed['app']
        detail = client.get(f'/open-apps/{app["id"]}', headers=token_headers).json()['data']
        body = {
            k: detail[k]
            for k in ('name', 'scopes', 'ip_whitelist', 'rate_per_minute', 'expire_time', 'status', 'remark')
        }
        assert (
            client.put(f'/open-apps/{app["id"]}', headers=token_headers, json={**body, 'scopes': ['user:read']}).json()[
                'code'
            ]
            == 200
        )
        dept_id = create_dept(client, token_headers, 'B')
        try:
            assert deliveries_of(subscribed['hook']['id']) == []
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_disabled_endpoint_gets_nothing(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any]
    ) -> None:
        hook = subscribed['hook']
        current = client.get(f'{HOOKS}/{hook["id"]}', headers=token_headers).json()['data']
        body = {k: current[k] for k in ('name', 'url', 'events', 'remark')}
        assert (
            client.put(f'{HOOKS}/{hook["id"]}', headers=token_headers, json={**body, 'status': 0}).json()['code'] == 200
        )
        assert hook_row(hook['id']).disabled_reason == 'manual'
        dept_id = create_dept(client, token_headers, 'C')
        try:
            assert deliveries_of(hook['id']) == []
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_rollback_takes_the_event_with_it(self, client: TestClient, subscribed: dict[str, Any], kicks) -> None:
        """outbox：业务回滚，事件和投递一起没了，也不踢"""
        from backend.common.domain_events import emit
        from backend.tests.utils.db import async_test_db_session

        async def _emit_then_rollback() -> None:
            async with async_test_db_session() as db:
                await emit(db, 'dept.updated', aggregate_id=1, data={'id': 1})
                await db.rollback()

        client.portal.call(_emit_then_rollback)
        assert deliveries_of(subscribed['hook']['id']) == []
        assert run_db(lambda db: db.scalars(select(OpenEvent).where(OpenEvent.aggregate_id == 1))).all() == []
        assert kicks == []

    def test_unregistered_type_is_a_bug(self, client: TestClient) -> None:
        from backend.common.domain_events import emit
        from backend.tests.utils.db import async_test_db_session

        async def _emit() -> None:
            async with async_test_db_session() as db:
                await emit(db, 'dept.renamed', aggregate_id=1, data={})

        with pytest.raises(ValueError, match='没有登记'):
            client.portal.call(_emit)


def _event_types(aggregate_id: int) -> list[str]:
    stmt = select(OpenEvent.type).where(OpenEvent.aggregate_id == aggregate_id).order_by(OpenEvent.id)
    return list(run_db(lambda db: db.scalars(stmt)).all())


def test_dept_lifecycle_emits_every_step(client: TestClient, token_headers: dict[str, str]) -> None:
    """漏一处 emit = 那类变更对方永远收不到，而且不报错。建 / 改 / 删各走一次真实接口"""
    dept_id = create_dept(client, token_headers, 'L')
    try:
        body = {'name': f'{CODE_PREFIX}改名', 'status': 1, 'sort': 0}
        assert client.put(f'/sys/depts/{dept_id}', headers=token_headers, json=body).json()['code'] == 200
        assert client.delete(f'/sys/depts/{dept_id}', headers=token_headers).json()['code'] == 200
        assert _event_types(dept_id) == ['dept.created', 'dept.updated', 'dept.deleted']
        updated = json.loads(
            run_db(
                lambda db: db.scalars(
                    select(OpenEvent.payload).where(OpenEvent.aggregate_id == dept_id, OpenEvent.type == 'dept.updated')
                )
            ).one()
        )
        assert updated['data']['name'] == f'{CODE_PREFIX}改名', '发的是改之后的值，不是 ORM 实例上的旧值'
    finally:
        run_db(lambda db: _hard_delete_dept(db, dept_id))


def test_user_lifecycle_emits_every_step(client: TestClient, token_headers: dict[str, str]) -> None:
    from sqlalchemy import text

    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
    role_id = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]['id']
    body = {
        'username': 'pytest_wh_user',
        'password': 'Tmp@123456',
        'nickname': '事件',
        'dept_id': dept_id,
        'roles': [role_id],
    }
    res = client.post('/sys/users', headers=token_headers, json=body).json()
    assert res['code'] == 200, res
    pk = int(res['data']['id'])

    async def _purge(db: Any) -> None:
        await db.execute(text('DELETE FROM sys_user_role WHERE user_id = :pk'), {'pk': pk})
        await db.execute(text('DELETE FROM sys_user WHERE id = :pk'), {'pk': pk})

    try:
        assert (
            client.put(f'/sys/users/{pk}/permissions', headers=token_headers, params={'type': 'status'}).json()['code']
            == 200
        )
        assert client.delete(f'/sys/users/{pk}', headers=token_headers).json()['code'] == 200
        assert _event_types(pk) == ['user.created', 'user.status_changed', 'user.deleted']
        changed = json.loads(
            run_db(
                lambda db: db.scalars(
                    select(OpenEvent.payload).where(
                        OpenEvent.aggregate_id == pk, OpenEvent.type == 'user.status_changed'
                    )
                )
            ).one()
        )
        assert changed['data'] == {'id': str(pk), 'username': 'pytest_wh_user', 'dept_id': dept_id, 'status': 0}
    finally:
        run_db(_purge)


# ── 结果判定 ────────────────────────────────────────────────────────────────


class TestOutcomes:
    def _one(self, client: TestClient, token_headers: dict[str, str], hook_id: Any, suffix: str) -> tuple[int, int]:
        dept_id = create_dept(client, token_headers, suffix)
        [row] = deliveries_of(hook_id)
        return dept_id, row.id

    def test_5xx_retries_with_backoff_then_gives_up(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        hook_id = subscribed['hook']['id']
        dept_id, pk = self._one(client, token_headers, hook_id, 'R')
        try:
            receiver.status = 500
            before = timezone.now()
            assert client.portal.call(deliver_one, pk) == 'failed'
            [row] = deliveries_of(hook_id)
            assert row.attempts == 1
            assert timedelta(seconds=14) < row.next_attempt_time - before < timedelta(seconds=20)
            # 没到点不发：worker 抢不到
            assert client.portal.call(deliver_one, pk) is None
            # 剩下的几次（到点由 any_retryable 模拟）
            for _ in range(4):
                client.portal.call(lambda: deliver_one(pk, now_even_if_not_due=True))
            [row] = deliveries_of(hook_id)
            assert (row.status, row.attempts) == ('exhausted', 5)
            assert len(receiver.requests) == 5
            assert hook_row(hook_id).consecutive_failures == 5
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_redirect_is_not_followed(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        hook_id = subscribed['hook']['id']
        dept_id, pk = self._one(client, token_headers, hook_id, 'D')
        try:
            receiver.status = 302
            receiver.headers = {'location': 'http://169.254.169.254/latest/meta-data'}
            assert client.portal.call(deliver_one, pk) == 'failed'
            assert len(receiver.requests) == 1, '跟随了重定向'
            assert 'redirect' in deliveries_of(hook_id)[0].last_error
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_410_disables_the_endpoint_at_once(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        hook_id = subscribed['hook']['id']
        dept_id, pk = self._one(client, token_headers, hook_id, 'G')
        try:
            receiver.status = 410
            assert client.portal.call(deliver_one, pk) == 'exhausted'
            hook = hook_row(hook_id)
            assert (hook.status, hook.disabled_reason) == (0, 'gone')
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    @pytest.mark.parametrize(('first_failed_hours_ago', 'disabled'), [(25, True), (1, False)])
    def test_auto_disable_needs_both_count_and_24_hours(
        self,
        client: TestClient,
        token_headers: dict[str, str],
        subscribed: dict[str, Any],
        receiver: Receiver,
        first_failed_hours_ago: int,
        disabled: bool,  # ruff: ignore[boolean-type-hint-positional-argument] —— pytest 参数化按名字注入
    ) -> None:
        """只按次数的话，对方夜里重启十分钟、正好赶上一批事件，就会被当成死端点"""
        hook_id = subscribed['hook']['id']
        dept_id, pk = self._one(client, token_headers, hook_id, f'X{first_failed_hours_ago}')
        try:
            set_hook(
                hook_id,
                consecutive_failures=settings.OPEN_WEBHOOK_DISABLE_AFTER - 1,
                first_failure_time=timezone.now() - timedelta(hours=first_failed_hours_ago),
            )
            receiver.status = 500
            client.portal.call(deliver_one, pk)
            hook = hook_row(hook_id)
            assert hook.consecutive_failures == settings.OPEN_WEBHOOK_DISABLE_AFTER, '前置：次数已经够了'
            assert (hook.status == 0) is disabled
            assert (hook.disabled_reason == 'auto') is disabled
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_success_resets_the_failure_streak(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        hook_id = subscribed['hook']['id']
        dept_id, pk = self._one(client, token_headers, hook_id, 'S')
        try:
            set_hook(hook_id, consecutive_failures=7, first_failure_time=timezone.now() - timedelta(hours=30))
            client.portal.call(deliver_one, pk)
            hook = hook_row(hook_id)
            assert (hook.consecutive_failures, hook.first_failure_time) == (0, None)
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_two_workers_send_once(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        """抢占看 UPDATE 的 rowcount：同一行两个 worker 同时拿，只有一个发"""
        import asyncio

        hook_id = subscribed['hook']['id']
        dept_id, pk = self._one(client, token_headers, hook_id, 'W')
        try:

            async def _both() -> list[str | None]:
                return list(await asyncio.gather(deliver_one(pk), deliver_one(pk)))

            results = client.portal.call(_both)
            assert sorted(results, key=lambda r: r or '') == [None, 'success']
            assert len(receiver.requests) == 1
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_resend_puts_an_exhausted_delivery_back(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        hook_id = subscribed['hook']['id']
        dept_id, pk = self._one(client, token_headers, hook_id, 'Z')
        try:
            # 还在排队的不能重发（会发两遍）
            assert client.post(f'{DELIVERIES}/{pk}/resend', headers=token_headers).json()['code'] == 409
            receiver.status = 410
            client.portal.call(deliver_one, pk)
            assert client.post(f'{DELIVERIES}/{pk}/resend', headers=token_headers).json()['code'] == 200
            [row] = deliveries_of(hook_id)
            assert (row.status, row.attempts) == ('pending', 0)
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))


# ── 密钥 ───────────────────────────────────────────────────────────────────


class TestSecret:
    def test_plaintext_only_in_the_create_response(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any]
    ) -> None:
        hook, app = subscribed['hook'], subscribed['app']
        secret = hook['secret_key']
        assert secret.startswith('whsec_') and len(base64.b64decode(secret[6:])) == 24
        detail = client.get(f'{HOOKS}/{hook["id"]}', headers=token_headers)
        listing = client.get(HOOKS, headers=token_headers, params={'app_id': app['id']})
        for body in (detail.text, listing.text):
            assert f'{CODE_PREFIX}端点' in body, '前置：这条记录在响应里'
            assert secret not in body
            assert 'secret_cipher' not in body

    def test_opera_log_redacts_it(self, client: TestClient, token_headers: dict[str, str]) -> None:
        app = create_app(client, token_headers, 'LOG')
        response = client.post(
            HOOKS,
            headers=token_headers,
            json={'app_id': app['id'], 'name': f'{CODE_PREFIX}日志', 'url': URL, 'events': ['dept.created']},
        )
        secret = response.json()['data']['secret_key']
        logged = OperaLogMiddleware.redact_body(response.content, 'application/json').decode()
        assert secret not in logged and json.loads(logged)['data']['secret_key'] == '[REDACTED]'

    def test_rotation_signs_with_both_keys_for_a_day(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        hook = subscribed['hook']
        new = client.post(f'{HOOKS}/{hook["id"]}/secret', headers=token_headers).json()['data']['secret_key']
        assert new != hook['secret_key']
        dept_id = create_dept(client, token_headers, 'K')
        try:
            [row] = deliveries_of(hook['id'])
            client.portal.call(deliver_one, row.id)
            [request] = receiver.requests
            assert len(request.headers['webhook-signature'].split(' ')) == 2
            assert verify(hook['secret_key'], request), '旧密钥还要能验 —— 对方有一天时间换配置'
            assert verify(new, request)
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))


# ── 保存前的检查 ─────────────────────────────────────────────────────────────


class TestValidation:
    def _post(self, client: TestClient, headers: dict[str, str], app_id: Any, **cfg: Any) -> dict[str, Any]:
        body = {'app_id': app_id, 'name': f'{CODE_PREFIX}校验', 'url': URL, 'events': ['dept.*'], **cfg}
        return client.post(HOOKS, headers=headers, json=body).json()

    def test_unknown_event(self, client: TestClient, token_headers: dict[str, str]) -> None:
        app = create_app(client, token_headers)
        res = self._post(client, token_headers, app['id'], events=['dept.renamed', 'role.*'])
        assert res['code'] == 400 and 'dept.renamed' in res['msg'] and 'role.*' in res['msg']

    def test_scope_must_be_granted(self, client: TestClient, token_headers: dict[str, str]) -> None:
        """应用只授权了 dept:read，订 user.* 存进去的话，端点永远收不到东西"""
        app = create_app(client, token_headers, scopes=['dept:read'])
        res = self._post(client, token_headers, app['id'], events=['user.*'])
        assert res['code'] == 400 and '读取用户' in res['msg']
        assert self._post(client, token_headers, app['id'], events=['dept.*'])['code'] == 200

    def test_workflow_scope_is_grantable(self, client: TestClient, token_headers: dict[str, str]) -> None:
        """`workflow:read` 没有开放接口、只用于订阅：勾选框里要有它，保存时也要认"""
        scopes = client.get('/open-apps/scopes', headers=token_headers).json()['data']
        assert 'workflow:read' in {s['scope'] for s in scopes}
        app = create_app(client, token_headers, scopes=['workflow:read'])
        assert self._post(client, token_headers, app['id'], events=['workflow.instance.*'])['code'] == 200

    def test_per_app_limit(self, client: TestClient, token_headers: dict[str, str], monkeypatch) -> None:
        monkeypatch.setattr(settings, 'OPEN_WEBHOOK_MAX_PER_APP', 1)
        # 参数配置组里那一行会盖过 settings：关掉组开关，读回 settings
        from backend.plugin.open.service import webhook_config

        async def _settings(db: Any) -> Any:  # ruff: ignore[unused-async] —— 替换的是一个 async 函数
            return webhook_config.WebhookSettings(enabled=True, disable_after=20, retention_days=30, max_per_app=1)

        monkeypatch.setattr('backend.plugin.open.service.webhook_service.webhook_settings', _settings)
        app = create_app(client, token_headers)
        assert self._post(client, token_headers, app['id'])['code'] == 200
        res = self._post(client, token_headers, app['id'])
        assert res['code'] == 400 and '1' in res['msg']

    def test_scheme(self, client: TestClient, token_headers: dict[str, str]) -> None:
        app = create_app(client, token_headers)
        res = self._post(client, token_headers, app['id'], url='ftp://hooks.example.test/x')
        assert res['code'] == 400 and 'https_required' in res['msg']


class TestSsrf:
    @pytest.fixture(autouse=True)
    def _strict(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, 'OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK', False)
        table = {'hooks.example.test': ['93.184.216.34'], 'evil.example.test': ['93.184.216.34', '192.168.1.5']}

        async def _resolve(host: str, port: int) -> list[str]:  # ruff: ignore[unused-async]
            if host in table:
                return table[host]
            return [host]  # IP 字面量原样返回

        monkeypatch.setattr(webhook_delivery, '_resolve', _resolve)

    @pytest.mark.parametrize(
        'url',
        [
            'https://127.0.0.1/x',
            'https://10.0.0.1/x',
            'https://169.254.169.254/latest',
            'https://[::1]/x',
            'https://[::ffff:192.168.0.1]/x',
            'https://100.64.0.1/x',
            # 解析结果里只要有一个是内网就拒（攻击者控制的域名可以同时给公网和内网地址）
            'https://evil.example.test/x',
        ],
    )
    def test_private_targets_are_refused(self, client: TestClient, url: str) -> None:
        problem = client.portal.call(check_target, url)
        assert problem is not None and problem.startswith('blocked_address'), problem

    def test_public_target_passes(self, client: TestClient) -> None:
        assert client.portal.call(check_target, 'https://hooks.example.test/x') is None

    def test_saving_a_private_url_is_refused(self, client: TestClient, token_headers: dict[str, str]) -> None:
        app = create_app(client, token_headers)
        res = client.post(
            HOOKS,
            headers=token_headers,
            json={
                'app_id': app['id'],
                'name': f'{CODE_PREFIX}内网',
                'url': 'https://127.0.0.1/x',
                'events': ['dept.*'],
            },
        ).json()
        assert res['code'] == 400 and 'blocked_address' in res['msg']

    def test_checked_again_at_send_time(
        self, client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
    ) -> None:
        """保存时是公网、之后 DNS 改成了内网：每次尝试前都要再查一次"""
        hook_id = subscribed['hook']['id']
        set_hook(hook_id, url='https://evil.example.test/x')
        dept_id = create_dept(client, token_headers, 'V')
        try:
            [row] = deliveries_of(hook_id)
            assert client.portal.call(deliver_one, row.id) == 'failed'
            assert receiver.requests == []
            assert deliveries_of(hook_id)[0].last_error.startswith('blocked_address')
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))


# ── 测试事件 / 审批流 ─────────────────────────────────────────────────────────


def test_ping_is_sent_right_away(
    client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
) -> None:
    res = client.post(f'{HOOKS}/{subscribed["hook"]["id"]}/ping', headers=token_headers).json()
    assert res['code'] == 200 and res['data']['status'] == 'success' and res['data']['response_code'] == 200
    [request] = receiver.requests
    assert json.loads(request.content)['type'] == 'ping'
    assert verify(subscribed['hook']['secret_key'], request)


def test_failed_ping_is_not_retried(
    client: TestClient, token_headers: dict[str, str], subscribed: dict[str, Any], receiver: Receiver
) -> None:
    """管理员在界面上等结果：失败就是失败，不排进退避（否则「失败」变成几小时后才冒出来的一行）"""
    receiver.status = 500
    res = client.post(f'{HOOKS}/{subscribed["hook"]["id"]}/ping', headers=token_headers).json()['data']
    assert (res['status'], res['response_code']) == ('exhausted', 500)
    assert hook_row(subscribed['hook']['id']).consecutive_failures == 0, '测试事件不算进连续失败'


def test_workflow_start_and_withdraw_emit_events(client: TestClient) -> None:
    from backend.plugin.workflow.tests.test_runtime import act, leave_form, start

    def _login(name: str) -> dict[str, str]:
        res = client.post('/auth/login/swagger', params={'username': name, 'password': '123456'}).json()
        return {'Authorization': f'Bearer {res["access_token"]}'}

    admin = _login('admin')

    def _uid(name: str) -> str:
        users = client.get('/sys/users', headers=admin, params={'username': name}).json()['data']['items']
        return str(users[0]['id'])

    pk = start(client, _login('sunqiang'), leave_form(_uid))
    assert act(client, _login('sunqiang'), pk, 'withdraw', opinion='不请了').json()['code'] == 200
    rows = run_db(
        lambda db: db.execute(
            select(OpenEvent.type, OpenEvent.payload).where(OpenEvent.aggregate_id == int(pk)).order_by(OpenEvent.id)
        )
    ).all()
    assert [r.type for r in rows] == ['workflow.instance.started', 'workflow.instance.withdrawn']
    data = json.loads(rows[1].payload)['data']
    assert data['id'] == pk and data['status'] == 'withdrawn' and data['definition_code'] == 'LEAVE'
    # thin：只有标识和状态，没有表单内容（表单里什么都可能有 —— 金额、身份证、病假原因）
    assert set(data) == {'id', 'definition_code', 'title', 'status', 'initiator_id', 'biz_type', 'biz_id'}


# ── 守卫 ───────────────────────────────────────────────────────────────────


def test_every_event_has_a_known_scope(client: TestClient) -> None:
    load_webhook_extensions()
    assert len(WEBHOOK_EVENTS) >= 12, '前置：内置 7 个 + 审批 5 个都登记了'
    assert {e.scope for e in WEBHOOK_EVENTS.values()} <= set(SCOPES)


def test_every_emitted_type_is_registered() -> None:
    """扫源码里 `emit(db, '<字面量>')` / `emit_user_event(db, '<字面量>')` / `emit_dept_event(...)` —— 拼错一个，
    那条写路径一走就 ValueError（整笔业务回滚）。审批流是 f-string，按 InstanceStatus 全集核对"""
    load_webhook_extensions()
    root = Path(__file__).resolve().parents[3]
    names = {'emit', 'emit_user_event', 'emit_dept_event'}
    found: set[str] = set()
    for path in root.rglob('*.py'):
        if '/tests/' in str(path) or 'alembic' in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding='utf-8'))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, 'id', getattr(node.func, 'attr', None)) in names:
                args = node.args[1:2]
                if args and isinstance(args[0], ast.Constant) and isinstance(args[0].value, str):
                    found.add(args[0].value)
    assert len(found) >= 7, f'前置：扫到了用户 / 部门那几处：{found}'
    assert found <= set(WEBHOOK_EVENTS), found - set(WEBHOOK_EVENTS)

    from backend.plugin.workflow.enums import InstanceStatus

    for status in InstanceStatus:
        name = 'started' if status == InstanceStatus.running else status.value
        assert f'workflow.instance.{name}' in WEBHOOK_EVENTS


def test_wildcard_matching() -> None:
    assert matches(['user.*'], 'user.created')
    assert not matches(['user.*'], 'users.created'), '前缀要带点，不能把 users.* 也吞进来'
    assert matches(['workflow.instance.*'], 'workflow.instance.approved')
    assert not matches(['dept.created'], 'dept.updated')


def test_signature_matches_the_shared_vectors() -> None:
    """三份 SDK 的 verify 和这里对同一组向量（改任何一步两边一起红）"""
    v = json.loads((SDK_DIR / 'test_vectors.json').read_text(encoding='utf-8'))['webhook']
    body = v['body'].encode()
    assert webhook_sign.sign(v['secret'], v['id'], v['timestamp'], body) == v['signature']
    # 按规范手算一遍，不依赖被测的实现
    key = base64.b64decode(v['secret'].removeprefix('whsec_'))
    mac = hmac.new(key, f'{v["id"]}.{v["timestamp"]}.'.encode() + body, hashlib.sha256).digest()
    assert v['signature'] == 'v1,' + base64.b64encode(mac).decode()
    assert webhook_sign.verify(v['secret'], v['id'], v['timestamp'], f'v1,AAAA {v["signature"]}', body)
    assert not webhook_sign.verify(v['secret'], v['id'], v['timestamp'], v['signature'], body + b' ')

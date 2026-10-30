"""群机器人（#166 二期）：协议 · 配置接口 · 路由 · 投递 worker · 发测试消息。

都是「坏了不报错」的那几处：

- 签名的密钥和被签的东西写反了 = 每条都被飞书拒，界面上只看得到「签名校验失败」，像是密钥填错了
- 地址不限制主机 = 有这个权限的人能借服务器去请求内网
- 一条通知发给 3 个人、群里出现 3 次（按收件人展开了）
- 读超时当「没发出去」重试 = 群里同一条出现两次
- 不自己数频率 = 一次批量审批让钉钉 / 企微第 21 条起全被拒，白白耗掉重试

发 HTTP 的那一层换成 `httpx.MockTransport`（`senders.bot_transport`），不连真平台；真平台的实测见分册。
"""

from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import json
import os

from datetime import timedelta
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, quote_plus, urlsplit

import httpx
import pytest

from sqlalchemy import delete, select

from backend.core.conf import settings
from backend.plugin.notification import bot_platforms as bp
from backend.plugin.notification.enums import DeliveryStatus, NotificationCategory
from backend.plugin.notification.kinds import get_notification_kind, register_notification_kind
from backend.plugin.notification.model import Notification, NotificationBot, NotificationDelivery
from backend.plugin.notification.schema.bot import CreateBotParam, UpdateBotParam
from backend.plugin.notification.service import delivery_service, senders
from backend.plugin.notification.service.notification_service import create_in_tx, notification_service
from backend.tests.utils.db import async_test_db_session
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Iterator

    from starlette.testclient import TestClient

API = '/sys/notification-channels/bots'
TITLE = 'PYTEST_BOT'
FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/0123456789abcdef-pytest'
DINGTALK = 'https://oapi.dingtalk.com/robot/send?access_token=abcdef0123456789pytest'
WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123-4567-89ab-pytest'

register_notification_kind(
    'pytest.bot',
    label='测试·群机器人',
    category=NotificationCategory.SYSTEM,
    defaults={'inapp': 'forced'},
    bot=True,
)
register_notification_kind(
    'pytest.bot_broadcast',
    label='测试·群机器人广播',
    category=NotificationCategory.SYSTEM,
    defaults={'inapp': 'forced'},
    user_configurable=False,
    broadcast=True,
    bot=True,
)
register_notification_kind(
    'pytest.personal',
    label='测试·对个人说话',
    category=NotificationCategory.SYSTEM,
    defaults={'inapp': 'forced'},
)


def _call(client: TestClient, fn: Callable[..., Awaitable[Any]], *args: Any, **kwargs: Any) -> Any:
    return client.portal.call(functools.partial(fn, *args, **kwargs))


async def _purge() -> None:
    async with async_test_db_session.begin() as db:
        await db.execute(delete(NotificationDelivery).where(NotificationDelivery.kind.like('pytest%')))
        await db.execute(delete(NotificationBot).where(NotificationBot.name.like(f'{TITLE}%')))
        await db.execute(delete(Notification).where(Notification.title.like(f'{TITLE}%')))


async def _bot_rows(kind: str = 'pytest.bot') -> list[NotificationDelivery]:
    async with async_test_db_session() as db:
        return list(
            (
                await db.scalars(
                    select(NotificationDelivery)
                    .where(NotificationDelivery.kind == kind, NotificationDelivery.channel == 'bot')
                    .order_by(NotificationDelivery.id)
                )
            ).all()
        )


async def _get_bot(pk: int) -> NotificationBot | None:
    async with async_test_db_session() as db:
        return await db.get(NotificationBot, pk)


async def _notify(user_ids: list[int], *, kind: str = 'pytest.bot', rollback: bool = False) -> int:
    async with async_test_db_session() as db:
        dispatch = await create_in_tx(
            db, kind=kind, user_ids=user_ids, title=f'{TITLE} 标题', content='正文', link='/dashboard'
        )
        if rollback:
            await db.rollback()
        else:
            await db.commit()
        return dispatch.pending


async def _admin_ids(n: int) -> list[int]:
    from backend.app.admin.model import User

    async with async_test_db_session() as db:
        return list((await db.scalars(select(User.id).order_by(User.id).limit(n))).all())


class Receiver:
    """假平台：记下每个请求，按剧本回包"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.reply: Callable[[httpx.Request], httpx.Response] = lambda _req: httpx.Response(200, json={'code': 0})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.reply(request)

    def body(self, i: int = -1) -> dict[str, Any]:
        return json.loads(self.requests[i].content)


@pytest.fixture
def receiver(monkeypatch: pytest.MonkeyPatch) -> Receiver:
    r = Receiver()
    monkeypatch.setattr(senders, 'bot_transport', httpx.MockTransport(r.handler))
    return r


@pytest.fixture(autouse=True)
def _isolate(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """不推 socket、不连 broker；加密密钥给一个临时值（CI 的 .env 里没有）"""

    async def _noop(*args: object, **kwargs: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        return None

    async def _noop_config(db: object) -> None:  # ruff: ignore[unused-async]
        return None

    monkeypatch.setattr('backend.plugin.notification.service.notification_service.notification_new', _noop)
    monkeypatch.setattr(delivery_service, 'kick', _noop)
    # 外部渠道总闸由参数配置覆盖：顶掉加载，直接看 settings
    monkeypatch.setattr('backend.plugin.notification.service.config.load_notification_config', _noop_config)
    monkeypatch.setattr(settings, 'NOTIFICATION_EXTERNAL_ENABLED', True)
    monkeypatch.setattr(settings, 'NOTIFICATION_ENCRYPT_SECRET_KEY', os.urandom(32).hex())
    monkeypatch.setattr(settings, 'NOTIFICATION_BOT_EXTRA_URL_PREFIXES', '')
    _call(client, _purge)
    yield
    _call(client, _purge)


def _create(client: TestClient, headers: dict[str, str], **overrides: Any) -> dict[str, Any]:
    body = {'name': f'{TITLE} 飞书', 'platform': 'feishu', 'webhook_url': FEISHU, 'kinds': ['pytest.bot']}
    body.update(overrides)
    res = client.post(API, json=body, headers=headers).json()
    assert res['code'] == 200, res
    return res['data']


# ── 协议（纯函数）────────────────────────────────────────────────────────────


class TestProtocol:
    def test_feishu_sign_uses_the_string_as_key_and_signs_nothing(self) -> None:
        """官方原文：`timestamp\\n密钥` 是 HMAC 的密钥、被签的是空串 —— 和钉钉正好反过来"""
        expected = base64.b64encode(hmac.new(b'1599360473\nsec', b'', hashlib.sha256).digest()).decode()
        assert bp.feishu_sign('sec', 1599360473) == expected
        swapped = base64.b64encode(hmac.new(b'sec', b'1599360473\nsec', hashlib.sha256).digest()).decode()
        assert expected != swapped

    def test_dingtalk_sign_matches_the_official_sample(self) -> None:
        """官方 Python 示例：hmac.new(secret, f'{ts}\\n{secret}') → b64 → quote_plus，毫秒时间戳拼在查询串上"""
        req = bp.build_request(
            'dingtalk',
            DINGTALK,
            secret='SECabc',
            title='t',
            content='c',
            link=None,
            link_label='查看',
            now=1700000000.5,
        )
        q = parse_qs(urlsplit(req.url).query)
        ts = '1700000000500'
        digest = hmac.new(b'SECabc', f'{ts}\nSECabc'.encode(), hashlib.sha256).digest()
        assert q['timestamp'] == [ts]
        assert q['access_token'] == ['abcdef0123456789pytest']
        assert quote_plus(q['sign'][0]) == quote_plus(base64.b64encode(digest).decode())
        assert f'sign={quote_plus(base64.b64encode(digest).decode())}' in req.url

    def test_feishu_body_has_sign_and_a_link_tag_not_markdown(self) -> None:
        req = bp.build_request(
            'feishu',
            FEISHU,
            secret='sec',
            title='标题',
            content='第一行\n[点这里](https://evil.example)',
            link='https://admin.example/x',
            link_label='查看详情',
            now=1599360473.9,
        )
        body = json.loads(req.body)
        assert (body['timestamp'], body['sign']) == ('1599360473', bp.feishu_sign('sec', 1599360473))
        paragraphs = body['content']['post']['zh_cn']['content']
        # 用户填的 markdown 原样当文字，不会变成一个链接
        assert paragraphs[1] == [{'tag': 'text', 'text': '[点这里](https://evil.example)'}]
        assert paragraphs[-1] == [{'tag': 'a', 'text': '查看详情', 'href': 'https://admin.example/x'}]

    def test_wecom_text_is_cut_by_bytes_not_chars(self) -> None:
        """企微 text 上限 2048 字节：按字符截的话 1000 个汉字是 3000 字节，整条被拒"""
        req = bp.build_request(
            'wecom', WECOM, secret=None, title='标题', content='汉' * 1000, link=None, link_label='查看', now=0
        )
        text = json.loads(req.body)['text']['content']
        assert len(text.encode()) <= 2048
        assert text.endswith('…')

    @pytest.mark.parametrize(
        ('platform', 'url', 'ok'),
        [
            ('feishu', FEISHU, True),
            ('feishu', 'https://open.larksuite.com/open-apis/bot/v2/hook/abc', True),
            ('feishu', 'http://open.feishu.cn/open-apis/bot/v2/hook/abc', False),
            ('feishu', 'https://open.feishu.cn.evil.com/open-apis/bot/v2/hook/abc', False),
            ('feishu', 'https://open.feishu.cn:8443/open-apis/bot/v2/hook/abc', False),
            ('feishu', 'https://x@open.feishu.cn/open-apis/bot/v2/hook/abc', False),
            ('feishu', 'https://open.feishu.cn/open-apis/other/abc', False),
            ('feishu', DINGTALK, False),
            ('dingtalk', DINGTALK, True),
            ('wecom', WECOM, True),
            ('wecom', 'https://127.0.0.1/cgi-bin/webhook/send?key=x', False),
        ],
    )
    def test_url_must_sit_on_an_official_prefix(self, platform: str, url: str, *, ok: bool) -> None:
        assert bp.url_allowed(platform, url) is ok

    def test_extra_prefix_opens_exactly_that_prefix(self) -> None:
        extra = ('https://feishu.corp.example/open-apis/bot/v2/hook/',)
        assert bp.url_allowed('feishu', 'https://feishu.corp.example/open-apis/bot/v2/hook/abc', extra)
        assert not bp.url_allowed('feishu', 'https://feishu.corp.example/admin', extra)

    def test_credential_must_be_in_the_url(self) -> None:
        assert not bp.has_credential('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/')
        assert not bp.has_credential('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=')
        assert not bp.has_credential('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send')
        assert bp.has_credential('wecom', WECOM)

    def test_mask_never_shows_the_whole_token(self) -> None:
        for url, token in ((FEISHU, '0123456789abcdef-pytest'), (DINGTALK, 'abcdef0123456789pytest')):
            hint = bp.mask_url(url)
            assert token not in hint and hint.endswith(token[-4:])

    @pytest.mark.parametrize(
        ('platform', 'status', 'body', 'verdict', 'reason'),
        [
            ('feishu', 200, {'code': 0, 'msg': 'success'}, 'sent', None),
            ('feishu', 200, {'code': 19021, 'msg': 'sign match fail'}, 'permanent', 'sign_failed'),
            ('feishu', 200, {'code': 19024, 'msg': 'Key Words Not Found'}, 'permanent', 'keyword_missing'),
            ('feishu', 200, {'code': 11232, 'msg': 'frequency limited'}, 'retryable', 'rate_limited'),
            ('feishu', 400, {'code': 9499, 'msg': 'Bad Request'}, 'permanent', 'bad_request'),
            ('dingtalk', 200, {'errcode': 0, 'errmsg': 'ok'}, 'sent', None),
            ('dingtalk', 200, {'errcode': 310000, 'errmsg': 'keywords not in content'}, 'permanent', 'keyword_missing'),
            ('dingtalk', 200, {'errcode': 310000, 'errmsg': 'sign not match'}, 'permanent', 'sign_failed'),
            ('dingtalk', 200, {'errcode': 130101, 'errmsg': 'send too fast'}, 'retryable', 'rate_limited'),
            ('wecom', 200, {'errcode': 0, 'errmsg': 'ok'}, 'sent', None),
            ('wecom', 200, {'errcode': 45009, 'errmsg': 'api freq out of limit'}, 'retryable', 'rate_limited'),
            ('wecom', 200, {'errcode': 93000, 'errmsg': 'invalid webhook url'}, 'permanent', 'invalid_webhook'),
            ('wecom', 200, {'errcode': 12345, 'errmsg': '没见过'}, 'retryable', 'platform_error'),
            ('feishu', 502, None, 'retryable', 'platform_busy'),
            ('feishu', 404, None, 'permanent', 'http_error'),
        ],
    )
    def test_classify(
        self, platform: str, status: int, body: dict[str, Any] | None, verdict: str, reason: str | None
    ) -> None:
        raw = json.dumps(body).encode() if body is not None else b'<html>nginx</html>'
        assert bp.classify(platform, status, raw)[:2] == (verdict, reason)

    def test_2xx_without_a_readable_code_is_unknown_not_retried(self) -> None:
        """请求已经被收下了，可能已经进了群：重发就是群里出现两次"""
        assert bp.classify('feishu', 200, b'ok')[0] == 'unknown'


class TestRegistry:
    def test_bot_cannot_be_a_per_user_default(self) -> None:
        with pytest.raises(ValueError, match='bot=True'):
            register_notification_kind(
                'pytest.bad_bot',
                label='x',
                category=NotificationCategory.SYSTEM,
                defaults={'inapp': 'forced', 'bot': 'default_on'},
            )

    def test_kinds_that_speak_to_one_person_are_not_offered_to_groups(self) -> None:
        """「抄送给你」「X 退回了你的申请」推到群里，群里每个人读到的都是「你」"""
        from backend.plugin.notification.extensions import load_notification_extensions

        load_notification_extensions()
        for code in ('workflow.cc', 'workflow.task_assigned', 'workflow.remind', 'workflow.sent_back', 'export.done'):
            kind = get_notification_kind(code)
            assert kind is not None and kind.bot is False, code
        for code in ('announcement', 'workflow.result', 'open.webhook.disabled'):
            kind = get_notification_kind(code)
            assert kind is not None and kind.bot is True, code

    def test_credential_fields_are_redacted_from_the_operation_log(self) -> None:
        """地址本身就是凭据：字段名不在脱敏名单里，新建机器人那一下就原样落进了操作日志"""
        for model in (CreateBotParam, UpdateBotParam):
            for field in ('webhook_url', 'sign_secret'):
                assert field in model.model_fields
                assert field in settings.OPERA_LOG_REDACT_KEYS


# ── 配置接口 ─────────────────────────────────────────────────────────────────


class TestApi:
    def test_create_stores_ciphertext_and_lists_only_a_hint(
        self, client: TestClient, token_headers: dict[str, str]
    ) -> None:
        data = _create(client, token_headers, sign_secret='SECfeishu')
        assert data['has_secret'] is True
        assert 'pytest' not in data['webhook_hint'][:-4] and data['webhook_hint'].startswith('open.feishu.cn/')
        assert 'webhook_url' not in data and 'sign_secret' not in data
        bot = _call(client, _get_bot, int(data['id']))
        assert FEISHU not in bot.webhook_cipher and 'SECfeishu' not in (bot.secret_cipher or '')
        listed = client.get(API, headers=token_headers).json()['data']
        assert any(b['id'] == data['id'] for b in listed)

    def test_no_encrypt_key_refuses_instead_of_storing_plaintext(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, 'NOTIFICATION_ENCRYPT_SECRET_KEY', '')
        body = {'name': f'{TITLE} x', 'platform': 'feishu', 'webhook_url': FEISHU, 'kinds': ['pytest.bot']}
        res = client.post(API, json=body, headers=token_headers).json()
        assert res['code'] == 500 and 'NOTIFICATION_ENCRYPT_SECRET_KEY' in res['msg']
        assert client.get(f'{API}/options', headers=token_headers).json()['data']['encrypt_key_ready'] is False

    @pytest.mark.parametrize(
        ('overrides', 'needle'),
        [
            ({'webhook_url': 'https://10.0.0.1/open-apis/bot/v2/hook/abc'}, 'open.feishu.cn'),
            ({'webhook_url': 'https://open.feishu.cn/open-apis/bot/v2/hook/'}, '凭据'),
            ({'platform': 'wecom', 'webhook_url': WECOM, 'sign_secret': 'x'}, '加签'),
            ({'kinds': ['pytest.personal']}, '测试·对个人说话'),
            ({'kinds': ['no.such.kind']}, 'no.such.kind'),
        ],
    )
    def test_create_rejects(
        self, client: TestClient, token_headers: dict[str, str], overrides: dict[str, Any], needle: str
    ) -> None:
        body = {'name': f'{TITLE} x', 'platform': 'feishu', 'webhook_url': FEISHU, 'kinds': ['pytest.bot'], **overrides}
        res = client.post(API, json=body, headers=token_headers).json()
        assert res['code'] == 400 and needle in res['msg'], res

    def test_update_keeps_blank_credentials_and_requires_a_url_on_platform_change(
        self, client: TestClient, token_headers: dict[str, str]
    ) -> None:
        data = _create(client, token_headers, sign_secret='SECfeishu')
        pk = data['id']
        base = {'name': f'{TITLE} 改名', 'platform': 'feishu', 'kinds': ['pytest.bot'], 'status': 1}
        res = client.put(f'{API}/{pk}', json=base, headers=token_headers).json()
        assert res['code'] == 200 and res['data']['has_secret'] is True
        assert res['data']['webhook_hint'] == data['webhook_hint']
        # 换平台不给新地址：旧地址是上一家的
        res = client.put(f'{API}/{pk}', json={**base, 'platform': 'dingtalk'}, headers=token_headers).json()
        assert res['code'] == 400
        res = client.put(f'{API}/{pk}', json={**base, 'clear_sign_secret': True}, headers=token_headers).json()
        assert res['data']['has_secret'] is False
        assert client.delete(f'{API}/{pk}', headers=token_headers).json()['code'] == 200
        assert _call(client, _get_bot, int(pk)) is None

    def test_send_test_reports_the_platform_reason(
        self, client: TestClient, token_headers: dict[str, str], receiver: Receiver
    ) -> None:
        pk = _create(client, token_headers, sign_secret='SECfeishu')['id']
        res = client.post(f'{API}/{pk}/test', headers=token_headers).json()['data']
        assert res['ok'] is True
        body = receiver.body()
        assert body['sign'] == bp.feishu_sign('SECfeishu', int(body['timestamp']))
        assert str(receiver.requests[-1].url) == FEISHU

        receiver.reply = lambda _req: httpx.Response(200, json={'code': 19024, 'msg': 'Key Words Not Found'})
        res = client.post(f'{API}/{pk}/test', headers=token_headers).json()['data']
        assert (res['ok'], res['reason']) == (False, 'keyword_missing')
        assert 'Key Words Not Found' in (_call(client, _get_bot, int(pk)).last_error or '')


# ── 路由：一条通知 × 一个群一行 ──────────────────────────────────────────────


class TestRouting:
    def test_one_row_per_bot_not_per_recipient(self, client: TestClient, token_headers: dict[str, str]) -> None:
        on = _create(client, token_headers)['id']
        _create(client, token_headers, name=f'{TITLE} 停用', status=0)
        _create(client, token_headers, name=f'{TITLE} 没订阅', kinds=['announcement'])
        uids = _call(client, _admin_ids, 3)
        assert _call(client, _notify, uids) == 1
        (row,) = _call(client, _bot_rows)
        assert (row.bot_id, row.user_id, row.address, row.status) == (int(on), None, f'{TITLE} 飞书', 'pending')

    def test_kind_not_offered_to_groups_never_reaches_one(
        self, client: TestClient, token_headers: dict[str, str]
    ) -> None:
        _create(client, token_headers)
        _call(client, _notify, _call(client, _admin_ids, 1), kind='pytest.personal')
        assert _call(client, _bot_rows, 'pytest.personal') == []

    def test_rollback_and_master_switch(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _create(client, token_headers)
        uids = _call(client, _admin_ids, 1)
        _call(client, _notify, uids, rollback=True)
        assert _call(client, _bot_rows) == []
        monkeypatch.setattr(settings, 'NOTIFICATION_EXTERNAL_ENABLED', False)
        _call(client, _notify, uids)
        assert _call(client, _bot_rows) == []

    def test_broadcast_reaches_the_group_and_kicks_only_after_commit(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """公告是全员广播：站内一行，群里一条；提交在调用方手里，回滚了就既没有行、也不踢"""
        kicks: list[int] = []

        async def _kick() -> None:  # ruff: ignore[unused-async]
            kicks.append(1)

        monkeypatch.setattr(delivery_service, 'kick', _kick)
        _create(client, token_headers, kinds=['pytest.bot_broadcast'])

        async def _broadcast(*, commit: bool) -> None:
            async with async_test_db_session() as db:
                await notification_service.broadcast(
                    db=db, title=f'{TITLE} 公告', content='正文', link='/plugins/notice', kind='pytest.bot_broadcast'
                )
                if not commit:
                    # 回滚之后同一个会话再提交一次（依赖注入的会话会被接着用）：回滚掉的那一脚不能在这时补踢出去
                    await db.rollback()
                await db.commit()

        _call(client, _broadcast, commit=False)
        assert (_call(client, _bot_rows, 'pytest.bot_broadcast'), kicks) == ([], [])
        _call(client, _broadcast, commit=True)

        async def _settle() -> None:  # 提交后的踢是 create_task 出去的，让它跑一下
            import asyncio

            await asyncio.sleep(0.05)

        _call(client, _settle)
        assert len(_call(client, _bot_rows, 'pytest.bot_broadcast')) == 1
        assert kicks == [1]


# ── worker ───────────────────────────────────────────────────────────────────


def _enqueue(client: TestClient, headers: dict[str, str], **overrides: Any) -> tuple[int, int]:
    bot = _create(client, headers, **overrides)
    _call(client, _notify, _call(client, _admin_ids, 1))
    (row,) = _call(client, _bot_rows)
    return int(bot['id']), row.id


class TestWorker:
    def test_sent_marks_the_bot_too(
        self, client: TestClient, token_headers: dict[str, str], receiver: Receiver
    ) -> None:
        bot_id, _ = _enqueue(client, token_headers)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _bot_rows)
        assert (row.status, row.attempts) == ('sent', 1)
        assert len(receiver.requests) == 1
        body = receiver.body()
        assert body['content']['post']['zh_cn']['title'] == f'{TITLE} 标题'
        # 前端路由拼成了绝对地址：群里点得开
        link = body['content']['post']['zh_cn']['content'][-1][0]['href']
        assert link.startswith(settings.NOTIFICATION_WEB_BASE_URL.rstrip('/')) and link.endswith('/dashboard')
        assert _call(client, _get_bot, bot_id).last_sent_time is not None

    def test_sign_failure_is_permanent_and_shows_on_the_bot(
        self, client: TestClient, token_headers: dict[str, str], receiver: Receiver
    ) -> None:
        receiver.reply = lambda _req: httpx.Response(200, json={'code': 19021, 'msg': 'sign match fail'})
        bot_id, _ = _enqueue(client, token_headers, sign_secret='wrong')
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _bot_rows)
        assert (row.status, row.reason) == ('exhausted', 'sign_failed')
        assert 'sign match fail' in (_call(client, _get_bot, bot_id).last_error or '')

    def test_timeout_after_sending_is_unknown_not_retried(
        self, client: TestClient, token_headers: dict[str, str], receiver: Receiver
    ) -> None:
        """🔴 读超时 = 对方可能已经收下了：重试就是群里同一条出现两次"""

        def _hang(req: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout('timed out', request=req)

        receiver.reply = _hang
        _enqueue(client, token_headers)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _bot_rows)
        assert (row.status, row.reason, row.next_attempt_time) == ('unknown', 'network_after_send', None)

    def test_connect_error_is_retried(
        self, client: TestClient, token_headers: dict[str, str], receiver: Receiver
    ) -> None:
        def _refuse(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError('refused', request=req)

        receiver.reply = _refuse
        _enqueue(client, token_headers)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _bot_rows)
        assert (row.status, row.reason) == ('failed', 'network')
        assert row.next_attempt_time is not None

    def test_throttles_itself_before_the_platform_does(
        self, client: TestClient, token_headers: dict[str, str], receiver: Receiver
    ) -> None:
        """钉钉 / 企微每个机器人 20 条/分钟：这一分钟已经发了 20 条，第 21 条推到下一分钟、不算一次尝试、不发"""
        bot_id, pk = _enqueue(client, token_headers, platform='dingtalk', webhook_url=DINGTALK)

        async def _twenty_sent() -> None:
            async with async_test_db_session.begin() as db:
                for _ in range(20):
                    db.add(
                        NotificationDelivery(
                            notification_id=None,
                            user_id=None,
                            bot_id=bot_id,
                            kind='pytest.bot',
                            channel='bot',
                            address='x',
                            title=TITLE,
                            content='',
                            link=None,
                            status=DeliveryStatus.sent.value,
                            sent_time=timezone.now() - timedelta(seconds=10),
                        )
                    )

        _call(client, _twenty_sent)
        _call(client, delivery_service.deliver_pending)
        row = next(r for r in _call(client, _bot_rows) if r.id == pk)
        assert (row.status, row.reason, row.attempts) == ('failed', 'throttled', 0)
        assert row.next_attempt_time is not None and row.next_attempt_time > timezone.now() + timedelta(seconds=30)
        assert receiver.requests == []

    def test_deleted_bot_gives_up(self, client: TestClient, token_headers: dict[str, str], receiver: Receiver) -> None:
        bot_id, _ = _enqueue(client, token_headers)
        assert client.delete(f'{API}/{bot_id}', headers=token_headers).json()['code'] == 200
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _bot_rows)
        assert (row.status, row.reason) == ('exhausted', 'bot_missing')
        assert receiver.requests == []

    def test_deliveries_list_filters_by_bot_and_shows_its_name(
        self, client: TestClient, token_headers: dict[str, str]
    ) -> None:
        bot_id, pk = _enqueue(client, token_headers)
        page = client.get(
            '/sys/notification-channels/deliveries', params={'bot_id': bot_id}, headers=token_headers
        ).json()['data']
        assert [(i['id'], i['address'], i['user_id']) for i in page['items']] == [(str(pk), f'{TITLE} 飞书', None)]

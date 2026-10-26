"""个人中心绑定手机号（issue #168 第一步）：发码 → 验码 → 写入验证时间，和它周围的几条边界。

路由在 `app/admin`（`/sys/users/me/phone*`），测试放这里是因为它整条链都压在短信插件上：
验证码服务在 `plugin/sms/service/captcha_service.py`，发送要有一条启用的 `captcha` 配置（`make_config` 建控制台的）。

⚠️ 用 admin 自己绑：`token_headers` 是 admin 的。每条测试结束都解绑，别把 fba_test 里的 admin 留成带手机号的
（下一轮别的测试会以为种子变了）。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import redis_client
from backend.plugin.sms.service.captcha_service import captcha_key
from backend.plugin.sms.tests.conftest import LOGS, PHONE_A, PHONE_B, run_sync

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from starlette.testclient import TestClient

import pytest

ME = '/sys/users/me'
CAPTCHA = '/sys/users/me/phone/captcha'
PHONE = '/sys/users/me/phone'
TMP_USERNAME = 'pytest_phone_holder'


def _me(client: TestClient, headers: dict[str, str]) -> dict[str, Any]:
    return client.get(ME, headers=headers).json()['data']


def _peek_code(client: TestClient, user_id: str, phone: str) -> str | None:
    return client.portal.call(redis_client.get, captcha_key('bind', user_id, phone))


@pytest.fixture(autouse=True)
def _unbind_admin_afterwards(client: TestClient, token_headers: dict[str, str]) -> Iterator[None]:
    """每条前后：解绑 admin、清掉短信插件的防刷键（`captcha` 模板有 60 秒冷却，上一条发过的号这一条就发不了）"""

    async def _clear() -> None:
        keys = await redis_client.keys(f'{settings.SMS_REDIS_PREFIX}:*')
        if keys:
            await redis_client.delete(*keys)

    client.portal.call(_clear)
    yield
    client.delete(PHONE, headers=token_headers)
    client.portal.call(_clear)


class TestBindFlow:
    def test_send_verify_bind_then_unbind(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('bind', is_default=True)
        me = _me(client, token_headers)
        assert me['phone'] is None and me['phone_verified_time'] is None

        res = client.post(CAPTCHA, headers=token_headers, json={'phone': PHONE_A})
        assert res.json()['code'] == 200, res.text
        code = _peek_code(client, me['id'], PHONE_A)
        assert code is not None and len(code) == 6 and code.isdigit()

        # 填错：400 验证码错误，码还在（只错了一次）
        res = client.put(
            PHONE, headers=token_headers, json={'phone': PHONE_A, 'captcha': '000000' if code != '000000' else '111111'}
        )
        assert res.json()['code'] != 200
        assert _peek_code(client, me['id'], PHONE_A) == code

        # 填对：绑上，并记下本人验证时间
        res = client.put(PHONE, headers=token_headers, json={'phone': PHONE_A, 'captcha': code})
        assert res.json()['code'] == 200, res.text
        me = _me(client, token_headers)
        assert me['phone'] == PHONE_A and me['phone_verified_time'] is not None

        # 一次性：同一个码不能再用
        res = client.put(PHONE, headers=token_headers, json={'phone': PHONE_A, 'captcha': code})
        assert res.json()['code'] != 200
        assert '失效' in res.json()['msg'] or 'expired' in res.json()['msg'].lower(), res.json()['msg']

        # 发送日志里是 captcha 模板，验证码打了码（声明为敏感参数）
        logs = client.get(LOGS, headers=token_headers, params={'phone': PHONE_A, 'template': 'captcha'}).json()['data']
        assert logs['total'] >= 1 and code not in (logs['items'][0]['params'] or '')

        # 解绑：号码和验证时间一起清
        assert client.delete(PHONE, headers=token_headers).json()['code'] == 200
        me = _me(client, token_headers)
        assert me['phone'] is None and me['phone_verified_time'] is None

    def test_wrong_attempts_exhaust_the_code(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        """🔴 6 位纯数字只有一百万种，不限次数就是可以枚举的：错满 N 次整个作废，之后填对也不认"""
        make_config('bind2', is_default=True)
        me = _me(client, token_headers)
        assert client.post(CAPTCHA, headers=token_headers, json={'phone': PHONE_A}).json()['code'] == 200
        code = _peek_code(client, me['id'], PHONE_A)
        assert code
        wrong = '000000' if code != '000000' else '111111'
        for _ in range(settings.SMS_CAPTCHA_MAX_ATTEMPTS):
            assert (
                client.put(PHONE, headers=token_headers, json={'phone': PHONE_A, 'captcha': wrong}).json()['code']
                != 200
            )
        assert _peek_code(client, me['id'], PHONE_A) is None, '错满次数后码要作废'
        res = client.put(PHONE, headers=token_headers, json={'phone': PHONE_A, 'captcha': code})
        assert res.json()['code'] != 200
        assert _me(client, token_headers)['phone'] is None

    def test_send_failure_is_visible_and_leaves_no_code(
        self, client: TestClient, token_headers: dict[str, str]
    ) -> None:
        """硬纪律 9 / 邮件插件 #64：没有可用配置时接口必须报错，而且不能留下一个用户永远收不到的码"""
        me = _me(client, token_headers)
        res = client.post(CAPTCHA, headers=token_headers, json={'phone': PHONE_A})
        assert res.json()['code'] != 200, res.text
        assert _peek_code(client, me['id'], PHONE_A) is None

    def test_bad_phone_is_422(self, client: TestClient, token_headers: dict[str, str]) -> None:
        assert client.post(CAPTCHA, headers=token_headers, json={'phone': '12345'}).status_code == 422
        assert client.put(PHONE, headers=token_headers, json={'phone': '12345', 'captcha': '1'}).status_code == 422


class TestPhoneTakenByAnotherUser:
    @pytest.fixture
    def holder(self, client: TestClient, token_headers: dict[str, str]) -> Iterator[str]:
        """另一个账号，管理员录入了 PHONE_B（没验证过）。

        收尾硬删：`DELETE /sys/users/{pk}` 是逻辑删除，行留着下一轮同名建号会撞唯一约束。
        """
        dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
        role_id = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]['id']
        res = client.post(
            '/sys/users',
            headers=token_headers,
            json={
                'username': TMP_USERNAME,
                'password': 'Tmp@123456',
                'nickname': '占着号的人',
                'phone': PHONE_B,
                'dept_id': dept_id,
                'roles': [role_id],
            },
        )
        assert res.json()['code'] == 200, res.text
        pk = res.json()['data']['id']
        yield pk

        async def _purge() -> None:
            engine = create_database_async_engine(get_database_url(unittest=True))
            try:
                async with create_database_async_session(engine).begin() as db:
                    await db.execute(text('DELETE FROM sys_user_role WHERE user_id = :pk'), {'pk': int(pk)})
                    await db.execute(text('DELETE FROM sys_user WHERE id = :pk'), {'pk': int(pk)})
            finally:
                await engine.dispose()

        run_sync(_purge())

    def test_captcha_is_refused_for_a_phone_bound_elsewhere(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]], holder: str
    ) -> None:
        """已经是别人的号就不发：发了也绑不上，白扣一条钱"""
        make_config('taken', is_default=True)
        res = client.post(CAPTCHA, headers=token_headers, json={'phone': PHONE_B})
        assert res.status_code == 409, res.text
        assert '绑定' in res.json()['msg'] or 'bound' in res.json()['msg'].lower()
        # 管理员录入的号没有验证时间
        other = client.get(f'/sys/users/{holder}', headers=token_headers).json()['data']
        assert other['phone'] == PHONE_B and other['phone_verified_time'] is None

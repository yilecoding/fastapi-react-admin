"""issue #227：按邮箱把社交账号关联到已有用户，只认第三方明确验证过的邮箱

原来 `oauth2_service.login` 拿到 email 就 `check_email` 关联 —— 谁能让 GitHub / Google 返回管理员的邮箱，
谁就以管理员身份登录（开了 MFA 的账号仍会过第二步）。GitHub 的客户端库在取不到 primary 时还会回落到
`emails[0]`，不保证验证过。

两层各测一遍：判定函数（打桩 httpx）+ service 是否按判定结果关联。
"""

import asyncio
import uuid

from typing import Any

import httpx
import pytest

from sqlalchemy import select

from backend.app.admin.model import User
from backend.common.exception import errors
from backend.core.conf import settings
from backend.plugin.oauth2 import utils
from backend.plugin.oauth2.enums import UserSocialType
from backend.plugin.oauth2.model import UserSocial
from backend.plugin.oauth2.service import oauth2_service as oauth2_service_module
from backend.plugin.oauth2.service.oauth2_service import oauth2_service
from backend.plugin.oauth2.tests.test_auto_register import _in_rolled_back_session

# ─── 判定函数 ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ('user', 'expected'),
    [
        ({'email': 'a@x.com', 'verified_email': True}, True),
        ({'email': 'a@x.com', 'email_verified': True}, True),
        ({'email': 'a@x.com', 'verified_email': False}, False),
        ({'email': 'a@x.com'}, False),  # 不说 = 没验证
        ({'email': 'a@x.com', 'verified_email': 'true'}, False),  # 只认布尔 True
    ],
)
def test_google_email_verified(user: dict[str, Any], *, expected: bool) -> None:
    assert utils.google_email_verified(user) is expected


def _fake_github(monkeypatch: pytest.MonkeyPatch, payload: Any, status: int = 200) -> None:
    async def fake_get(self: httpx.AsyncClient, url: str, **_: Any) -> httpx.Response:  # ruff:ignore[unused-async]
        assert url == utils.GITHUB_EMAILS_ENDPOINT
        return httpx.Response(status, json=payload, request=httpx.Request('GET', url))

    monkeypatch.setattr(httpx.AsyncClient, 'get', fake_get)


@pytest.mark.parametrize(
    ('payload', 'email', 'expected'),
    [
        ([{'email': 'Admin@Example.com', 'verified': True, 'primary': True}], 'admin@example.com', True),
        ([{'email': 'admin@example.com', 'verified': False, 'primary': True}], 'admin@example.com', False),
        # 验证过的是另一个地址：不能拿「这个人有验证过的邮箱」顶替「这个邮箱验证过」
        (
            [{'email': 'other@x.com', 'verified': True}, {'email': 'admin@example.com', 'verified': False}],
            'admin@example.com',
            False,
        ),
        ([], 'admin@example.com', False),
        ({'message': 'Requires authentication'}, 'admin@example.com', False),
    ],
)
def test_github_email_verified(monkeypatch: pytest.MonkeyPatch, payload: Any, email: str, *, expected: bool) -> None:
    _fake_github(monkeypatch, payload)
    assert asyncio.run(utils.github_email_verified('token', email)) is expected


def test_github_lookup_failure_counts_as_unverified(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_github(monkeypatch, {'message': 'Bad credentials'}, status=401)
    assert asyncio.run(utils.github_email_verified('token', 'admin@example.com')) is False


# ─── service：关不关联 ───────────────────────────────────────────────────────


async def _login(db: Any, sid: str, email: str, *, verified: bool) -> Any:
    return await oauth2_service.login(
        db=db,
        request=None,  # type: ignore[arg-type]
        response=None,  # type: ignore[arg-type]
        background_tasks=None,  # type: ignore[arg-type]
        sid=sid,
        source=UserSocialType.github,
        username=f'gh_{sid[:8]}',
        nickname='x',
        email=email,
        email_verified=verified,
    )


def test_unverified_email_does_not_take_over_an_existing_account(monkeypatch: pytest.MonkeyPatch) -> None:
    """邮箱和管理员一样、但没验证过：不关联；自动注册关着，所以是 403，且没有绑定行"""
    monkeypatch.setattr(settings, 'OAUTH2_AUTO_REGISTER', False)
    sid = uuid.uuid4().hex

    async def body(db: Any) -> None:
        email = await db.scalar(select(User.email).where(User.username == 'admin'))
        assert email, '先断言「有」：种子里的 admin 要有邮箱，否则这条证明不了什么'
        with pytest.raises(errors.AuthorizationError):
            await _login(db, sid, email, verified=False)
        await db.flush()  # 同上：不 flush 的话「没有绑定行」永远成立，这条就证明不了什么
        assert await db.scalar(select(UserSocial.id).where(UserSocial.sid == sid)) is None

    _in_rolled_back_session(body)


class _LinkedError(Exception):
    """关联之后的第一步（查锁定状态）抛它：只关心「关联到了谁」，不跑后面要真请求 / Redis 的开会话"""


def test_verified_email_still_links_to_the_existing_account(monkeypatch: pytest.MonkeyPatch) -> None:
    """对照组：验证过的邮箱照常关联，绑定行指向邮箱的主人"""
    monkeypatch.setattr(settings, 'OAUTH2_AUTO_REGISTER', False)
    sid = uuid.uuid4().hex

    async def stop_here(user_id: int, _status: int) -> None:  # ruff:ignore[unused-async]
        raise _LinkedError(user_id)

    monkeypatch.setattr(oauth2_service_module.password_security_service, 'peek_lock_reason', stop_here)

    async def body(db: Any) -> None:
        owner_id, email = (await db.execute(select(User.id, User.email).where(User.username == 'admin'))).one()
        with pytest.raises(_LinkedError) as linked_to:
            await _login(db, sid, email, verified=True)
        assert linked_to.value.args[0] == owner_id
        await db.flush()  # 会话工厂关了 autoflush，create_model 只是 add
        assert await db.scalar(select(UserSocial.user_id).where(UserSocial.sid == sid)) == owner_id

    _in_rolled_back_session(body)

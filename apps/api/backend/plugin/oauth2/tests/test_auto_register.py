"""issue #226：第三方账号第一次登录的自动建号

原来的行为：陌生的 GitHub / Google 账号一律自动建成 `is_staff=True` 的系统用户，并挂上
`select(Role)...first()` 拿到的「第一个启用角色」（没有 ORDER BY）。任何人走一遍第三方登录就进来了。

现在：
- `OAUTH2_AUTO_REGISTER` 默认关，陌生账号直接 403，**不建号**
- 开着时必须配 `OAUTH2_AUTO_REGISTER_ROLE`，新用户挂的就是那个编码的角色，找不到就拒绝
- 绑定还在、用户被逻辑删除时是 403，不是 `sys_user.avatar` 上的 AttributeError → 500

直接调 service：回调要打桩第三方授权依赖（apps/api 分册「OAuth2 回调本身没有路由级的回归测试」），
而这几条要钉的都发生在开会话之前。每条测试自己开引擎、全程回滚，不在共享库里留东西。
"""

import asyncio
import uuid

from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from sqlalchemy import func, select

from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import Role, User
from backend.app.admin.schema.user import AddOAuth2UserParam
from backend.common.exception import errors
from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.oauth2.enums import UserSocialType
from backend.plugin.oauth2.model import UserSocial
from backend.plugin.oauth2.service.oauth2_service import oauth2_service


def _in_rolled_back_session(body: Callable[[Any], Awaitable[Any]]) -> Any:
    """在测试库上开一个会话跑 `body`，结束时整体回滚

    每次新建引擎：模块级的会话工厂绑在别的事件循环上（同 test_user_cache_invalidation 的 `_redis_exists`）
    """

    async def _run() -> Any:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                try:
                    return await body(db)
                finally:
                    await db.rollback()
        finally:
            await engine.dispose()

    return asyncio.run(_run())


async def _login_as_stranger(db: Any, sid: str) -> Any:
    # 自动注册的拒绝发生在开会话之前，request / response / background_tasks 都走不到
    return await oauth2_service.login(
        db=db,
        request=None,  # type: ignore[arg-type]
        response=None,  # type: ignore[arg-type]
        background_tasks=None,  # type: ignore[arg-type]
        sid=sid,
        source=UserSocialType.github,
        username=f'gh_{sid[:8]}',
        nickname='stranger',
        email=None,
    )


def test_stranger_is_rejected_and_no_user_is_created_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, 'OAUTH2_AUTO_REGISTER', False)
    sid = uuid.uuid4().hex

    async def body(db: Any) -> int:
        # 🔴 角色要配成一个**真实存在**的：留空的话「角色未配置」那道检查也抛同一种异常，
        # 去掉自动注册开关这条照样绿（第一版就是这样，变异检验抓出来的）
        role_code = await db.scalar(select(Role.code).where(Role.status == 1, Role.deleted == 0).limit(1))
        assert role_code, '先断言「有」：测试库里要有启用的角色'
        monkeypatch.setattr(settings, 'OAUTH2_AUTO_REGISTER_ROLE', role_code)
        before = await db.scalar(select(func.count()).select_from(User))
        with pytest.raises(errors.AuthorizationError):
            await _login_as_stranger(db, sid)
        after = await db.scalar(select(func.count()).select_from(User))
        socials = await db.scalar(select(func.count()).select_from(UserSocial).where(UserSocial.sid == sid))
        assert socials == 0
        return after - before

    assert _in_rolled_back_session(body) == 0, '自动注册关着时不该建出用户'


def test_auto_register_without_a_role_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, 'OAUTH2_AUTO_REGISTER', True)
    monkeypatch.setattr(settings, 'OAUTH2_AUTO_REGISTER_ROLE', '')
    sid = uuid.uuid4().hex

    async def body(db: Any) -> None:
        before = await db.scalar(select(func.count()).select_from(User))
        with pytest.raises(errors.AuthorizationError):
            await _login_as_stranger(db, sid)
        assert await db.scalar(select(func.count()).select_from(User)) == before

    _in_rolled_back_session(body)


def test_auto_registered_user_gets_exactly_the_configured_role() -> None:
    """角色按编码取，不是「第一个」：挑一个**不是**按主键排第一的启用角色，证明不是碰巧对上"""

    async def body(db: Any) -> None:
        roles = (
            (await db.execute(select(Role).where(Role.status == 1, Role.deleted == 0).order_by(Role.id)))
            .scalars()
            .all()
        )
        assert len(roles) >= 2, '先断言「有」：测试库里至少要有两个启用角色，否则证明不了「不是第一个」'
        target = roles[-1]

        user = await user_dao.add_by_oauth2(
            db,
            AddOAuth2UserParam(username=f'gh_{uuid.uuid4().hex[:8]}', password=None, nickname='x', email=None),
            role_code=target.code,
        )
        await db.flush()
        joined = await user_dao.get_join(db, user_id=user.id)
        assert [r.code for r in joined.roles] == [target.code]

    _in_rolled_back_session(body)


def test_unknown_role_code_is_rejected_without_creating_a_user() -> None:
    async def body(db: Any) -> None:
        before = await db.scalar(select(func.count()).select_from(User))
        with pytest.raises(errors.AuthorizationError):
            await user_dao.add_by_oauth2(
                db,
                AddOAuth2UserParam(username=f'gh_{uuid.uuid4().hex[:8]}', password=None, nickname='x', email=None),
                role_code='NO_SUCH_ROLE',
            )
        assert await db.scalar(select(func.count()).select_from(User)) == before

    _in_rolled_back_session(body)


def test_binding_to_a_deleted_user_is_403_not_500() -> None:
    sid = uuid.uuid4().hex

    async def body(db: Any) -> None:
        # 指向一个不存在的用户 ID，等价于「绑定还在、用户被逻辑删除了」（user_dao.get 过滤 deleted=0）
        db.add(UserSocial(sid=sid, source=UserSocialType.github.value, user_id=1))
        await db.flush()
        with pytest.raises(errors.AuthorizationError):
            await _login_as_stranger(db, sid)

    _in_rolled_back_session(body)

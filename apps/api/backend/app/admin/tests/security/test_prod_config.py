"""prod 启动前置校验。

生产环境原来**零配置校验**：`check_env()` 在 `ENVIRONMENT='prod'` 时只关了
OpenAPI 文档和静态挂载（外加打开 metrics），完全不看 `TOKEN_SECRET_KEY`
是不是还是 `.env.example` 里那个占位符。更糟的是 `get_settings()` 在缺 `.env`
时会自动把 `.env.example` 拷过去 —— 没人拦着你用开发默认值把生产跑起来，
而 JWT 会用一个公开在仓库里的常量签名。

这批用例里最重要的是 `test_weak_replacement_is_also_rejected`：
**光查占位符黑名单挡不住伪修复。** 把 `CHANGE_ME__...` 改成 `123` 也算「改过了」，
而那比占位符更糟 —— 占位符至少还能被识别。
"""

import pytest

from backend.core.conf import (
    ProductionConfigError,
    Settings,
    _check_secret,
    _entropy_bits,
    check_production_settings,
    settings,
)


class _FakeSettings:
    """够 `check_production_settings` 用的最小配置对象

    不构造真的 `Settings()` —— 那会去读 `.env` 并触发插件配置源，
    这里要的是「把某几项设成不合格」这一件事。
    """

    def __init__(self, **overrides: object) -> None:
        self.ENVIRONMENT = 'prod'
        self.TOKEN_SECRET_KEY = 'S7xK2mQ9vR4tW8yZ1aB6cD3eF5gH0jLnP'
        self.DATABASE_HOST = 'sqlserver.internal'
        self.DATABASE_PASSWORD = 'Xk92mQvR4tW8yZ1a'
        self.REDIS_PASSWORD = 'Pq73nZvT6yU2wX9b'
        self.CELERY_BROKER = 'redis'
        self.CELERY_RABBITMQ_PASSWORD = 'Rm84pYwS5xV3zA7c'
        self.DEMO_MODE = False
        self.LOGIN_CAPTCHA_ENABLED = True
        self.REQUEST_LIMITER_ENABLED = True
        self.USER_PASSWORD_MIN_LENGTH = 8
        self.CORS_ALLOWED_ORIGINS = ['https://admin.example.com']
        self.DATABASE_USER = 'fba_app'
        for k, v in overrides.items():
            setattr(self, k, v)


def _expect_rejected(**overrides: object) -> str:
    with pytest.raises(ProductionConfigError) as e:
        check_production_settings(_FakeSettings(**overrides))
    return str(e.value)


def test_a_well_configured_prod_passes() -> None:
    """基线：合格配置不能被误杀，否则下面的断言都没意义"""
    check_production_settings(_FakeSettings())


def test_dev_is_never_checked() -> None:
    """开发环境整段跳过 —— 本地开发和 CI 都不该被这套校验打扰"""
    check_production_settings(_FakeSettings(ENVIRONMENT='dev', TOKEN_SECRET_KEY='123'))


def test_placeholder_secret_is_rejected() -> None:
    msg = _expect_rejected(TOKEN_SECRET_KEY='CHANGE_ME__secrets.token_urlsafe(32)')
    assert 'TOKEN_SECRET_KEY' in msg


def test_weak_replacement_is_also_rejected() -> None:
    """🔴 伪修复：把 CHANGE_ME 改成 123

    这是这套校验存在的真正理由。只查黑名单的话，「改过了」就算通过 ——
    而 `123` 比占位符更危险，因为它看起来像是有人认真配过。
    """
    for weak in ('123', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'abcabcabcabcabcabcabcabcabcabcabcabc'):
        msg = _expect_rejected(TOKEN_SECRET_KEY=weak)
        assert 'TOKEN_SECRET_KEY' in msg, f'{weak!r} 居然通过了'


def test_partially_edited_placeholder_is_rejected() -> None:
    """只删了后缀也算没改 —— 子串标记兜住这种"""
    assert _check_secret('X', 'CHANGE_ME__prod_2026', min_len=8, min_bits=32, min_distinct=6)


def test_example_database_password_is_rejected() -> None:
    assert 'DATABASE_PASSWORD' in _expect_rejected(DATABASE_PASSWORD='YourStrong!Passw0rd')


def test_empty_redis_password_is_rejected() -> None:
    """Redis 里放着全部 token，默认空密码"""
    assert 'REDIS_PASSWORD' in _expect_rejected(REDIS_PASSWORD='')


def test_rabbitmq_password_only_checked_when_used() -> None:
    """没用 rabbitmq 就不该因为它的口令被卡住 —— 否则这套校验会招人绕过"""
    check_production_settings(_FakeSettings(CELERY_BROKER='redis', CELERY_RABBITMQ_PASSWORD='guest'))
    assert 'CELERY_RABBITMQ_PASSWORD' in _expect_rejected(CELERY_BROKER='rabbitmq', CELERY_RABBITMQ_PASSWORD='guest')


def test_security_switches_must_stay_on() -> None:
    assert 'LOGIN_CAPTCHA_ENABLED' in _expect_rejected(LOGIN_CAPTCHA_ENABLED=False)
    assert 'REQUEST_LIMITER_ENABLED' in _expect_rejected(REQUEST_LIMITER_ENABLED=False)
    assert 'DEMO_MODE' in _expect_rejected(DEMO_MODE=True)


def test_local_cors_origin_is_rejected() -> None:
    assert 'CORS_ALLOWED_ORIGINS' in _expect_rejected(
        CORS_ALLOWED_ORIGINS=['https://admin.example.com', 'http://localhost:8888']
    )


def test_superuser_database_account_is_rejected() -> None:
    assert 'DATABASE_USER' in _expect_rejected(DATABASE_USER='sa')


def test_placeholder_database_target_is_rejected() -> None:
    msg = _expect_rejected(DATABASE_HOST='CHANGE_ME__sqlserver.example.internal')
    assert 'DATABASE_HOST' in msg
    msg = _expect_rejected(DATABASE_USER='CHANGE_ME__fba_app')
    assert 'DATABASE_USER' in msg


def test_all_problems_are_reported_at_once() -> None:
    """🔴 一次列全，不是逐条 raise

    逐条报的结局通常是：运维改一条、重启、再撞下一条，改到第四条就去把
    ENVIRONMENT 设成 dev 了。
    """
    msg = _expect_rejected(
        TOKEN_SECRET_KEY='123',
        DATABASE_PASSWORD='123456',
        REDIS_PASSWORD='',
        DEMO_MODE=True,
    )
    for key in ('TOKEN_SECRET_KEY', 'DATABASE_PASSWORD', 'REDIS_PASSWORD', 'DEMO_MODE'):
        assert key in msg, f'{key} 没被一起报出来'
    assert '4 项配置不合格' in msg


def test_entropy_helper_behaves() -> None:
    """熵这道闸是整套校验的兜底，单独钉住它的量级"""
    assert _entropy_bits('') < 1e-9
    assert _entropy_bits('aaaaaaaa') < 1e-9
    assert _entropy_bits('123') < 10
    assert _entropy_bits('S7xK2mQ9vR4tW8yZ1aB6cD3eF5gH0jLnP') > 128


def test_current_settings_object_is_a_real_settings() -> None:
    """守一下上面的 _FakeSettings 没有和真配置漂移

    校验函数读的每个属性，真 Settings 上都必须有 —— 少一个的话
    生产环境会在启动时 AttributeError，而不是给出配置清单。
    """
    fake = _FakeSettings()
    assert isinstance(settings, Settings)
    for attr in vars(fake):
        assert hasattr(settings, attr), f'Settings 上没有 {attr}，校验函数会 AttributeError'


def test_seeded_password_hashes_cover_every_seeded_account() -> None:
    """🔴 `SEEDED_PASSWORD_HASHES` ∪ `SEEDED_DEMO_PASSWORD_HASHES` 必须覆盖
    种子 SQL 里**每一个**带密码的账号。

    两份集合语义相反，别搞混：`SEEDED_PASSWORD_HASHES`（admin/test）是
    prod 启动时 `_verify_production_database()` 拿去扫全库、命中就拒绝启动的
    名单；`SEEDED_DEMO_PASSWORD_HASHES`（8 个公开演示账号）密码设计上永远是
    123456，**不参与**那条查询——查了就是拿自己的检查把公开演示锁死
    （实测踩过：8 个演示账号进库后重启 api 直接崩溃重启 12 次）。

    这条测试只管"扫到的 hash 有没有地方登记"，不管落在哪一份集合里：
    漏一个账号，它就能带着谁都不知道的默认密码活在种子里而没有任何测试盯着。

    反过来漏在另一侧也踩过：`fba init` 原来只重置 admin，`test` 还留着种子密码——
    于是 init 成功、prod 却起不来（被自己的检查挡住，这条与
    `SEEDED_DEMO_PASSWORD_HASHES` 无关，`fba init` 本来就不处理演示账号）。
    """
    import re

    from backend.app.admin.utils.password_security import (
        SEEDED_DEMO_PASSWORD_HASHES,
        SEEDED_PASSWORD_HASHES,
    )
    from backend.core.path_conf import BASE_PATH

    hashes_in_seed: set[str] = set()
    for path in (BASE_PATH / 'sql').rglob('init_*.sql'):
        body = path.read_text(encoding='utf-8', errors='ignore')
        hashes_in_seed.update(re.findall(r"'(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53})'", body))

    assert hashes_in_seed, '种子 SQL 里一个 bcrypt hash 都没扫到，正则大概率坏了'
    known_hashes = SEEDED_PASSWORD_HASHES | SEEDED_DEMO_PASSWORD_HASHES
    missing = sorted(hashes_in_seed - known_hashes)
    assert not missing, (
        f'种子 SQL 里有 {len(missing)} 个密码 hash 没有登记：{missing}\n'
        '这些账号用的是种子默认密码却没人知道。\n'
        '修法：admin/test 这类"必须在 prod 前改掉"的账号补进 SEEDED_PASSWORD_HASHES，'
        '并确认 backend/cli.py 的 _set_admin_password 会处理对应账号；'
        '"永远保持默认密码"的公开演示账号补进 SEEDED_DEMO_PASSWORD_HASHES。'
    )


def test_init_handles_every_seeded_account() -> None:
    """`fba init` 收尾必须处理掉所有带种子密码的账号，否则建出来的库自己起不来

    实测过：原来只 `reset_password(admin)`，`test` 留着 123456 —— init 报「成功」，
    prod 启动时被 `_verify_production_database()` 挡住。两层配合才完整，
    这条把它们钉在一起。
    """
    import inspect

    from backend import cli

    src = inspect.getsource(cli._set_admin_password)
    for username in ('admin', 'test'):
        assert f"'{username}'" in src, f'_set_admin_password 没有处理种子账号 {username}'


# ── prod 启动时的数据库检查 ─────────────────────────────────────────────────
#
# 上面那批查的是**配置**（`check_production_settings`），下面这两条查的是
# **数据库**（`_verify_production_database`）—— 两个函数，两批问题，
# 都在 prod 启动路径上，缺一个的后果都是「带着问题正常启动」。


def _run_verify() -> str | None:
    """拿测试库跑一遍 prod 数据库检查，返回它报的问题（没问题返回 None）。

    🔴 **必须换掉 `registrar` 里那个 `async_db_session`**：它连的是
    `DATABASE_SCHEMA`（开发库 fba），而这条检查会**扫全库的用户密码** ——
    不换就是拿开发库的数据判定，结论和测试数据无关。
    （和 `app/task/tests/test_prune_logs.py` 的 `run_prune` 同一个套路，
    那边的注释是完整版。）

    🔴 **每次起一个独立引擎、跑完 dispose**：不能复用模块级的
    `async_test_engine`，它的连接池已经绑在 TestClient 的事件循环上了，
    这里 `asyncio.run` 是另一个循环 → `Future attached to a different loop`。
    """
    import asyncio

    import backend.core.registrar as reg

    from backend.core.registrar import _verify_production_database
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    engine = create_database_async_engine(get_database_url(unittest=True))
    original = reg.async_db_session
    reg.async_db_session = create_database_async_session(engine)

    async def go() -> str | None:
        try:
            await _verify_production_database()
        except RuntimeError as e:
            return str(e)
        else:
            return None
        finally:
            await engine.dispose()

    try:
        return asyncio.run(go())
    finally:
        reg.async_db_session = original


def test_seeded_password_refuses_prod_startup() -> None:
    """🔴 库里还有账号在用种子密码（123456）时，prod 必须**拒绝启动**。

    ⚠️ **这条检查此前零覆盖。** 实测把 `_verify_production_database` 末尾那句
    `if problems:` 改成 `if False`（永不拦），全套 266 条**一条都不红**。
    而它整个存在的理由就是「启动即失败」—— 硬纪律 9 说的「失败必须是可见状态」。

    绕过 `fba init` 强制改密的路是现成的：直接拿 `backend/sql/**` 灌库、
    或者从测试环境 dump 一份过来，都不经过 init。所以这条按**密码 hash 字面量**
    比对（种子用固定盐，三个方言里同一个常量），无论库是怎么来的都拦得住。

    测试库正好就是那个状态（种子灌进去的 admin / test 都还是 123456），
    所以这条不需要造数据 —— 它测的就是「这种库不许上生产」。
    """
    problem = _run_verify()
    assert problem is not None, '库里 admin/test 还是种子密码，prod 检查却放行了'
    assert '种子数据里的默认密码' in problem, problem
    assert 'admin' in problem, f'没点出是哪些账号：{problem}'


def test_clean_database_passes_prod_startup() -> None:
    """把种子密码改掉之后，同一个库必须**能过**。

    🔴 这是上一条的另一半。只验「坏的会拦」不验「好的能过」的话，
    一个永远抛异常的实现也是绿的 —— 那种实现会让**任何**生产环境都起不来，
    而且报的是一条看起来很正当的错误信息。

    顺带这条还证明了另一个分支是好的：迁移版本检查在一个正常 stamp 过的库上
    不误报（测试库是 `fba init` 建的，stamp 在 head）。

    ⚠️ 收尾必须把 hash 改回去，否则后面所有用 admin 登录的测试全部 403 ——
    而且是**跨轮**的（改的是真库）。所以放在 `try/finally` 里，不是测试体末尾。
    """
    import asyncio

    from sqlalchemy import text

    from backend.app.admin.utils.password_security import SEEDED_PASSWORD_HASHES
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def _run(work) -> object:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker.begin() as session:
                return await work(session)
        finally:
            await engine.dispose()

    # 换成一个绝不在种子集合里的值
    placeholder = '$2b$12$pytestpytestpytestpytestpytestpytestpytestpytestpytes'
    assert placeholder not in SEEDED_PASSWORD_HASHES

    # 🔴 **逐个用户记下原值再改**，不能拿 `SEEDED_PASSWORD_HASHES` 集合回写：
    # 那是个集合，admin 和 test 的 hash 万一不同（换了盐、或只改了一个），
    # 循环回写会把两个人设成同一个值 —— 而测试照旧绿，因为登录只验 hash 对不对，
    # 不验「是不是原来那一个」。第一版就是这么写的。
    async def snapshot(session) -> list[tuple[str, str]]:
        rows = await session.execute(
            text('SELECT username, password FROM sys_user WHERE username IN (:a, :b)'),
            {'a': 'admin', 'b': 'test'},
        )
        return [(r[0], r[1]) for r in rows]

    saved: list[tuple[str, str]] = asyncio.run(_run(snapshot))
    assert saved, '测试库里没有 admin / test —— 这条测试的前提不成立'

    async def dirty(session) -> None:
        await session.execute(
            text('UPDATE sys_user SET password = :p WHERE username IN (:a, :b)'),
            {'p': placeholder, 'a': 'admin', 'b': 'test'},
        )

    async def restore(session) -> None:
        for username, original in saved:
            await session.execute(
                text('UPDATE sys_user SET password = :h WHERE username = :u'),
                {'h': original, 'u': username},
            )

    try:
        asyncio.run(_run(dirty))
        assert _run_verify() is None, '库已经干净了，prod 检查却还在拦'
    finally:
        asyncio.run(_run(restore))

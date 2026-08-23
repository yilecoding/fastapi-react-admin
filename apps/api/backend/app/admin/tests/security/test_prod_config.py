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
    assert 'CELERY_RABBITMQ_PASSWORD' in _expect_rejected(
        CELERY_BROKER='rabbitmq', CELERY_RABBITMQ_PASSWORD='guest'
    )


def test_security_switches_must_stay_on() -> None:
    assert 'LOGIN_CAPTCHA_ENABLED' in _expect_rejected(LOGIN_CAPTCHA_ENABLED=False)
    assert 'REQUEST_LIMITER_ENABLED' in _expect_rejected(REQUEST_LIMITER_ENABLED=False)
    assert 'DEMO_MODE' in _expect_rejected(DEMO_MODE=True)


def test_local_cors_origin_is_rejected() -> None:
    assert 'CORS_ALLOWED_ORIGINS' in _expect_rejected(
        CORS_ALLOWED_ORIGINS=['https://admin.example.com', 'http://localhost:1125']
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
    """🔴 `SEEDED_PASSWORD_HASHES` 必须覆盖种子 SQL 里**每一个**带密码的账号。

    prod 启动时 `_verify_production_database()` 拿这份清单扫全库。漏一个账号，
    那个账号就能带着默认密码 123456 活到生产上，而启动检查一声不吭地放行。

    反过来漏在另一侧也踩过：`fba init` 原来只重置 admin，`test` 还留着种子密码 ——
    于是 init 成功、prod 却起不来（被自己的检查挡住）。两边都要对得上，
    所以这里同时断言「清单覆盖种子」和「init 会处理掉它们」。
    """
    import re

    from backend.app.admin.utils.password_security import SEEDED_PASSWORD_HASHES
    from backend.core.path_conf import BASE_PATH

    hashes_in_seed: set[str] = set()
    for path in (BASE_PATH / 'sql').rglob('init_*.sql'):
        body = path.read_text(encoding='utf-8', errors='ignore')
        hashes_in_seed.update(re.findall(r"'(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53})'", body))

    assert hashes_in_seed, '种子 SQL 里一个 bcrypt hash 都没扫到，正则大概率坏了'
    missing = sorted(hashes_in_seed - SEEDED_PASSWORD_HASHES)
    assert not missing, (
        f'种子 SQL 里有 {len(missing)} 个密码 hash 不在 SEEDED_PASSWORD_HASHES 里：{missing}\n'
        '这些账号能带着默认密码活到生产，而 prod 启动检查扫不到它们。\n'
        '修法：把 hash 补进 backend/app/admin/utils/password_security.py，'
        '并确认 backend/cli.py 的 _set_admin_password 会处理对应账号。'
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

from collections.abc import Generator

import pytest

from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.db import get_db, get_db_transaction
from backend.main import app
from backend.tests.utils.db import async_test_db_session, override_get_db, override_get_db_transaction

# 重载数据库
app.dependency_overrides[get_db] = override_get_db
app.dependency_overrides[get_db_transaction] = override_get_db_transaction

# 🔴 **依赖注入只覆盖得到接口层，覆盖不到直接 import 了 `async_db_session` 的模块。**
#
# 上面两行只换掉 `Depends(get_db)` 那条路。请求路径上还有三处是在模块顶层
# `from backend.database.db import async_db_session` 拿到会话的，它们连的始终是
# **开发库**（`DATABASE_SCHEMA`，即 fba）：
#
#   - `common/security/jwt.py`            —— JWT 用户解析
#   - `app/admin/service/login_log_service.py` —— 登录日志落库
#   - `middleware/opera_log_middleware.py`     —— 操作日志落库
#
# 两个后果，都是静默的：
#   1. **跑一次 pytest 会往你的开发库里写登录日志和操作日志。** 本机看不出来，
#      因为那些表本来就一直在长。
#   2. 全新环境（CI）里开发库是空的 / 不存在，于是任何带 token 的请求都在
#      `get_jwt_user()` 里 `TokenError`。本机从来没暴露过，是因为两个库里
#      **恰好都有同 ID 的 admin**（种子 SQL 的雪花 ID 是写死的常量）。
#
# 所以在这里一次性把三处都指到测试库。`test_data_permission.py` 里那个 module 级
# 的同名 patch 因此变成冗余（保留无害，它 patch 的是已经换过的值再还原回去）。
_PATCHED_SESSION_MODULES = (
    'backend.common.security.jwt',
    'backend.app.admin.service.login_log_service',
    'backend.middleware.opera_log_middleware',
)


@pytest.fixture(scope='session', autouse=True)
def _use_test_db_everywhere() -> Generator[None, None, None]:
    """把「不走依赖注入」的那几处会话也换到测试库"""
    import importlib

    originals: dict[str, object] = {}
    for name in _PATCHED_SESSION_MODULES:
        mod = importlib.import_module(name)
        originals[name] = mod.async_db_session
        mod.async_db_session = async_test_db_session
    try:
        yield
    finally:
        for name, original in originals.items():
            importlib.import_module(name).async_db_session = original


# Test data
PYTEST_USERNAME = 'admin'
PYTEST_PASSWORD = '123456'
PYTEST_BASE_URL = f'http://testserver{settings.FASTAPI_API_V1_PATH}'


@pytest.fixture(scope='session', autouse=True)
def _disable_rate_limiter() -> Generator[None, None, None]:
    """测试期默认关掉限流

    同一个 TestClient 的 IP 恒为 127.0.0.1，而限流 key 是 `{IP}:{path}`。
    `test_data_permission.py` 一个模块就要登录十几次，`/auth/login/swagger` 的
    5次/分钟会把它们全打成 429 —— 那是测试相互干扰，不是被测行为。
    要验限流本身的用例用下面的 `rate_limiter` fixture 显式打开。
    """
    original = settings.REQUEST_LIMITER_ENABLED
    settings.REQUEST_LIMITER_ENABLED = False
    try:
        yield
    finally:
        settings.REQUEST_LIMITER_ENABLED = original


@pytest.fixture
def rate_limiter() -> Generator[None, None, None]:
    """给「要验 429」的用例临时打开限流"""
    original = settings.REQUEST_LIMITER_ENABLED
    settings.REQUEST_LIMITER_ENABLED = True
    try:
        yield
    finally:
        settings.REQUEST_LIMITER_ENABLED = original


@pytest.fixture(scope='session')
def client() -> Generator:
    with TestClient(app, base_url=PYTEST_BASE_URL) as c:
        yield c


@pytest.fixture(scope='module')
def token_headers(client: TestClient) -> dict[str, str]:
    params = {
        'username': PYTEST_USERNAME,
        'password': PYTEST_PASSWORD,
    }
    response = client.post('/auth/login/swagger', params=params)
    response.raise_for_status()
    token_type = response.json()['token_type']
    access_token = response.json()['access_token']
    headers = {'Authorization': f'{token_type} {access_token}'}
    return headers

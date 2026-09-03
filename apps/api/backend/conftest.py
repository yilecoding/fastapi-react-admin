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
# 上面两行只换掉 `Depends(get_db)` 那条路。请求路径上还有几处是在模块顶层
# `from backend.database.db import async_db_session` 拿到会话的，它们连的始终是
# **开发库**（`DATABASE_SCHEMA`，即 fba）：
#
#   - `common/security/jwt.py`            —— JWT 用户解析
#   - `app/admin/service/login_log_service.py` —— 登录日志落库
#   - `middleware/opera_log_middleware.py`     —— 操作日志落库
#   - `app/task/tasks/maintenance/tasks.py`    —— 定时清理任务（见下）
#
# 前三个的后果，都是静默的：
#   1. **跑一次 pytest 会往你的开发库里写登录日志和操作日志。** 本机看不出来，
#      因为那些表本来就一直在长。
#   2. 全新环境（CI）里开发库是空的 / 不存在，于是任何带 token 的请求都在
#      `get_jwt_user()` 里 `TokenError`。本机从来没暴露过，是因为两个库里
#      **恰好都有同 ID 的 admin**（种子 SQL 的雪花 ID 是写死的常量）。
#
# 🔴 **第四个的后果不是静默写错库，是静默删错库。** `maintenance/tasks.py` 是
# 全仓唯一会 DELETE 数据的定时任务。它现在只靠自己测试文件里 `run_prune()`
# 手工做一次同款 monkeypatch 才连得到测试库——那是**局部**补丁，只保护"经过
# `run_prune()` 调用"这一条路径。以后任何新测试如果绕过 `run_prune()` 直接
# import `prune_logs`/`prune_task_results` 来跑，这个模块的 `async_db_session`
# 会退回它自己 import 时绑定的那个（开发库），真的会删掉 `fba` 里的数据。
# 补进这张表之后，即便绕过 `run_prune()`，最坏情况也只是撞上"绑定到不同
# 事件循环"报错（`run_prune()` docstring 里那条坑）——一个吵闹的测试失败，
# 而不是一次悄悄的真实数据删除。`run_prune()` 自己的局部 patch 因此变成
# 冗余（保留无害，跟 `test_data_permission.py` 那处同类冗余是同一个道理）。
#
# 所以在这里一次性把这几处都指到测试库。
_PATCHED_SESSION_MODULES = (
    'backend.common.security.jwt',
    'backend.app.admin.service.login_log_service',
    'backend.middleware.opera_log_middleware',
    'backend.app.task.tasks.maintenance.tasks',
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


# ── 接口覆盖：记录测试真正打到过哪些路由 ──────────────────────────────────────
#
# 🔴 **为什么要真记，而不是 grep 测试文件里的路径字面量。** 试过后者，
# 得到的数字**两个方向都不可信**：
#
# | 判据 | 结果 | 错在哪 |
# |---|---|---|
# | 只认整条路径字面量 | 55% | **漏判** —— 测试常把路径存成常量再拼，字面量永远不出现 |
# | 路径每一段都在测试里出现过 | 91% | **误判** —— 各段到处都有，碰巧全中就算「覆盖」 |
#
# 真值在两者之间，而两个都会被当成结论引用。所以改成在 `TestClient` 上记实际
# 请求，再拿 FastAPI 自己的路由表匹配 —— 这个没有解释空间。
#
# ⚠️ **只在跑完整套件时才报告。** `pytest -k foo` 只跑一部分，那时「没打到」
# 不等于「没测试」—— 不加这个判断的话，报告会在每次局部运行时谎报一片空缺。
_ENDPOINT_HITS: set[tuple[str, str]] = set()


@pytest.fixture(scope='session', autouse=True)
def _record_endpoint_hits(client: TestClient) -> Generator[None, None, None]:
    """把 TestClient 的 request 包一层，记下 (方法, 具体路径)"""
    original = client.request

    def recording(method, url, *args, **kwargs) -> object:
        path = str(url).split('?', 1)[0]
        marker = 'testserver'
        if marker in path:
            path = path[path.index(marker) + len(marker) :]
        if not path.startswith('/'):
            path = '/' + path
        _ENDPOINT_HITS.add((str(method).upper(), path))
        return original(method, url, *args, **kwargs)

    client.request = recording
    yield
    client.request = original


def pytest_terminal_summary(terminalreporter, exitstatus, config) -> None:
    """跑完整套件时，打印没被任何请求打到的接口

    ⚠️ 用 `pytest_terminal_summary` 而不是 `pytest_sessionfinish` —— 后者里的
    `print` 会被 pytest 的输出捕获吞掉（实测：测试全绿但报告一个字都不出来）。
    """
    import re

    if not _ENDPOINT_HITS:
        return
    opt = config.option
    if getattr(opt, 'keyword', None) or getattr(opt, 'markexpr', None):
        return
    # ⚠️ **要看真实命令行参数，不能看 `config.args`** —— 后者被 `pyproject.toml`
    # 的 `testpaths` 填满了（四个目录），拿它判断会把「跑整套」也误判成局部，
    # 于是报告永远不出现（实测：全绿但一个字都不打）。
    cli = [a for a in config.invocation_params.args if not a.startswith('-')]
    if cli:
        return

    spec_paths = app.openapi()['paths']
    prefix = settings.FASTAPI_API_V1_PATH
    methods = ('GET', 'POST', 'PUT', 'DELETE', 'PATCH')
    missing = []
    total = 0
    for path, item in spec_paths.items():
        rel = path.removeprefix(prefix)
        pattern = re.compile('^' + re.sub(r'\\\{[a-z_]+\\\}', '[^/]+', re.escape(rel)) + '$')
        for method in item:
            if method.upper() not in methods:
                continue
            total += 1
            if not any(m == method.upper() and pattern.match(p) for m, p in _ENDPOINT_HITS):
                missing.append(f'{method.upper():6} {path}')

    hit = total - len(missing)
    terminalreporter.write_sep('=', '接口覆盖')
    terminalreporter.write_line(f'{hit}/{total}（{100 * hit / total:.0f}%）—— 按测试真正发出的请求算')
    if missing:
        terminalreporter.write_line('没被任何测试请求打到的接口：')
        for line in sorted(missing):
            terminalreporter.write_line(f'  {line}')

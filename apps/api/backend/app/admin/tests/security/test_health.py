"""健康检查端点。

给编排用的探活入口，同时也是三条「不做什么」的回归：路径在 `/api/v1` 之外
（不进操作日志）、不挂 `DependsJwtAuth`（不需要 token）、不挂 `RateLimiter`
（探针不该被限流打掉）。这三条都是**没写某行代码**换来的，最容易在重构中
被顺手加回去。
"""

from starlette.testclient import TestClient

from backend.core.conf import settings

# `client` fixture 的 base_url 带着 /api/v1 前缀，而健康检查刻意在前缀之外，
# 所以这里用绝对地址访问
_LIVE = 'http://testserver/health/live'
_READY = 'http://testserver/health/ready'


def test_liveness_needs_no_token(client: TestClient) -> None:
    resp = client.get(_LIVE)
    assert resp.status_code == 200
    assert resp.json()['status'] == 'alive'


def test_readiness_reports_dependencies(client: TestClient) -> None:
    """就绪探针要把每个依赖的状态列出来，而不是只给一个布尔"""
    resp = client.get(_READY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body['status'] == 'ready'
    assert body['checks'] == {'database': 'ok', 'redis': 'ok'}


def test_readiness_is_not_wrapped_in_the_response_envelope(client: TestClient) -> None:
    """🔴 不能套 ResponseModel

    那层信封永远是 HTTP 200 + body 里的 code。探针只看状态码，
    套上之后「DB 挂了」会被读成健康 —— 硬纪律 9 的同一类错误。
    这条断言 body 里没有信封的形状。
    """
    body = client.get(_READY).json()
    assert 'code' not in body and 'data' not in body, f'健康检查被套进了响应信封：{body}'


def test_health_paths_stay_outside_the_api_prefix() -> None:
    """🔴 路径必须在 /api/v1 之外

    `OperaLogMiddleware` / `AccessMiddleware` 都按 `path.startswith(前缀)`
    决定要不要记录。挂进 /api/v1 的话，15 秒一次的探针会把 sys_opera_log 刷爆，
    而这件事没有任何报错 —— 只是表长得飞快。
    """
    from backend.main import app

    health_paths = [r.path for r in app.routes if getattr(r, 'path', '').startswith('/health')]
    assert health_paths, '一条 /health 路由都没注册'
    for path in health_paths:
        assert not path.startswith(settings.FASTAPI_API_V1_PATH), f'{path} 落在了 /api/v1 里'


def test_health_routes_have_no_dependencies() -> None:
    """不挂鉴权、不挂限流 —— 两者都是 per-route 依赖，这条守住它们没被加上"""
    from backend.main import app

    for route in app.routes:
        if getattr(route, 'path', '').startswith('/health'):
            deps = getattr(route, 'dependencies', [])
            assert not deps, f'{route.path} 挂了依赖 {deps}，探针会被鉴权或限流挡住'

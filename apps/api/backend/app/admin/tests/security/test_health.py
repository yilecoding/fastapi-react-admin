"""健康检查端点。

给编排用的探活入口，同时也是三条「不做什么」的回归：路径在 `/api/v1` 之外
（不进操作日志）、不挂 `DependsJwtAuth`（不需要 token）、不挂 `RateLimiter`
（探针不该被限流打掉）。这三条都是**没写某行代码**换来的，最容易在重构中
被顺手加回去。
"""

import asyncio
import time
import uuid

from collections.abc import Callable, Generator
from contextlib import asynccontextmanager
from datetime import timedelta

import pytest

from redis import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from starlette.testclient import TestClient

from backend.core.conf import settings

# `client` fixture 的 base_url 带着 /api/v1 前缀，而健康检查刻意在前缀之外，
# 所以这里用绝对地址访问
_READY = 'http://testserver/health/ready'


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


# ---------------------------------------------------------------------------
# 反向用例：依赖不通时必须 503，且响应里不能带出连接信息
# ---------------------------------------------------------------------------

#: 伪造异常的 message 里塞一串「连接信息长什么样」—— 真实的连接错误 message 就带主机、端口和用户名。
#: 这几条经 web 的 nginx 不鉴权地开着，响应里只许有异常的**类型名**
_LEAK = 'postgresql://fba_app:Passw0rd@10.9.8.7:5432/fba'


class _BrokenRedis:
    async def ping(self) -> None:
        raise RedisConnectionError(_LEAK)

    async def mget(self, *keys: str) -> None:
        raise RedisConnectionError(_LEAK)


@asynccontextmanager
async def _broken_session():
    raise ConnectionRefusedError(_LEAK)
    yield


def test_readiness_is_503_when_database_is_down(client: TestClient, monkeypatch) -> None:
    import backend.core.registrar as registrar

    monkeypatch.setattr(registrar, 'async_db_session', _broken_session)
    resp = client.get(_READY)
    assert resp.status_code == 503, resp.text
    assert resp.json() == {
        'status': 'degraded',
        'checks': {'database': 'error: ConnectionRefusedError', 'redis': 'ok'},
    }
    assert _LEAK not in resp.text


def test_readiness_is_503_when_redis_is_down(client: TestClient, monkeypatch) -> None:
    import backend.core.registrar as registrar

    monkeypatch.setattr(registrar, 'redis_client', _BrokenRedis())
    resp = client.get(_READY)
    assert resp.status_code == 503, resp.text
    assert resp.json() == {
        'status': 'degraded',
        'checks': {'database': 'ok', 'redis': 'error: ConnectionError'},
    }
    assert _LEAK not in resp.text


def test_readiness_ignores_heartbeats(client: TestClient, heartbeats) -> None:
    """🔴 调度器 / worker 全停了，ready 照样 200

    compose 里 api 的 healthcheck 用 ready，web / beat 都 `depends_on` api 健康。心跳并进 ready 的话，
    worker 一挂 api 也被判不健康，web 跟着起不来 —— 一个后台进程的故障连成整站故障
    """
    heartbeats(scheduler=None, worker=None)
    resp = client.get(_READY)
    assert resp.status_code == 200, resp.text
    assert resp.json()['checks'] == {'database': 'ok', 'redis': 'ok'}


# ---------------------------------------------------------------------------
# /health/status：各服务一页看全
# ---------------------------------------------------------------------------

_STATUS = 'http://testserver/health/status'
_SERVICES = ['api', 'database', 'redis', 'scheduler', 'worker']


@pytest.fixture
def heartbeats(monkeypatch) -> Generator[Callable[..., None], None, None]:
    """把两个心跳键换成本用例独占的，返回 `set_age(scheduler=秒前, worker=秒前)`（None = 删掉）

    🔴 不能直接动真键：本机 `pnpm dev` 的 beat / worker 一直在往真键写，会和断言抢。
    用同步客户端写 —— 应用的 `redis_client` 绑在 TestClient 的事件循环上，这里另开循环会撞
    `attached to a different loop`
    """
    tag = uuid.uuid4().hex
    keys = {
        'scheduler': f'{settings.SCHEDULER_HEARTBEAT_REDIS_KEY}:pytest:{tag}',
        'worker': f'{settings.WORKER_HEARTBEAT_REDIS_KEY}:pytest:{tag}',
    }
    monkeypatch.setattr(settings, 'SCHEDULER_HEARTBEAT_REDIS_KEY', keys['scheduler'])
    monkeypatch.setattr(settings, 'WORKER_HEARTBEAT_REDIS_KEY', keys['worker'])
    r = Redis(
        host=settings.REDIS_HOST,
        port=settings.REDIS_PORT,
        password=settings.REDIS_PASSWORD or None,
        db=settings.REDIS_DATABASE,
    )

    def set_age(**ages: float | None) -> None:
        for name, seconds_ago in ages.items():
            if seconds_ago is None:
                r.delete(keys[name])
            else:
                r.set(keys[name], f'{time.time() - seconds_ago:.3f}')

    yield set_age
    r.delete(*keys.values())
    r.close()


def _services(resp) -> dict:
    body = resp.json()
    assert 'code' not in body and 'data' not in body, f'被套进了响应信封：{body}'
    assert list(body) == ['status', 'services', 'heartbeat_max_age_seconds'], body
    assert list(body['services']) == _SERVICES, body
    return body['services']


def test_status_all_ok(client: TestClient, heartbeats) -> None:
    heartbeats(scheduler=5, worker=20)
    resp = client.get(_STATUS)
    assert resp.status_code == 200, resp.text
    assert resp.json()['status'] == 'ok'
    services = _services(resp)
    assert all(s['status'] == 'ok' for s in services.values()), services
    assert 4 <= services['scheduler']['last_seen_seconds'] <= 10
    assert 19 <= services['worker']['last_seen_seconds'] <= 25
    assert resp.json()['heartbeat_max_age_seconds'] == settings.HEARTBEAT_MAX_AGE_SECONDS


def test_status_needs_no_token(client: TestClient, heartbeats) -> None:
    """不带任何头也要拿得到 —— 监控方手里没有 token"""
    heartbeats(scheduler=5, worker=5)
    resp = client.get(_STATUS, headers={})
    assert resp.status_code == 200, resp.text


def test_status_body_matches_the_monitor_keywords(client: TestClient, heartbeats) -> None:
    """🔴 监控方会按字面量匹配，紧凑 JSON + 字段顺序是契约的一部分

    - 整体正常认开头的 `{"status":"ok","services"` —— **不能只认 `"status":"ok"`**：
      降级时正常的那几项里也有这个子串，会被误判成正常（下半段就是在证明这件事）
    - 按服务告警认 `"worker":{"status":"ok"` 这种
    """
    heartbeats(scheduler=5, worker=5)
    ok = client.get(_STATUS).text
    assert ok.startswith('{"status":"ok","services":{"api":{"status":"ok"},"database":{"status":"ok"}'), ok
    for name in _SERVICES:
        assert f'"{name}":{{"status":"ok"' in ok, (name, ok)

    heartbeats(worker=settings.HEARTBEAT_MAX_AGE_SECONDS + 60)
    degraded = client.get(_STATUS).text
    assert '"status":"ok"' in degraded, '这条断言证明「只认 \'"status":"ok"\'」会误判'
    assert not degraded.startswith('{"status":"ok","services"'), degraded
    assert '"worker":{"status":"ok"' not in degraded, degraded
    assert '"scheduler":{"status":"ok"' in degraded, degraded


def test_status_503_when_worker_stops(client: TestClient, heartbeats) -> None:
    """worker 停了：调度器照常（还在派），worker 的心跳停在那一刻 —— 指名是 worker，并报出停了多久"""
    stopped = settings.HEARTBEAT_MAX_AGE_SECONDS + 60
    heartbeats(scheduler=5, worker=stopped)
    resp = client.get(_STATUS)
    assert resp.status_code == 503, resp.text
    assert resp.json()['status'] == 'degraded'
    services = _services(resp)
    assert services['scheduler']['status'] == 'ok'
    assert services['worker']['status'] == 'stale'
    assert services['worker']['last_seen_seconds'] >= stopped
    assert services['api'] == services['database'] == services['redis'] == {'status': 'ok'}


def test_status_scheduler_down_makes_worker_unknown(client: TestClient, heartbeats) -> None:
    """调度器停了：worker 收不到心跳任务，它的心跳也会停 —— 但那不是 worker 的错，报 unknown 不报 stale"""
    stopped = settings.HEARTBEAT_MAX_AGE_SECONDS + 60
    heartbeats(scheduler=stopped, worker=stopped)
    resp = client.get(_STATUS)
    assert resp.status_code == 503, resp.text
    services = _services(resp)
    assert services['scheduler']['status'] == 'stale'
    assert services['worker']['status'] == 'unknown'


def test_status_503_when_heartbeat_was_never_written(client: TestClient, heartbeats) -> None:
    """调度器在、worker 从没写过 —— 调度那一行没种上 / 被删了，也必须是 503，不能当成「没消息就是好消息」"""
    heartbeats(scheduler=5, worker=None)
    resp = client.get(_STATUS)
    assert resp.status_code == 503, resp.text
    services = _services(resp)
    assert services['worker'] == {'status': 'missing', 'last_seen_seconds': None}


def test_status_503_when_database_is_down(client: TestClient, heartbeats, monkeypatch) -> None:
    import backend.core.registrar as registrar

    heartbeats(scheduler=5, worker=5)
    monkeypatch.setattr(registrar, 'async_db_session', _broken_session)
    resp = client.get(_STATUS)
    assert resp.status_code == 503, resp.text
    services = _services(resp)
    assert services['database'] == {'status': 'error', 'error': 'ConnectionRefusedError'}
    assert services['redis'] == {'status': 'ok'}
    assert _LEAK not in resp.text


def test_status_503_when_redis_is_down(client: TestClient, monkeypatch) -> None:
    """Redis 不通：调度器 / worker 的心跳读不到，判断不了 —— unknown，不冤枉它们"""
    import backend.core.registrar as registrar

    monkeypatch.setattr(registrar, 'redis_client', _BrokenRedis())
    resp = client.get(_STATUS)
    assert resp.status_code == 503, resp.text
    services = _services(resp)
    assert services['redis'] == {'status': 'error', 'error': 'ConnectionError'}
    assert services['scheduler']['status'] == services['worker']['status'] == 'unknown'
    assert _LEAK not in resp.text


def test_status_checks_time_out_and_run_concurrently(client: TestClient, monkeypatch) -> None:
    """依赖挂住（不是拒绝连接，是一直不回）时，每项都要按自己的超时放弃，且三项并发 ——
    串行的话总耗时是三个超时相加，会超过监控方探针的超时，监控看到的就是「探针超时」而不是哪一项坏了
    """
    import backend.core.registrar as registrar

    class _HangingRedis:
        async def ping(self) -> None:
            await asyncio.sleep(3600)

        async def mget(self, *keys: str) -> None:
            await asyncio.sleep(3600)

    @asynccontextmanager
    async def hanging_session():
        await asyncio.sleep(3600)
        yield

    monkeypatch.setattr(registrar, 'async_db_session', hanging_session)
    monkeypatch.setattr(registrar, 'redis_client', _HangingRedis())
    monkeypatch.setattr(registrar, '_DB_TIMEOUT', 1.0)
    monkeypatch.setattr(registrar, '_REDIS_TIMEOUT', 1.0)

    started = time.monotonic()
    resp = client.get(_STATUS)
    elapsed = time.monotonic() - started
    assert resp.status_code == 503, resp.text
    services = _services(resp)
    assert services['database'] == {'status': 'error', 'error': 'TimeoutError'}
    assert services['redis'] == {'status': 'error', 'error': 'TimeoutError'}
    assert services['worker']['status'] == 'unknown'
    # 串行是 1 + 1 + 1 = 3 秒，并发是 1 秒多一点
    assert elapsed < 2.0, f'{elapsed:.2f} 秒 —— 三项检查没有并发'


# ---------------------------------------------------------------------------
# 两个心跳的写入方：调度器（beat）的调度循环、worker 执行的 health.heartbeat
# ---------------------------------------------------------------------------


def test_scheduler_tick_writes_the_scheduler_heartbeat(client: TestClient, heartbeats, monkeypatch) -> None:
    """调度循环每一拍都要留心跳，键名 / 格式要和探针读的对得上（真写真读，一次往返）"""
    from celery.beat import Scheduler

    from backend.app.task.utils.schedulers import DatabaseScheduler

    heartbeats(scheduler=None, worker=5)
    next_in = object()
    monkeypatch.setattr(Scheduler, 'tick', lambda self, *a, **kw: next_in)
    sched = DatabaseScheduler.__new__(DatabaseScheduler)  # 不连库：只验 tick 里那一步
    sched._last_heartbeat = 0.0

    assert sched.tick() is next_in, 'tick 的返回值（下次多久再来）被吞了'
    resp = client.get(_STATUS)
    assert resp.status_code == 200, resp.text
    assert _services(resp)['scheduler']['last_seen_seconds'] <= 5


def test_scheduler_heartbeat_failure_does_not_stop_beat(monkeypatch) -> None:
    """Redis 写不进去时 beat 必须照常调度 —— 为了心跳让 beat 停摆，等于把监控变成故障源"""
    from celery.beat import Scheduler

    import backend.app.task.utils.schedulers as mod

    def boom():
        raise RedisConnectionError(_LEAK)

    monkeypatch.setattr(mod, '_sync_redis', boom)
    next_in = object()
    monkeypatch.setattr(Scheduler, 'tick', lambda self, *a, **kw: next_in)
    sched = mod.DatabaseScheduler.__new__(mod.DatabaseScheduler)
    sched._last_heartbeat = 0.0
    assert sched.tick() is next_in


def test_worker_heartbeat_task_feeds_the_status_probe(client: TestClient, heartbeats, monkeypatch) -> None:
    """任务写的键和格式，就是探针读的那个 —— 只改一边的话 worker 永远 missing，跟真挂了一模一样"""
    import backend.app.task.tasks.health.tasks as mod

    from backend.database.redis import RedisCli

    heartbeats(scheduler=5, worker=None)
    # 任务里的 redis_client 换成在本循环里新建的一个（理由同 heartbeats fixture）
    fresh = RedisCli()
    monkeypatch.setattr(mod, 'redis_client', fresh)

    async def go() -> None:
        try:
            await mod.heartbeat()
        finally:
            await fresh.aclose()

    asyncio.run(go())
    resp = client.get(_STATUS)
    assert resp.status_code == 200, resp.text
    assert _services(resp)['worker']['last_seen_seconds'] <= 5


def test_heartbeat_task_stays_quiet(monkeypatch) -> None:
    """🔴 每分钟一次的任务不能写执行记录、不能推 socket.io

    - 写执行记录：`task_result` 一天多 1440 行，「执行记录」页被心跳淹没
    - 推送：`TaskBase` 的开始 / 成功提示经 Redis 广播给所有在线页面
    对照组用 `prune_logs`，证明钩子本身还在推 —— 否则这条会因为「谁都不推了」而空跑通过
    """
    import backend.app.task.tasks.base as base

    from backend.app.task.tasks.health.tasks import heartbeat as hb
    from backend.app.task.tasks.maintenance.tasks import prune_logs

    assert hb.ignore_result is True
    assert prune_logs.ignore_result is False, '对照组也不存结果了 —— 是全局配置被改了，不是心跳任务自己关的'

    sent: list[str] = []

    async def record(msg: str) -> None:  # ruff: ignore[unused-async] —— 顶替的 task_notification 是协程
        sent.append(msg)

    monkeypatch.setattr(base, 'task_notification', record)

    async def go() -> None:
        await hb.before_start('t1', (), {})
        await hb.on_success(None, 't1', (), {})
        assert sent == [], f'心跳任务推送了：{sent}'
        await prune_logs.before_start('t2', (), {})
        await prune_logs.on_success(None, 't2', (), {})
        assert len(sent) == 2, '普通任务也不推了 —— notify 开关反了'

    asyncio.run(go())


def test_heartbeat_schedule_is_seeded_and_beats_inside_the_threshold(client: TestClient, token_headers) -> None:
    """调度那一行必须在库里、启用，间隔放得进阈值，过期时间等于阈值

    没有这一行 = worker 永远 missing。间隔 × 2 > 阈值 = 漏一拍就报警，一次发版换容器就误报。
    种子 SQL 和迁移各写了一份，这条查的是 fba_test（种子那份）
    """
    rows = client.get('/tasks/schedulers/all', headers=token_headers).json()['data']
    mine = [r for r in rows if r['task'] == 'health.heartbeat']
    assert len(mine) == 1, f'health.heartbeat 的调度应该恰好一行：{mine}'
    row = mine[0]
    assert row['enabled']
    assert row['type'] == 0, '心跳要用间隔调度，crontab 最细只到分钟'
    every = timedelta(**{row['interval_period']: row['interval_every']}).total_seconds()
    assert every * 2 <= settings.HEARTBEAT_MAX_AGE_SECONDS, (
        f'心跳每 {every:.0f} 秒一次，阈值 {settings.HEARTBEAT_MAX_AGE_SECONDS} 秒内容不下两拍'
    )
    assert row['expire_seconds'] == settings.HEARTBEAT_MAX_AGE_SECONDS, '排队超过阈值的心跳已经没有意义'


def test_scheduler_heartbeat_fits_inside_the_threshold() -> None:
    """beat 最长 `max_interval` 秒一拍、心跳最多 `heartbeat_every` 秒写一次 —— 两者都要放得进阈值"""
    from backend.app.task.utils.schedulers import DatabaseScheduler

    worst = DatabaseScheduler.max_interval + DatabaseScheduler.heartbeat_every
    assert worst * 2 <= settings.HEARTBEAT_MAX_AGE_SECONDS, (
        f'调度器最坏 {worst} 秒才写一次心跳，阈值 {settings.HEARTBEAT_MAX_AGE_SECONDS} 秒内容不下两拍'
    )


def test_worker_init_leaves_no_connection_bound_to_its_throwaway_loop(monkeypatch) -> None:
    """🔴 `worker_process_init` 在 `asyncio.run` 起的临时循环里 ping Redis，循环随即关闭

    连接留在池里的话，任务（跑在 AsyncIOPool 自己的循环里）拿到它就 `Event loop is closed` ——
    每个 worker 进程第一个用 Redis 的任务必失败。这里用第二个 `asyncio.run` 模拟「任务的循环」
    """
    import backend.database.redis as redis_mod

    from backend.app.task.celery import init_worker_runtime
    from backend.database.redis import RedisCli
    from backend.utils.snowflake import snowflake

    fresh = RedisCli()
    monkeypatch.setattr(redis_mod, 'redis_client', fresh)

    async def no_snowflake() -> None:
        pass

    monkeypatch.setattr(snowflake, 'init', no_snowflake)

    init_worker_runtime()

    async def first_task() -> bool:
        try:
            return await fresh.ping()
        finally:
            await fresh.aclose()

    assert asyncio.run(first_task()) is True

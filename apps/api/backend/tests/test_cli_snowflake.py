"""`fba init` 写库期间要自己占一个雪花节点（#292 · 评审补的四条）

改 admin / test 的密码会进数据变更审计，审计行用雪花主键、在提交那一刻才写；命令行不走 lifespan。
真正的端到端守卫是 CI 的「fba init（新库，非交互）」—— pytest 里复现不了（这个进程的雪花早被 lifespan 初始化），
这里测的是 `cli.snowflake_node` 本身和两条初始化路径的接线。

🔴 每条都用**自己建的** Redis 客户端、自己的 `Snowflake` 实例：在 `asyncio.run()` 里碰共享的 `redis_client`
会把它的连接池绑到一个随即关掉的循环上，后面的测试全是 `Event loop is closed`（`backend/tests` 分册）。
"""

import ast
import asyncio
import inspect
import textwrap

import pytest

from backend import cli
from backend.core.conf import settings
from backend.database.redis import RedisCli
from backend.utils.snowflake import Snowflake


@pytest.fixture
def fresh(monkeypatch: pytest.MonkeyPatch) -> Snowflake:
    """一个没初始化过的发号器，换掉 cli 里那个（进程里的全局实例早被 lifespan 初始化了）"""
    gen = Snowflake()
    monkeypatch.setattr(cli, 'snowflake', gen)
    monkeypatch.setattr(settings, 'SNOWFLAKE_DATACENTER_ID', None)
    monkeypatch.setattr(settings, 'SNOWFLAKE_WORKER_ID', None)
    return gen


def _other_db_client() -> RedisCli:
    """和全局 `redis_client` 不同库号的客户端 —— 节点记在哪个库里，就证明用的是哪个客户端"""
    return RedisCli(db=(settings.REDIS_DATABASE + 1) % 16)


def test_takes_a_node_on_the_given_redis_and_gives_it_back(fresh: Snowflake, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, 'DATABASE_PK_MODE', 'snowflake')

    async def scenario() -> tuple[list[str], int, list[str]]:
        redis = _other_db_client()
        try:
            async with cli.snowflake_node(redis):
                key = f'{settings.SNOWFLAKE_REDIS_PREFIX}:nodes:{fresh.datacenter_id}:{fresh.worker_id}'
                held = [k for k in [key] if await redis.exists(k)]
                new_id = fresh.generate()  # 没占节点时这里报「雪花算法未初始化」
            after = [k for k in [key] if await redis.exists(k)]
            return held, new_id, after
        finally:
            await redis.aclose()

    held, new_id, after = asyncio.run(scenario())
    # `--auto` 在进程里改过 Redis 配置：租约要记在传进来的那个客户端上，不能记到全局那个（旧配置）上
    assert held, '节点没有记在传进来的 Redis 上'
    assert new_id > 0
    assert after == [], '用完没有放掉节点'


def test_autoincrement_mode_does_not_take_a_node(fresh: Snowflake, monkeypatch: pytest.MonkeyPatch) -> None:
    """自增主键模式下 lifespan 不占节点，命令行也不该占 —— 否则 Redis 里没空节点 / 节点配置写了一半时 init 白白失败"""
    monkeypatch.setattr(settings, 'DATABASE_PK_MODE', 'autoincrement')
    monkeypatch.setattr(settings, 'SNOWFLAKE_ENABLED', False)

    class Unreachable:
        def __getattr__(self, name: str) -> object:
            raise AssertionError(f'自增主键模式下不该碰 Redis（调了 {name}）')

    async def scenario() -> None:
        async with cli.snowflake_node(Unreachable()):  # type: ignore[arg-type]
            pass

    asyncio.run(scenario())
    assert fresh._initialized is False


def test_a_failed_release_does_not_turn_a_finished_init_into_a_crash(
    fresh: Snowflake, monkeypatch: pytest.MonkeyPatch
) -> None:
    """库已经建好、提交了，放节点时 Redis 抖一下：要告警，不能冒成异常 —— 用户会以为失败了、重跑就是再删一遍库"""
    monkeypatch.setattr(settings, 'DATABASE_PK_MODE', 'snowflake')
    monkeypatch.setattr(settings, 'SNOWFLAKE_DATACENTER_ID', 1)
    monkeypatch.setattr(settings, 'SNOWFLAKE_WORKER_ID', 1)

    async def broken_shutdown() -> None:  # ruff:ignore[unused-async] —— 调用方 await 它
        raise ConnectionError('redis went away')

    monkeypatch.setattr(fresh, 'shutdown', broken_shutdown)
    warnings: list[str] = []
    monkeypatch.setattr(cli.console, 'warning', warnings.append)

    async def scenario() -> bool:
        async with cli.snowflake_node(_other_db_client()):
            return fresh._initialized

    assert asyncio.run(scenario()) is True
    assert len(warnings) == 1
    assert 'redis went away' in warnings[0]


def _async_with_items(func: object) -> list[list[str]]:
    """函数里每个 `async with` 的各项，按书写顺序，取被调用的名字（`a.b()` 取 `b`）"""
    tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncWith):
            names = []
            for item in node.items:
                call = item.context_expr
                if isinstance(call, ast.Call):
                    names.append(
                        call.func.attr if isinstance(call.func, ast.Attribute) else getattr(call.func, 'id', '')
                    )
            found.append(names)
    return found


@pytest.mark.parametrize('entry', [cli.auto_init, cli.Init.__call__], ids=['init --auto', 'init'])
def test_both_init_paths_hold_a_node_around_the_transaction(entry: object) -> None:
    """两条路都要占节点，而且要包在事务**外面**：审计行在事务退出（提交）时才写，那时节点还得在

    `fba init` 那条有 CI 端到端跑；`--auto` 是交互式向导（`pnpm db:reset`），CI 跑不了，只能在这里看接线。
    """
    withs = [w for w in _async_with_items(entry) if 'begin' in w]
    assert withs, '没找到写库的那个事务'
    for items in withs:
        assert 'snowflake_node' in items, f'事务没有包在 snowflake_node 里：{items}'
        assert items.index('snowflake_node') < items.index('begin'), f'snowflake_node 要排在事务前面：{items}'

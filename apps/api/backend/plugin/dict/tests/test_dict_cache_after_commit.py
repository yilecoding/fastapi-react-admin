"""#394 ②：`@cache_invalidate` 要在**提交之后**再清一次。

装饰器在被装饰的函数一返回就清，提交在依赖收尾时。空档里别人的读拿到的还是旧行，会把它写回 L1 和 Redis，
之后没人再清（字典的 Redis TTL 两小时）。这里把那次「并发读」模拟成：第一次清完、提交之前，往命名空间里写一个旧值。
"""

import asyncio
import uuid

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from sqlalchemy import event
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from backend.common import after_commit
from backend.common.cache import decorator
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.dict.model import DictData, DictType
from backend.tests.utils.data_change import engine

_RUN = uuid.uuid4().hex[:8]
TYPES = '/sys/dict-types'
DATAS = '/sys/dict-datas'
STALE = f'{settings.CACHE_DICT_REDIS_PREFIX}:pytest-stale-{_RUN}'


@pytest.fixture(autouse=True)
def _purge(client: TestClient) -> Iterator[None]:
    yield
    client.portal.call(redis_client.delete, STALE)
    with engine().begin() as conn:
        conn.execute(sa.delete(DictData.__table__).where(DictData.__table__.c.type_code == f'ca{_RUN}'))
        conn.execute(sa.delete(DictType.__table__).where(DictType.__table__.c.code == f'ca{_RUN}'))


def test_a_read_between_invalidation_and_commit_does_not_pin_the_old_value(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    code = f'ca{_RUN}'
    assert client.post(TYPES, headers=token_headers, json={'name': f'缓存{_RUN}', 'code': code}).json()['code'] == 200
    type_id = client.get(TYPES, headers=token_headers, params={'code': code}).json()['data']['items'][0]['id']

    committed = False
    calls: list[bool] = []
    real = decorator.invalidate_cache

    async def racing_invalidate(key: str, *, prefix: bool) -> None:
        await real(key, prefix=prefix)
        calls.append(committed)
        if not committed:
            # 并发请求在这个空档里读到旧行、写回缓存
            await redis_client.set(STALE, 'old', ex=600)

    def on_commit(_session: Session) -> None:
        nonlocal committed
        committed = True

    monkeypatch.setattr(decorator, 'invalidate_cache', racing_invalidate)
    event.listen(Session, 'after_commit', on_commit)
    try:
        item = {'type_id': type_id, 'label': '缓存项', 'value': '1', 'sort': 0, 'status': 1}
        assert client.post(DATAS, headers=token_headers, json=item).json()['code'] == 200

        async def settle() -> None:
            if after_commit._background:
                await asyncio.gather(*list(after_commit._background))

        client.portal.call(settle)
    finally:
        event.remove(Session, 'after_commit', on_commit)

    assert calls and calls[0] is False, '前提：第一次清发生在提交之前（模拟的空档存在）'
    assert not client.portal.call(redis_client.exists, STALE), '提交之后没再清：空档里写回的旧值留到 TTL'


def test_atomic_false_still_swallows_a_key_builder_error_when_a_session_is_passed() -> None:
    """`atomic=False` 的契约是「清不掉只记日志」。提交后那次登记要用 `invalidate_key`，
    key 都没算出来时不能再去读它（原来是 UnboundLocalError → 500，业务写入跟着回滚）"""
    from sqlalchemy.ext.asyncio import AsyncSession

    def broken(**_: object) -> str:
        raise RuntimeError('key builder broke')

    @decorator.cache_invalidate(namespace='pytest-ns', key_builder=broken, atomic=False)
    async def write(*, db: AsyncSession) -> str:
        await asyncio.sleep(0)
        return 'written'

    db = AsyncSession()
    assert asyncio.run(write(db=db)) == 'written'
    assert not db.sync_session.info.get(after_commit._PENDING), 'key 没算出来，不该登记提交后的清理'

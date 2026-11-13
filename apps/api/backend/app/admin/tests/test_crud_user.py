"""用户 DAO 查询筛选条件的回归测试。"""

import asyncio

from unittest.mock import AsyncMock

from backend.app.admin.crud.crud_user import user_dao


def test_get_join_without_lookup_criteria_skips_query(monkeypatch) -> None:
    select_models = AsyncMock(return_value=[])
    monkeypatch.setattr(user_dao, 'select_models', select_models)

    result = asyncio.run(user_dao.get_join(object()))

    assert result is None
    select_models.assert_not_awaited()


def test_get_join_preserves_zero_user_id_filter(monkeypatch) -> None:
    select_models = AsyncMock(return_value=[])
    monkeypatch.setattr(user_dao, 'select_models', select_models)

    result = asyncio.run(user_dao.get_join(object(), user_id=0))

    assert result is None
    assert select_models.await_args is not None
    assert select_models.await_args.kwargs['id'] == 0
    assert select_models.await_args.kwargs['deleted'] == 0

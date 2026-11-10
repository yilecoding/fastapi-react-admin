"""给各模块测「改了会不会留下数据变更记录」用的小工具（#281）。

只读写测试库，同步引擎（和 `app/admin/tests/api_v1/test_data_change.py` 同一个做法）。

⚠️ 刻意**不提供删审计记录的工具**：记录挂在临时对象名下，留着无害；删了就在防篡改链上挖出缺口，
同一个库上之后跑的「校验完整性」（E2E `data-change.spec.ts`）会报「中间少了几行」。
"""

import json

from typing import Any

import sqlalchemy as sa

from sqlalchemy.orm import Session

from backend.app.admin.model import DataChange
from backend.tests.utils.db import sync_test_db_url

_engine: sa.Engine | None = None


def engine() -> sa.Engine:
    global _engine
    if _engine is None:
        _engine = sa.create_engine(sync_test_db_url())
    return _engine


def changes_of(entity: str, entity_id: Any) -> list[dict[str, Any]]:
    """这个对象的全部变更记录，旧的在前"""
    with engine().connect() as conn:
        rows = conn.execute(
            sa
            .select(DataChange.__table__)
            .where(DataChange.entity_type == entity, DataChange.entity_id == int(entity_id))
            .order_by(DataChange.created_time, DataChange.id)
        ).mappings()
        return [dict(r) for r in rows]


def field(record: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((c for c in record['changes'] if c['field'] == name), None)


def column_value(model: Any, pk: Any, column: str) -> Any:
    """直接从库里读一列（拿密文来断言它没进审计表）"""
    table = model.__table__
    with engine().connect() as conn:
        return conn.execute(sa.select(table.c[column]).where(table.c.id == int(pk))).scalar_one()


def assert_never_recorded(records: list[dict[str, Any]], *values: str) -> None:
    """🔴 明文和密文都不能出现在任何一条记录里。先断言「有」：没有记录时这句什么都证明不了"""
    assert records, '一条记录都没有 —— 「没记下密钥」在什么都没记时也成立'
    dumped = json.dumps([r['changes'] for r in records], ensure_ascii=False, default=str)
    labels = ' '.join(str(r['entity_label']) for r in records)
    for value in values:
        assert value, '要断言的值是空的'
        assert value not in dumped and value not in labels, f'{value[:12]}… 进了数据变更记录：{dumped[:500]}'


def write_in_session(statement: Any) -> None:
    """用一个独立的同步会话执行一条写语句并提交（拦截层挂在会话上，和接口走的是同一套）"""
    with Session(engine()) as session:
        session.execute(statement)
        session.commit()

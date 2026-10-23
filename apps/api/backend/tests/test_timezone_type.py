"""`TimeZone` 在三个方言上建出来的列类型（#132）

MySQL 不在 CI 里，这里是 CI 上唯一看得见「MySQL 的时间列只到秒」的地方 —— 编译 DDL 不用连库。
"""

import pytest

from sqlalchemy import Column, MetaData, Table
from sqlalchemy.dialects import mssql, mysql, postgresql
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.schema import CreateTable

from backend.common.model import TimeZone


@pytest.mark.parametrize(
    ('dialect', 'ddl'),
    [
        (mysql.dialect(), 'DATETIME(6)'),
        (postgresql.dialect(), 'TIMESTAMP WITH TIME ZONE'),
        (mssql.dialect(), 'DATETIMEOFFSET'),
    ],
    ids=['mysql', 'postgresql', 'mssql'],
)
def test_time_columns_keep_sub_second_precision(dialect: Dialect, ddl: str) -> None:
    """🔴 MySQL 的 DATETIME 不写精度就只到秒，同一秒内的两件事分不出先后（回收站还原按时间相等认同一批）"""
    table = Table('t', MetaData(), Column('at', TimeZone(timezone=True)))
    assert f'at {ddl}' in str(CreateTable(table).compile(dialect=dialect))

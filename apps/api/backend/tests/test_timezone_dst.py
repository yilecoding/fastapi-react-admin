"""`TimeZone` 遇到夏令时（#200：model.py 里那句「TODO 处理夏令时偏移」到底要不要处理）

结论：**带时区的值不会被夏令时搞错**。那条分支是「偏移和*现在*不一样就 `astimezone(应用时区)`」——
冬天的值在夏天写入时偏移确实不同，但 `astimezone` 按**那个时刻**查规则，换算出来还是同一个时刻、
带着当时正确的偏移，没有平移一小时。所以 TODO 不需要「处理」，这里把它钉成测试。

唯一的缺口在 **MySQL**（`DATETIME` 不存偏移，只存应用时区的墙上时间）：秋季回拨那一小时的墙上时间
出现两次，读回来只能当成第一次（`fold=0`），第二次的记录会早一小时。PostgreSQL / SQL Server
存的是带偏移的时刻，不受影响。见最后那条 xfail。

⚠️ 顺带实测到一个 Python 的坑：**同一个 ZoneInfo 的两个 aware datetime 相减是按墙上时间减的**，
跨夏令时差一小时。算时长要先 `.astimezone(UTC)`（PostgreSQL / SQL Server 驱动读回来本来就是
UTC 或固定偏移，不中招；MySQL 读回来被补上应用时区，会中招）。

应用时区刻意设成有夏令时的 `America/New_York`（默认的 `Asia/Shanghai` 没有夏令时，什么都测不出来）。
"""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from backend.common.model import TimeZone
from backend.utils.timezone import timezone

NY = ZoneInfo('America/New_York')
SUMMER_NOW = datetime(2026, 7, 1, 12, 0, tzinfo=NY)  # EDT，-04:00


@pytest.fixture
def ny(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(timezone, 'tz_info', NY)
    monkeypatch.setattr(timezone, 'now', lambda: SUMMER_NOW)


def bind(value: datetime) -> datetime:
    return TimeZone().process_bind_param(value, None)


def test_winter_value_written_in_summer_keeps_its_instant_and_offset(ny: None) -> None:
    """🔴 那条 TODO 分支：冬天（-05:00）的值、夏天（-04:00）写入，不能被平移一小时"""
    winter = datetime(2026, 1, 15, 9, 0, tzinfo=NY)
    out = bind(winter)
    assert out == winter  # 同一个时刻
    assert out.utcoffset() == timedelta(hours=-5)  # 偏移是当时的，不是「现在」的


def test_utc_value_is_converted_to_the_offset_of_that_date(ny: None) -> None:
    out = bind(datetime(2026, 1, 15, 14, 0, tzinfo=UTC))
    assert out == datetime(2026, 1, 15, 14, 0, tzinfo=UTC)
    assert (out.hour, out.utcoffset()) == (9, timedelta(hours=-5))


@pytest.mark.parametrize(
    ('naive', 'offset'),
    [
        (datetime(2026, 1, 15, 9, 0, tzinfo=NY).replace(tzinfo=None), -5),
        (datetime(2026, 7, 15, 9, 0, tzinfo=NY).replace(tzinfo=None), -4),
    ],
    ids=['winter', 'summer'],
)
def test_naive_value_gets_the_offset_of_its_own_date(ny: None, naive: datetime, offset: int) -> None:
    """naive 值当作应用时区的墙上时间，偏移按它自己那天算"""
    assert bind(naive).utcoffset() == timedelta(hours=offset)


def test_spring_forward_instants_round_trip(ny: None) -> None:
    """春季拨快前后各一分钟（01:59 EST → 03:00 EDT），时刻都不变"""
    before = datetime(2026, 3, 8, 6, 59, tzinfo=UTC)
    after = datetime(2026, 3, 8, 7, 0, tzinfo=UTC)
    assert bind(before) == before
    assert bind(after) == after
    # ⚠️ 不能直接 `bind(after) - bind(before)`：同一个 ZoneInfo 的两个值相减，Python 按**墙上时间**减、
    # 不看偏移，跨夏令时会算出 61 分钟（实测）。算时长先转 UTC
    assert bind(after).astimezone(UTC) - bind(before).astimezone(UTC) == timedelta(minutes=1)


@pytest.mark.xfail(
    strict=True,
    reason='MySQL 的 DATETIME 不存偏移：秋季回拨那一小时读回来一律当第一次（fold=0），第二次会早一小时',
)
def test_mysql_fall_back_second_occurrence_round_trip(ny: None) -> None:
    second = datetime(2026, 11, 1, 6, 30, tzinfo=UTC)  # 01:30 EST，回拨后第二次的 01:30
    wall = bind(second).replace(tzinfo=None)  # MySQL 存的就是这个墙上时间
    back = TimeZone().process_result_value(wall, None)
    assert back == second

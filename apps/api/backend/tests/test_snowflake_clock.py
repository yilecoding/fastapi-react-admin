"""发号器用系统时钟，不受测试里假时钟（`timezone.now`）的影响。

🔴 原来取的是 `timezone.now()`：`test_scheduler_timing.py` 把它换成假时钟模拟几小时的流逝，
期间改调度要写审计行、要发 ID，发号器就记住一个「未来」的时间戳；
假时钟一撤，之后所有生成 ID 的地方都报「时钟回拨」。
#281 登记了定时任务表之后，整套 pytest 在那个文件之后连环红了几百条（每条都和定时任务毫无关系）。
"""

from datetime import timedelta

import pytest

from backend.utils.snowflake import Snowflake
from backend.utils.timezone import timezone


def test_a_fake_clock_does_not_poison_the_generator(monkeypatch: pytest.MonkeyPatch) -> None:
    gen = Snowflake()
    gen.datacenter_id, gen.worker_id, gen._initialized = 0, 0, True

    real_now = timezone.now
    monkeypatch.setattr(timezone, 'now', lambda: real_now() + timedelta(hours=12))
    in_the_fake_future = gen.generate()
    monkeypatch.setattr(timezone, 'now', real_now)

    after = gen.generate()  # 原来这里报「时钟回拨超过 43200000 ms」
    assert after > in_the_fake_future

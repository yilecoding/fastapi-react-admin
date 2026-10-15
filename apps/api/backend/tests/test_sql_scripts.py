"""每份 SQL 脚本都要过得了 `utils/sql_parser.py` 的白名单。

🔴 **这道白名单只在真正执行脚本时才跑**（`reset_test_db` / `fba init` / 装插件），
而本地 pytest 连的是一个早就建好的 `fba_test`，从来不走那条路。

实测踩过：AI 插件的 `init_snowflake.sql` 开头写了一段 `--` 注释块，
sqlparse 把注释和后面的 INSERT 切成同一条语句，于是它以 `--` 开头、判为非法。
本地全绿，CI 三个建库的 job（pytest × 2 + E2E）一起红在「重建失败」，
报的还是一句不点名原因的「存在非法操作」。
"""

from pathlib import Path

import anyio
import pytest

from backend.core.path_conf import BASE_PATH
from backend.utils.sql_parser import parse_sql_script

_SCRIPTS = sorted(p for pattern in ('sql/*/*.sql', 'plugin/*/sql/*/*.sql') for p in BASE_PATH.glob(pattern))


def test_scripts_are_found() -> None:
    # 先断言「有」：glob 写错时下面的参数化会是空的，pytest 照样绿
    assert len(_SCRIPTS) >= 20, _SCRIPTS


@pytest.mark.parametrize('path', _SCRIPTS, ids=lambda p: str(p.relative_to(BASE_PATH)))
def test_script_passes_whitelist(path: Path) -> None:
    is_destroy = path.name.startswith('destroy')
    statements = anyio.run(lambda: parse_sql_script(str(path), is_destroy=is_destroy))
    assert statements, f'{path} 解析出 0 条语句'

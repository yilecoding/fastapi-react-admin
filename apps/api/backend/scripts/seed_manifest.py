"""种子文件指纹清单：把「改了种子」变成一件机器看得见的事（issue #86）。

## 它守什么

种子 SQL 只在 `fba init`（从零建库）那条路径上跑一次。改了种子文件之后，
**新建的库会有那些行、已经在跑的库永远不会有** —— 而这件事此前没有任何东西会发现：
CI 全绿、合并、部署，然后生产库静静地缺着几行数据。`5c1d594` 和 `256beae` 都是这么漏的。

真正的修法是给那批新增行补一条幂等的 data migration（见
`backend/utils/data_migration.py`）。但「记得补」这件事本身需要有人提醒 ——
这份清单就是那个提醒：种子文件的 sha256 变了而清单没更新，测试就红。

## 它**不**守什么

它证明不了「那条 data migration 真的插了同样的行」，只能强迫作者**看一眼**并做决定。
和 `test_every_crud_class_declares_its_data_scope_stance` 是同一个物种：
「忘了想这件事」会红，而不是「想错了」会红。

## 用法

```bash
pnpm --filter api seed:manifest          # 校验（CI 与 pytest 走这条）
pnpm --filter api seed:manifest --write  # 确认过之后更新清单
```
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys

from pathlib import Path

BASE_PATH = Path(__file__).resolve().parents[1]
MANIFEST_PATH = BASE_PATH / 'sql' / 'seed_manifest.json'

#: 被纳管的种子文件。两类都要 —— 插件的 `sql/` 和基础 `sql/` 是同一个机制、
#: 同一个漏法（`#81` 的消息中心菜单就是从插件那份漏掉的）。
_PATTERNS = (
    ('sql', 'init_*.sql'),
    ('plugin', 'sql/**/init_*.sql'),
)


def seed_files() -> list[Path]:
    """所有纳管的种子文件，按仓库相对路径排序"""
    found: set[Path] = set()
    for subdir, pattern in _PATTERNS:
        found.update(p for p in (BASE_PATH / subdir).glob(f'**/{pattern}') if p.is_file())
    # destroy 脚本不算种子：它只在卸载插件时跑，不存在「已存在的库要追上」的问题
    return sorted(p for p in found if 'destroy' not in p.name)


def fingerprints() -> dict[str, str]:
    return {p.relative_to(BASE_PATH).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in seed_files()}


def load_manifest() -> dict[str, str]:
    if not MANIFEST_PATH.exists():
        return {}
    return json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))


def write_manifest() -> None:
    MANIFEST_PATH.write_text(
        json.dumps(fingerprints(), ensure_ascii=False, indent=2, sort_keys=True) + '\n',
        encoding='utf-8',
    )


def diff() -> tuple[list[str], list[str], list[str]]:
    """返回 (改了的, 新增的, 删掉的)"""
    actual, expected = fingerprints(), load_manifest()
    changed = sorted(k for k in actual.keys() & expected.keys() if actual[k] != expected[k])
    added = sorted(actual.keys() - expected.keys())
    removed = sorted(expected.keys() - actual.keys())
    return changed, added, removed


HINT = """
🔴 种子文件改了，但清单没更新 —— 这意味着**已经在跑的库（尤其是生产）不会有这些行**。
种子 SQL 只在 `fba init` 从零建库时执行一次，之后再也不会重跑。

两条路选一条：

  1) 这次改动**新增/修改了数据行** → 补一条幂等的 data migration，让已存在的库也追上。
     照 `backend/alembic/versions/*33ffb491b69f*.py` 的形状写，helper 在
     `backend/utils/data_migration.py`（外键按业务键解析，别硬编码 ID）。
  2) 这次改动**对已存在的库无影响**（只改注释、只改新库才用到的行、只是重排格式）
     → 不用补迁移。

然后跑 `pnpm --filter api seed:manifest --write` 更新清单。
"""


def check() -> list[str]:
    """返回问题描述列表，空列表 = 通过"""
    changed, added, removed = diff()
    problems = []
    if changed:
        problems.append(f'内容变了：{changed}')
    if added:
        problems.append(f'新增的种子文件（清单里没有）：{added}')
    if removed:
        problems.append(f'清单里有但文件已不存在：{removed}')
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='更新清单（确认过之后再用）')
    args = parser.parse_args()

    if args.write:
        write_manifest()
        print(f'已更新 {MANIFEST_PATH.relative_to(BASE_PATH.parent)}（{len(fingerprints())} 个种子文件）')
        return 0

    problems = check()
    if not problems:
        print(f'种子清单一致（{len(fingerprints())} 个文件）')
        return 0
    print('\n'.join(problems) + HINT, file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())

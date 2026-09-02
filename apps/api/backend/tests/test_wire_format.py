"""线上格式的守卫：**下发的 ID 一律是字符串，下发的时间一律带时区标记。**

两条纪律共用一次端点遍历（从 OpenAPI 枚举所有无参 GET，44 个）——
拆成两个文件就要把那 44 个请求打两遍。

## 一、ID 一律是字符串（硬纪律 6）

雪花 ID 约 2^61，超出 JS 的 `Number.MAX_SAFE_INTEGER`（2^53-1）。
浏览器 `JSON.parse` 会**静默丢精度**：

    2049629108245233664 → 2049629108245233700
    2049629108245233665 → 2049629108245233700   ← 不同 ID 塌缩成同一个值

后果不只是列表撞 key —— 把 ID 回传做更新/删除会命中**错误的记录**。
后端在 `utils/serializers.py: stringify_unsafe_ints` 里统一在编码层转成字符串。

⚠️ **这一层此前只被两条测试顺带罩着。** 实测：把 `stringify_unsafe_ints`
改成直接 `return obj`（大整数原样下发），全套 261 条里只有 `test_file.py` 的
2 条红 —— 而它们红是因为恰好把 id 当字符串比，不是在测这件事。那两条断言
一改，整层保护就没人看着了。所以这里按**全部无参 GET 端点**扫一遍。

⚠️ 同一个突变下这条守卫只报出**一处**违规（`/sys/files` 的 `created_by`）——
不是漏了，是因为 `common/schema.py` 的 `field_serializer` 已经在 Pydantic 层
把 `id` 和一批外键转成字符串了，编码层兜的是**剩下那些**（`created_by`
这类没进 schema 的字段）。两层是叠着的，所以别指望这条守卫对
`stringify_unsafe_ints` 整层都敏感 —— 它测的是**线上格式**，不管哪一层给的。

## 二、时间一律带时区标记

没有标记的串浏览器只能**猜**，后果是所有时间整体偏移几小时且不报错。
这条现在只靠 pydantic v2 的默认行为成立，注释拦不住代码 —— 详见下面那条测试。
"""

import re

from typing import Any

import pytest

from starlette.testclient import TestClient

# JS 能精确表示的最大整数
JS_MAX_SAFE_INTEGER = 2**53 - 1

# ⚠️ 限流接口不能扫（硬纪律 10）：`/auth/captcha` 是 5 次/30 秒，
# 在这里打一发会挤掉别的测试的配额。它的响应里也没有 ID 和时间。
SKIP = ('/auth/captcha',)

# 像 ISO 8601 的时间串（`T` 或空格分隔都算）
_DATETIME_LIKE = re.compile(r'^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}')
# 结尾的时区标记：`Z` 或 `+08:00` / `+0800`
_TIMEZONE_MARKER = re.compile(r'(Z|[+-]\d{2}:?\d{2})$')


def _walk_ints(node: Any, trail: str = '$') -> tuple[list[str], int]:
    """递归找出「超范围的裸整数」，并数出「像雪花 ID 的字符串」有多少个

    :param node: JSON 节点
    :param trail: 当前节点的 JSON 路径（报错时要指出是哪个字段）
    :return: (违规位置列表, 雪花 ID 字符串的个数)
    """
    bad: list[str] = []
    snowflakes = 0

    if isinstance(node, bool):
        # bool 是 int 的子类，必须先摘出去
        return bad, snowflakes
    if isinstance(node, int):
        if node > JS_MAX_SAFE_INTEGER:
            bad.append(f'{trail} = {node}')
        return bad, snowflakes
    if isinstance(node, str):
        if node.isdigit() and int(node) > JS_MAX_SAFE_INTEGER:
            snowflakes += 1
        return bad, snowflakes
    if isinstance(node, dict):
        for key, value in node.items():
            sub_bad, sub_snow = _walk_ints(value, f'{trail}.{key}')
            bad.extend(sub_bad)
            snowflakes += sub_snow
        return bad, snowflakes
    if isinstance(node, list):
        for index, value in enumerate(node):
            sub_bad, sub_snow = _walk_ints(value, f'{trail}[{index}]')
            bad.extend(sub_bad)
            snowflakes += sub_snow
        return bad, snowflakes

    return bad, snowflakes


def _walk_datetimes(node: Any, trail: str = '$') -> tuple[list[str], int]:
    """递归找出「没带时区标记的时间串」

    :param node: JSON 节点
    :param trail: 当前节点的 JSON 路径
    :return: (违规位置列表, 扫到的时间串总数)
    """
    bad: list[str] = []
    seen = 0

    if isinstance(node, str):
        if _DATETIME_LIKE.match(node):
            seen += 1
            if not _TIMEZONE_MARKER.search(node):
                bad.append(f'{trail} = {node}')
        return bad, seen
    if isinstance(node, dict):
        for key, value in node.items():
            sub_bad, sub_seen = _walk_datetimes(value, f'{trail}.{key}')
            bad.extend(sub_bad)
            seen += sub_seen
        return bad, seen
    if isinstance(node, list):
        for index, value in enumerate(node):
            sub_bad, sub_seen = _walk_datetimes(value, f'{trail}[{index}]')
            bad.extend(sub_bad)
            seen += sub_seen
        return bad, seen

    return bad, seen


@pytest.fixture(scope='module')
def responses(client: TestClient, token_headers: dict[str, str]) -> dict[str, Any]:
    """把所有无参 GET 端点各打一次，返回 `{相对路径: 解析后的 JSON}`。

    端点从 OpenAPI **枚举**出来，不是手写清单 —— 新加一个只读接口自动罩上。
    module 作用域：下面两条测试共用这一次遍历。
    """
    from backend.core.conf import settings
    from backend.main import app

    prefix = settings.FASTAPI_API_V1_PATH
    out: dict[str, Any] = {}
    for path in sorted(p for p, ops in app.openapi()['paths'].items() if 'get' in ops and '{' not in p):
        rel = path.removeprefix(prefix)
        if rel in SKIP:
            continue
        resp = client.get(rel, headers=token_headers)
        if 'application/json' in resp.headers.get('content-type', ''):
            out[rel] = resp.json()
    return out


def test_no_response_carries_a_js_unsafe_integer(responses: dict[str, Any]) -> None:
    """所有无参 GET 端点的响应里都不能出现超出 JS 安全范围的裸整数。"""
    offenders: list[str] = []
    snowflakes = 0
    for rel, body in responses.items():
        bad, snow = _walk_ints(body)
        offenders.extend(f'{rel} → {b}' for b in bad)
        snowflakes += snow

    # 🔴 断言「没有」之前先断言「有」：库是空的、或者枚举挑不出端点时，
    # 上面那个循环啥也没扫，`offenders` 自然是空的 —— 这条测试会假绿。
    assert len(responses) >= 30, f'只扫到 {len(responses)} 个端点，枚举可能失效了，这条守卫已经罩不住了'
    assert snowflakes >= 20, (
        f'响应里只找到 {snowflakes} 个雪花 ID 字符串 —— 数据太少，'
        '这条测试证明不了「转成字符串了」，只能证明「没有大整数」'
    )
    assert not offenders, '这些字段下发的是裸大整数，浏览器 JSON.parse 会静默丢精度（硬纪律 6）：\n  ' + '\n  '.join(
        offenders
    )


def test_every_datetime_carries_a_timezone_marker(responses: dict[str, Any]) -> None:
    """🔴 下发的时间必须带时区标记（`Z` 或 `±HH:MM`）。

    没有标记的串，浏览器只能**猜**：ES 规范对 `T` 分隔的按本地时区解释，
    空格分隔的干脆没定义（Safari 历史上直接 `Invalid Date`）。后果是服务端和
    用户不在同一个时区时，界面上所有时间整体偏移几小时，**而且不报错**。
    前端为此长出过两处 hack（`log-online/api.ts` 自己写解析器、
    `profile/recent-logins.tsx` 干脆放弃解析原样摊字符串），完整记录在
    `apps/api/AGENTS.md` 的时区一节。

    ⚠️ 这条现在**只靠 pydantic v2 的默认行为**成立（aware datetime → 带偏移的
    ISO 8601）。`common/schema.py` 里那段长注释就是在拦「不要再加自定义
    `json_encoders`」—— 但注释拦不住代码：加一个把时间格式化成
    `'%Y-%m-%d %H:%M:%S'` 的序列化器，全套测试**一条都不会红**（实测，
    所以有了这条）。

    实测基线：44 个端点的响应里有 **568 处**时间字符串，全部带标记。
    """
    offenders: list[str] = []
    seen = 0
    for rel, body in responses.items():
        bad, count = _walk_datetimes(body)
        offenders.extend(f'{rel} → {b}' for b in bad)
        seen += count

    # 同样先断言「有」—— 一处时间都没扫到的话这条测试什么也没证明
    assert seen >= 100, f'响应里只找到 {seen} 处时间字符串，数据太少，这条守卫证明不了什么'
    assert not offenders, '这些时间没带时区标记，浏览器只能靠猜（见 apps/api/AGENTS.md 时区一节）：\n  ' + '\n  '.join(
        offenders
    )

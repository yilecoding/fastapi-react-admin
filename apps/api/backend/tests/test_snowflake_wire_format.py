"""硬纪律 6 的守卫：下发的 ID 一律是字符串。

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
"""

from typing import Any

from starlette.testclient import TestClient

# JS 能精确表示的最大整数
JS_MAX_SAFE_INTEGER = 2**53 - 1

# ⚠️ 限流接口不能扫（硬纪律 10）：`/auth/captcha` 是 5 次/30 秒，
# 在这里打一发会挤掉别的测试的配额。它的响应里也没有 ID。
SKIP = ('/auth/captcha',)


def _walk(node: Any, trail: str = '$') -> tuple[list[str], int]:
    """递归找出「超范围的裸整数」和「像雪花 ID 的字符串」

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
            sub_bad, sub_snow = _walk(value, f'{trail}.{key}')
            bad.extend(sub_bad)
            snowflakes += sub_snow
        return bad, snowflakes
    if isinstance(node, list):
        for index, value in enumerate(node):
            sub_bad, sub_snow = _walk(value, f'{trail}[{index}]')
            bad.extend(sub_bad)
            snowflakes += sub_snow
        return bad, snowflakes

    return bad, snowflakes


def test_no_response_carries_a_js_unsafe_integer(client: TestClient, token_headers: dict[str, str]) -> None:
    """所有无参 GET 端点的响应里都不能出现超出 JS 安全范围的裸整数。

    端点从 OpenAPI **枚举**出来，不是手写清单 —— 新加一个只读接口自动罩上。
    """
    from backend.core.conf import settings
    from backend.main import app

    prefix = settings.FASTAPI_API_V1_PATH
    paths = sorted(p for p, ops in app.openapi()['paths'].items() if 'get' in ops and '{' not in p)

    offenders: list[str] = []
    snowflakes = 0
    scanned = 0
    for path in paths:
        rel = path.removeprefix(prefix)
        if rel in SKIP:
            continue
        resp = client.get(rel, headers=token_headers)
        if 'application/json' not in resp.headers.get('content-type', ''):
            continue
        scanned += 1
        bad, snow = _walk(resp.json())
        offenders.extend(f'{rel} → {b}' for b in bad)
        snowflakes += snow

    # 🔴 断言「没有」之前先断言「有」：库是空的、或者枚举挑不出端点时，
    # 上面那个循环啥也没扫，`offenders` 自然是空的 —— 这条测试会假绿。
    assert scanned >= 30, f'只扫到 {scanned} 个端点，枚举可能失效了，这条守卫已经罩不住了'
    assert snowflakes >= 20, (
        f'响应里只找到 {snowflakes} 个雪花 ID 字符串 —— 数据太少，'
        '这条测试证明不了「转成字符串了」，只能证明「没有大整数」'
    )
    assert not offenders, '这些字段下发的是裸大整数，浏览器 JSON.parse 会静默丢精度（硬纪律 6）：\n  ' + '\n  '.join(
        offenders
    )

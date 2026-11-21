"""菜单 `perms` 的切分（#402）

单独一个模块、不 import 任何业务代码：`schema/menu.py` 要在写入时用它规范化，
而 `rbac.py` 经 `jwt.py` 会反过来 import 用户 schema，放在那里就是循环导入。
"""


def split_perms(perms: str | None) -> list[str]:
    """把菜单的 `perms`（逗号分隔）切成权限码列表：去空格、去空段

    🔴 **所有读 `perms` 的地方一律走这里**（#402）。原来 `rbac_verify` / `get_codes` 切完不 strip、
    `collect_allowed_perms` 会 strip：存成 `"a, b"` 时 HTTP 和前端 `can()` 认不出 `b`（403、按钮隐藏），
    AI 工具和后台导出却认得出 —— 同一个人在两条路上结论不同。写入侧另由 `schema/menu.py` 规范化，
    这里兜住老数据和绕过 schema 写进去的行
    """
    if not perms:
        return []
    return [p.strip() for p in perms.split(',') if p.strip()]

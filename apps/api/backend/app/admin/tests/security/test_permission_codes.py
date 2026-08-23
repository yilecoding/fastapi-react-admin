"""权限码三方对账 —— 后端守卫 · 前端门控 · 种子菜单。

同一个权限码字符串同时写在三个地方，靠人工对齐：

| 清单 | 写在哪 |
|---|---|
| 后端守卫 | `Depends(RequestPermission('sys:dept:add'))` |
| 前端门控 | `<Can perm="sys:dept:add">` |
| 种子菜单 | `sys_menu.perms`（`backend/sql/**` 与各插件的 `sql/**`） |

**三种漂移方向的失败形态全都不报错：**

- 后端有码、种子菜单里没有 → 非超管**永远** 403。界面上的表现是
  「按钮点了没反应」，没人会当成权限问题去查
- 前端有码、后端没挂守卫 → 任何登录用户直接打接口就能越权
  （`apps/api/AGENTS.md` 记的 `POST /sys/files/relations` 就是这条，已修）
- 前端给一个后端实际走 `DependsSuperUser` 的接口编个权限码 → 假门禁：
  按钮显示了、点下去 403。`packages/platform/src/auth/can.tsx` 的注释专门警告过

写这条测试时三边是一致的 —— **正因为一致才要现在锁住**。今天对齐纯属人工维护
到位，明天加个接口漏挂菜单就没人知道了。

⚠️ 扫描必须剔掉注释和 docstring：`can.tsx` 的用法示例里写着
`<Can perm="sys:user:add">`，而 `sys:user:add` 并不存在（用户新增走
`DependsSuperUser`，没有权限码）。不剔的话这条测试第一次跑就是假红。
Python 侧用 AST 天然规避；TS 侧显式剥掉 `/* */` 和 `//`。
"""

import ast
import re

from backend.core.path_conf import BASE_PATH

REPO_ROOT = BASE_PATH.parent.parent.parent
FRONTEND_DIRS = (REPO_ROOT / 'packages', REPO_ROOT / 'apps' / 'web' / 'src')

_PERM_RE = re.compile(r'^[a-z0-9_]+(?::[a-z0-9_]+)+$')


def _backend_codes() -> set[str]:
    """AST 扫 `RequestPermission('...')` 的字面量实参（天然不含注释 / docstring）"""
    codes: set[str] = set()
    for path in BASE_PATH.rglob('*.py'):
        if 'tests' in path.parts or '__pycache__' in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding='utf-8'))
        except SyntaxError:  # pragma: no cover - 仓库里不该有，有也不该让这条测试挂
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, 'attr', None)
            if name != 'RequestPermission':
                continue
            for arg in node.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    codes.add(arg.value)
    return codes


def _strip_ts_comments(text: str) -> str:
    """剥掉 /* */ 与 // 注释 —— 用法示例里的权限码不算数"""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return re.sub(r'^\s*//.*$', '', text, flags=re.MULTILINE)


def _frontend_codes() -> set[str]:
    """扫 JSX 的 `perm="..."` / `perm={"..."}`"""
    codes: set[str] = set()
    for base in FRONTEND_DIRS:
        for path in [*base.rglob('*.tsx'), *base.rglob('*.ts')]:
            if 'node_modules' in path.parts or 'dist' in path.parts:
                continue
            body = _strip_ts_comments(path.read_text(encoding='utf-8', errors='ignore'))
            for code in re.findall(r'perm=\{?["\']([^"\']+)["\']', body):
                if _PERM_RE.match(code):
                    codes.add(code)
    return codes


def _seed_codes() -> set[str]:
    """种子 SQL 里出现过的权限码形状的字符串

    刻意宽松：这里只用来做「后端的码是不是都在种子里」的**上界**判断，
    多收几个图标名（`mdi:login`）不影响结论。
    """
    codes: set[str] = set()
    sql_files = [
        *(BASE_PATH / 'sql').rglob('*.sql'),
        *(BASE_PATH / 'plugin').rglob('sql/**/*.sql'),
    ]
    for path in sql_files:
        if 'destroy' in path.name:
            continue
        body = path.read_text(encoding='utf-8', errors='ignore')
        # ⚠️ 不要用 `'([^']+)'` 去配对引号：SQL 用 `''` 转义单引号，遇到一个转义
        # 之后所有配对整体错位，后面的字符串全部取成「两个字符串之间的内容」——
        # 表现是一个命中都没有，而不是报错。直接匹配权限码的形状最稳。
        codes.update(re.findall(r"'([a-z0-9_]+(?::[a-z0-9_]+)+)'", body))
    return codes


def test_every_backend_perm_code_exists_in_seed_menu() -> None:
    """后端守卫的每个权限码，种子菜单里都要有一条菜单带着它

    漏了的表现：非超管永远 403，而界面上只是「按钮点了没反应」。
    """
    missing = sorted(_backend_codes() - _seed_codes())
    assert not missing, (
        f'这些权限码后端挂了守卫，但没有任何种子菜单声明它们：{missing}\n'
        '后果：非超管永远拿 403，界面表现为「按钮点了没反应」。\n'
        '修法：在 backend/sql/**（或插件的 sql/**）里给对应菜单补上 perms。'
    )


def test_every_frontend_perm_code_has_a_backend_guard() -> None:
    """前端 `<Can perm>` 用到的码，后端必须真的挂了守卫

    否则是假门禁：要么按钮藏了但接口裸奔（越权），要么按钮显示了但接口走的是
    `DependsSuperUser`（点了就 403）。
    """
    orphans = sorted(_frontend_codes() - _backend_codes())
    assert not orphans, (
        f'前端用 <Can perm> 门控了这些码，但后端没有对应的 RequestPermission：{orphans}\n'
        '两种可能都很糟：接口其实没有守卫（越权），'
        '或接口走的是 DependsSuperUser（假门禁，按钮显示了点下去 403）。'
    )


def test_every_frontend_perm_code_exists_in_seed_menu() -> None:
    """前端的码也要在种子菜单里，否则那个按钮对谁都不显示"""
    missing = sorted(_frontend_codes() - _seed_codes())
    assert not missing, f'前端门控用了种子菜单里不存在的权限码，按钮对任何非超管都不会显示：{missing}'


def test_scanners_actually_find_something() -> None:
    """守卫的守卫

    上面三条都是「差集为空」，而扫不到任何东西时差集**天然为空** ——
    正则写错、目录挪走、路径算错，全都表现为静默通过。
    这条把「扫描器还活着」也钉住。
    """
    backend, frontend, seed = _backend_codes(), _frontend_codes(), _seed_codes()
    assert len(backend) >= 40, f'后端权限码只扫到 {len(backend)} 个，扫描器可能坏了'
    assert len(frontend) >= 30, f'前端权限码只扫到 {len(frontend)} 个，扫描器可能坏了'
    assert len(seed) >= 40, f'种子权限码只扫到 {len(seed)} 个，扫描器可能坏了'
    assert 'sys:dept:add' in backend & frontend & seed, '三边都该有 sys:dept:add，扫描器对不上'

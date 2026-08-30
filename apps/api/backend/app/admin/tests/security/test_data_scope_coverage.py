"""数据权限的**覆盖面**：哪些 DAO 过滤、哪些刻意不过滤。

补齐覆盖面的方式是接在 DAO 层（`common/security/data_scope.py: DataScopedCRUD`）
而不是逐个接口加 `Depends` —— 逐个加的话下一个新接口一定会漏，而漏了没有现象。

这份文件里**反向守卫比正向断言更重要**。正向的「该过滤的过滤了」错了，
表现是「少看见几行数据」，用户会来报；反向的「不该过滤的被过滤了」错了，
表现是白屏和「表单选项凭空消失」，没人会当成权限问题查：

| 豁免的 | 一起收紧会怎样 |
|---|---|
| `Menu` | 用户自己的侧边栏被滤空 → 登录后一片空白 |
| `DictType` / `DictData` / `Config` | 前端下拉依赖它们，选项凭空消失 |
| `DataRule` / `DataScope` | 自锁 —— 管理规则的界面被规则滤掉，改不回来 |
| `UserSocial` | 在**登录链路**上读，那时还没有「当前用户」 |
| `Notification` | 收件箱已经按 `current_user.id` 过滤了，再叠一层部门维度就变成「我和我下属的通知」 |
"""

import re

from pathlib import Path

from sqlalchemy_crud_plus import CRUDPlus

from backend.common.security.data_scope import DataScopedCRUD, bypass_data_scope, set_current_user
from backend.core.path_conf import BASE_PATH

#: 刻意豁免的 DAO 类名 → 理由。改动这份清单本身就该是一次有意识的决定
EXEMPT: dict[str, str] = {
    'CRUDMenu': '菜单是权限的定义不是数据，滤掉会让侧边栏空白',
    'CRUDDataRule': '规则表自身，过滤会自锁',
    'CRUDDataScope': '范围表自身，过滤会自锁',
    'CRUDDictType': '全局字典，前端下拉依赖',
    'CRUDDictData': '全局字典，前端下拉依赖',
    'CRUDConfig': '系统参数，且在启动 / 登录期读取',
    'CRUDUserPasswordHistory': '改密时内部读，不对外展示',
    'CRUDUserSocial': 'OAuth2 绑定在登录链路上读，那时没有当前用户',
    'CRUDNotification': '收件箱按 current_user.id 强制过滤，再叠部门维度会变成「我和我下属的通知」',
}


def _crud_classes() -> dict[str, tuple[Path, str]]:
    """扫出所有 DAO 类 → (文件, 基类名)"""
    found: dict[str, tuple[Path, str]] = {}
    for path in BASE_PATH.rglob('crud_*.py'):
        if '/tests/' in path.as_posix():
            continue
        body = path.read_text(encoding='utf-8')
        for cls, base in re.findall(r'^class (\w+)\((\w+)\[', body, flags=re.MULTILINE):
            found[cls] = (path, base)
    return found


def test_every_crud_class_uses_the_scoped_base() -> None:
    """没有 DAO 还在直接继承 `CRUDPlus`

    与 `test_data_permission.py` 里那条同名守卫互为备份：这一条从**类**的角度看，
    那一条从**文件文本**的角度看。任一条红都说明有人新写了 DAO 却没想过数据权限。
    """
    stragglers = {cls: str(p) for cls, (p, base) in _crud_classes().items() if base == 'CRUDPlus'}
    assert not stragglers, f'这些 DAO 还在直接继承 CRUDPlus，没有对数据权限表态：{stragglers}'


def test_exempt_list_matches_reality() -> None:
    """🔴 豁免清单和代码必须对得上，两个方向都要

    多了（清单里写着豁免、代码里其实在过滤）→ 清单在骗人；
    少了（代码里豁免、清单里没有）→ 有人悄悄关掉了某个 DAO 的数据权限。
    后者是这条守卫真正要挡的。
    """
    import backend.main  # ruff: ignore[unused-import] - 把全部 DAO 模块拉进来

    from backend.app.admin.crud.crud_data_rule import data_rule_dao  # ruff: ignore[unused-import] - 触发导入

    actual_exempt = set()
    actual_scoped = set()
    for sub in _all_subclasses(DataScopedCRUD):
        (actual_exempt if not sub.data_scope_enabled else actual_scoped).add(sub.__name__)

    assert actual_exempt == set(EXEMPT), (
        f'豁免清单和代码不一致。\n'
        f'  代码里豁免但清单没写：{sorted(actual_exempt - set(EXEMPT))}\n'
        f'  清单写了但代码在过滤：{sorted(set(EXEMPT) - actual_exempt)}'
    )
    assert actual_scoped, '一个受数据权限约束的 DAO 都没有，扫描大概率坏了'


def _all_subclasses(cls: type) -> set[type]:
    out = set()
    for sub in cls.__subclasses__():
        out.add(sub)
        out |= _all_subclasses(sub)
    return out


def test_no_current_user_means_no_filtering() -> None:
    """非请求上下文（Celery / CLI / 启动期）天然不过滤

    这是「不需要到处写 bypass」的前提：ContextVar 默认是 None，
    拿不到「谁在看」就不加任何条件。
    """
    from backend.app.admin.crud.crud_dept import dept_dao

    set_current_user(None)
    assert dept_dao._data_scope_condition() is None


def test_bypass_wins_over_a_present_user() -> None:
    """`bypass_data_scope()` 能压过已经设好的用户 —— 认证链路靠它防自锁"""
    from types import SimpleNamespace

    from backend.app.admin.crud.crud_dept import dept_dao

    scope = SimpleNamespace(status=1, rules=[])
    user = SimpleNamespace(
        is_superuser=False, id=1, dept_id=1, roles=[SimpleNamespace(status=1, is_filter_scopes=True, scopes=[scope])]
    )
    set_current_user(user)
    try:
        assert dept_dao._data_scope_condition() is not None
        with bypass_data_scope():
            assert dept_dao._data_scope_condition() is None
    finally:
        set_current_user(None)


def test_exempt_dao_never_filters_even_with_a_user() -> None:
    """🔴 反向守卫：豁免的 DAO 就算有当前用户也不过滤

    菜单被滤空 = 登录后白屏；字典被滤掉 = 表单选项凭空消失。
    两者都不会报错，也都不像权限问题。
    """
    from types import SimpleNamespace

    from backend.app.admin.crud.crud_menu import menu_dao
    from backend.plugin.config.crud.crud_config import config_dao
    from backend.plugin.dict.crud.crud_dict_data import dict_data_dao

    scope = SimpleNamespace(status=1, rules=[])
    user = SimpleNamespace(
        is_superuser=False, id=1, dept_id=1, roles=[SimpleNamespace(status=1, is_filter_scopes=True, scopes=[scope])]
    )
    set_current_user(user)
    try:
        for dao in (menu_dao, config_dao, dict_data_dao):
            assert dao._data_scope_condition() is None, f'{type(dao).__name__} 不该过滤'
    finally:
        set_current_user(None)


def test_exists_is_deliberately_not_scoped() -> None:
    """🔴 `exists` 刻意不覆盖，这条记录这个决定

    它被用来做唯一性校验（「这个部门编码是不是已经存在」）。按数据权限过滤之后，
    用户会因为「看不见」被判定为「不存在」，于是建出一条重复记录 ——
    要么撞唯一约束 500，要么真的重复。信息泄漏比这个后果轻得多。
    """
    assert 'exists' not in vars(DataScopedCRUD), 'exists 被覆盖了，会破坏唯一性校验，见上面的说明'
    assert CRUDPlus.exists is DataScopedCRUD.exists


def test_the_three_hooks_are_all_overridden() -> None:
    """🔴 三个钩子一个都不能少

    CRUDPlus 的读路径**不是**全都汇流到 `select()`（这是实测出来的）：
      - `select_model_by_column` / `select_models` → `self.select()`
      - `select_models_order` → `self.select_order()` → `self.select()`
      - `select_model`（按主键）/ `count` —— **各自建语句，不走 select()**
    漏掉 `select_model` 的后果就是这次要修的那个洞：列表里看不到、按 ID 拿得到。
    """
    for name in ('select', 'select_model', 'count'):
        assert name in vars(DataScopedCRUD), f'{name} 没有被覆盖'

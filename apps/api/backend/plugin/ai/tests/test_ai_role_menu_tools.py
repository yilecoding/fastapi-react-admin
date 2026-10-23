"""角色 / 菜单的写操作工具（#116）。

和部门那一组同一套约定（见 `test_ai_write_tools.py` 开头）：真实测试库（不提交，结束回滚）+ 真实 Redis，
不 mock service。每条都把改过的东西**读回来**断言 —— 只看预演文案和 `kind == 'ok'` 的测试，
对「卡片上说改了、库里没改 / 顺手改了别的」那类 bug 是绿的。

会静默出错的几处：

- **改名 / 启停顺手动了别的字段**（「过滤数据权限」、备注、菜单的上级）：现在靠 DAO 的 `exclude_unset`
  挡着，测试断言的是读回来的结果，不管将来靠什么机制
- **授予不带上级**：按钮的权限码生效了，页面却进不去（侧边栏挂不上孤儿）
- **收回不带下级**：权限码按菜单逐个算，只收「用户管理」、留着下面的按钮，`sys:user:del` 照样生效
- **停用一个没有权限码的菜单**：什么都不会变（侧边栏不看停用），要当场说清楚，而不是执行一个空操作
"""

import uuid

from typing import Any

import pytest

from sqlalchemy import select

from backend.app.admin.crud.crud_role import role_dao
from backend.app.admin.model import Menu, Role, User
from backend.plugin.ai.core.registry import _REGISTRY, load_builtin_tools
from backend.plugin.ai.tests.test_ai_write_tools import (  # ruff: ignore[unused-import] —— _patch_audit 是 autouse fixture
    _ctx,
    _dispatch,
    _patch_audit,
    _run,
    _user,
)

ADMIN_PERMS = ['sys:role:add', 'sys:role:edit', 'sys:role:menu:edit', 'sys:role:list', 'sys:menu:add', 'sys:menu:edit']


@pytest.fixture(autouse=True)
def _tools() -> None:
    load_builtin_tools()


def _admin() -> Any:
    return _user(perms=ADMIN_PERMS, superuser=True)


def _code() -> str:
    return f'AI_{uuid.uuid4().hex[:8].upper()}'


async def _new_role(ctx: Any, db: Any) -> Role:
    code = _code()
    created = await _dispatch(ctx, 'role_create', pre_approved=True, name=f'AI 角色{code}', code=code)
    assert created.kind == 'ok', created
    await db.flush()  # 会话是 autoflush=False；生产里由 confirm_tool 的 commit 落地
    return (await db.execute(select(Role).where(Role.code == code))).scalars().one()


async def _menu_by_perm(db: Any, perms: str) -> Menu:
    menu = (await db.execute(select(Menu).where(Menu.perms == perms, Menu.deleted == 0))).scalars().first()
    assert menu is not None, f'前置：测试库里要有带 {perms} 的菜单（种子数据）'
    return menu


async def _role_menu_ids(db: Any, role_id: int) -> set[int]:
    return {m.id for m in await role_dao.get_menus(db, role_id)}


class TestRoleWriteTools:
    def test_create_rename_and_disable_keep_untouched_fields(self, monkeypatch: pytest.MonkeyPatch) -> None:
        code = _code()

        async def scenario(db: Any) -> dict[str, Any]:
            ctx = _ctx(_admin(), db)
            args = {'name': f'AI 角色{code}', 'code': code}
            staged = await _dispatch(ctx, 'role_create', **args)
            not_yet = (await db.execute(select(Role).where(Role.code == code))).scalars().first()
            created = await _dispatch(ctx, 'role_create', pre_approved=True, **args)
            await db.flush()
            role = (await db.execute(select(Role).where(Role.code == code))).scalars().one()
            # 两个「默认值和现值不一样」的字段：改名 / 停用之后读回来还得是这两个值
            role.is_filter_scopes, role.remark = False, '原来的备注'
            zhangwei = (await db.execute(select(User).where(User.username == 'zhangwei'))).scalars().one()
            await role_dao.add_users(db, role.id, [zhangwei.id])
            await db.flush()

            renamed = await _dispatch(
                ctx, 'role_rename', pre_approved=True, role_id=str(role.id), new_name=f'改名{code}'
            )
            off_stage = await _dispatch(ctx, 'role_set_status', role_id=str(role.id), enabled=False)
            tasks_before = len(ctx.background_tasks.tasks)
            off = await _dispatch(ctx, 'role_set_status', pre_approved=True, role_id=str(role.id), enabled=False)
            await db.flush()
            await db.refresh(role)
            again = await _dispatch(ctx, 'role_set_status', role_id=str(role.id), enabled=False)
            return {
                'staged': staged, 'not_yet': not_yet, 'created': created, 'renamed': renamed,
                'off_stage': off_stage, 'off': off, 'again': again,
                'queued': len(ctx.background_tasks.tasks) - tasks_before,
                'name': role.name, 'status': role.status, 'filter': role.is_filter_scopes, 'remark': role.remark,
            }  # fmt: skip

        r = _run(monkeypatch, scenario)
        assert r['staged'].kind == 'confirm_required', r['staged']
        assert r['staged'].preview == f'将新建角色「AI 角色{code}」（编码 {code}），建好后还没有任何菜单权限'
        assert r['not_yet'] is None, '预演阶段就把角色建出来了'
        assert r['created'].kind == 'ok', r['created']
        assert r['renamed'].kind == 'ok', r['renamed']
        assert r['off_stage'].kind == 'confirm_required', r['off_stage']
        assert '将停用角色' in r['off_stage'].preview
        assert '你能看到的有 1 个' in r['off_stage'].preview, r['off_stage'].preview
        assert r['off'].kind == 'ok', r['off']
        assert r['queued'] >= 1, '停用角色之后没挂清用户缓存的任务 —— 拥有它的人要等 token 过期才失去权限'
        assert (r['name'], r['status']) == (f'改名{code}', 0)
        assert (r['filter'], r['remark']) == (False, '原来的备注'), '改名 / 停用把没改的字段打回了默认值'
        assert r['again'].kind == 'failed' and '不需要改' in r['again'].payload, r['again']

    def test_duplicate_name_fails_in_preview(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """重名在预演里就拦住，走的是 `role_service.check_create` 那一份规则"""

        async def scenario(db: Any) -> Any:
            existing = (await db.execute(select(Role).where(Role.deleted == 0).limit(1))).scalars().one()
            return await _dispatch(_ctx(_admin(), db), 'role_create', name=existing.name, code=_code())

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert outcome.confirm_token is None

    def test_role_outside_data_scope_cannot_be_touched(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """有 `sys:role:edit`、但数据范围里看不见这个角色 —— 预演和（伪造的）直接执行都当它不存在"""
        scoped = _user(perms=['sys:role:edit', 'sys:role:list'], fail_closed_scope=True)

        async def scenario(db: Any) -> tuple[Any, Any, tuple[str, str]]:
            role = (await db.execute(select(Role).where(Role.deleted == 0).limit(1))).scalars().one()
            before = role.name
            args = {'role_id': str(role.id), 'new_name': f'越权{_code()}'}
            stage = await _dispatch(_ctx(scoped, db), 'role_rename', **args)
            forced = await _dispatch(_ctx(scoped, db), 'role_rename', pre_approved=True, **args)
            await db.refresh(role)
            return stage, forced, (before, role.name)

        stage, forced, (before, after) = _run(monkeypatch, scenario)
        assert stage.kind == 'failed' and stage.confirm_token is None, stage
        assert forced.kind == 'failed', f'伪造 pre_approved 改到了范围外的角色：{forced}'
        assert after == before


class TestRoleMenus:
    """`role_update_menus`：增量授予 / 收回，授予连上级、收回连下级"""

    def test_grant_brings_ancestors_and_revoke_takes_descendants(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario(db: Any) -> dict[str, Any]:
            ctx = _ctx(_admin(), db)
            role = await _new_role(ctx, db)
            button = await _menu_by_perm(db, 'sys:user:del')
            page = await db.get(Menu, button.parent_id)
            folder = await db.get(Menu, page.parent_id)
            assert folder is not None, '前置：用户管理要挂在一个目录下'
            # 角色里要有人：清缓存是按「拥有这个角色的用户」挂任务的，没人就没有任务可挂，那条断言测不出东西
            zhangwei = (await db.execute(select(User).where(User.username == 'zhangwei'))).scalars().one()
            await role_dao.add_users(db, role.id, [zhangwei.id])
            await db.flush()

            grant = {'role_id': str(role.id), 'grant_menu_ids': [str(button.id)]}
            grant_stage = await _dispatch(ctx, 'role_update_menus', **grant)
            tasks_before = len(ctx.background_tasks.tasks)
            granted = await _dispatch(ctx, 'role_update_menus', pre_approved=True, **grant)
            await db.flush()
            after_grant = await _role_menu_ids(db, role.id)
            queued = len(ctx.background_tasks.tasks) - tasks_before

            revoke = {'role_id': str(role.id), 'revoke_menu_ids': [str(page.id)]}
            revoke_stage = await _dispatch(ctx, 'role_update_menus', **revoke)
            revoked = await _dispatch(ctx, 'role_update_menus', pre_approved=True, **revoke)
            await db.flush()
            return {
                'grant_stage': grant_stage, 'granted': granted, 'after_grant': after_grant, 'queued': queued,
                'revoke_stage': revoke_stage, 'revoked': revoked, 'after_revoke': await _role_menu_ids(db, role.id),
                'ids': (button.id, page.id, folder.id), 'page_title': page.title,
            }  # fmt: skip

        r = _run(monkeypatch, scenario)
        button, page, folder = r['ids']
        assert r['grant_stage'].kind == 'confirm_required', r['grant_stage']
        preview = r['grant_stage'].preview
        assert '新增 3 项' in preview and f'{r["page_title"]} › 删除（sys:user:del）' in preview, preview
        assert preview.count('（一并带上）') == 2, f'上级页面和目录要标成「一并带上」：{preview}'
        assert r['granted'].kind == 'ok', r['granted']
        assert r['after_grant'] == {button, page, folder}, '授予按钮没把它所在的页面和目录带上 —— 页面进不去'
        assert r['queued'] >= 1, '改了角色菜单却没挂清用户缓存的任务 —— 侧边栏和权限码要等 token 过期才变'

        assert r['revoke_stage'].kind == 'confirm_required', r['revoke_stage']
        assert '收回 2 项' in r['revoke_stage'].preview, r['revoke_stage'].preview
        assert r['revoked'].kind == 'ok', r['revoked']
        assert r['after_revoke'] == {folder}, '收回页面没连带收回它下面的按钮 —— 那个按钮的权限码照样生效'

    @pytest.mark.parametrize(
        ('case', 'expect'),
        [
            ('already-granted', '不会有任何变化'),
            ('grant-and-revoke-same', '既授予又收回'),
            ('grant-child-revoke-parent', '互相包含'),
            ('unknown-id', '不存在'),
            ('nothing', '都是空的'),
        ],
    )
    def test_bad_requests_fail_in_preview(self, monkeypatch: pytest.MonkeyPatch, case: str, expect: str) -> None:
        async def scenario(db: Any) -> Any:
            ctx = _ctx(_admin(), db)
            role = await _new_role(ctx, db)
            button = await _menu_by_perm(db, 'sys:user:del')
            rid, bid, pid = str(role.id), str(button.id), str(button.parent_id)
            if case == 'already-granted':
                done = await _dispatch(ctx, 'role_update_menus', pre_approved=True, role_id=rid, grant_menu_ids=[bid])
                assert done.kind == 'ok', done
                await db.flush()
                return await _dispatch(ctx, 'role_update_menus', role_id=rid, grant_menu_ids=[bid])
            args = {
                'grant-and-revoke-same': {'grant_menu_ids': [bid], 'revoke_menu_ids': [bid]},
                'grant-child-revoke-parent': {'grant_menu_ids': [bid], 'revoke_menu_ids': [pid]},
                'unknown-id': {'grant_menu_ids': ['1']},
                'nothing': {},
            }[case]
            return await _dispatch(ctx, 'role_update_menus', role_id=rid, **args)

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert outcome.confirm_token is None
        assert expect in outcome.payload, outcome.payload


class TestMenuWriteTools:
    def test_create_button_then_disable_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        perms = f'ai:test:{uuid.uuid4().hex[:6]}'

        async def scenario(db: Any) -> dict[str, Any]:
            ctx = _ctx(_admin(), db)
            page = await db.get(Menu, (await _menu_by_perm(db, 'sys:user:del')).parent_id)
            args = {'title': 'AI 导出', 'type': 'button', 'parent_id': str(page.id), 'perms': perms}
            staged = await _dispatch(ctx, 'menu_create', **args)
            created = await _dispatch(ctx, 'menu_create', pre_approved=True, **args)
            await db.flush()
            menu = (await db.execute(select(Menu).where(Menu.perms == perms))).scalars().one()
            off_stage = await _dispatch(ctx, 'menu_set_status', menu_id=str(menu.id), enabled=False)
            off = await _dispatch(ctx, 'menu_set_status', pre_approved=True, menu_id=str(menu.id), enabled=False)
            await db.flush()
            await db.refresh(menu)
            return {
                'staged': staged, 'created': created, 'off_stage': off_stage, 'off': off, 'page_title': page.title,
                'row': (menu.type, menu.name, menu.parent_id, menu.display, menu.title, menu.status),
                'page_id': page.id,
            }  # fmt: skip

        r = _run(monkeypatch, scenario)
        assert r['staged'].kind == 'confirm_required', r['staged']
        assert r['staged'].preview == (
            f'将在「{r["page_title"]}」下新建按钮「AI 导出」，权限标识 {perms}。新按钮不会自动授给任何角色'
        )
        assert r['created'].kind == 'ok', r['created']
        assert r['off_stage'].kind == 'confirm_required' and perms in r['off_stage'].preview, r['off_stage']
        assert r['off'].kind == 'ok', r['off']
        menu_type, name, parent_id, display, title, status = r['row']
        assert (menu_type, display) == (2, 0)
        tail = perms.rsplit(':', 1)[1]
        assert name == f'AiTest{tail[:1].upper()}{tail[1:]}', f'路由名要从权限码推出来：{name}'
        assert (parent_id, title, status) == (r['page_id'], 'AI 导出', 0), '停用把没改的字段（上级 / 标题）也动了'

    def test_disabling_a_menu_without_perms_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """侧边栏不看停用、目录又没有权限码：停用它什么都不会变 —— 当场说清楚，不执行一个看起来成功的空操作"""

        async def scenario(db: Any) -> Any:
            page = await db.get(Menu, (await _menu_by_perm(db, 'sys:user:del')).parent_id)
            folder = await db.get(Menu, page.parent_id)
            assert not folder.perms, '前置：目录本身不带权限码'
            return await _dispatch(_ctx(_admin(), db), 'menu_set_status', menu_id=str(folder.id), enabled=False)

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert '不会有任何效果' in outcome.payload and '是否显示' in outcome.payload, outcome.payload

    @pytest.mark.parametrize(
        ('args', 'expect'),
        [
            ({'type': 'menu', 'path': None, 'name': 'AiMenu'}, '请填写路由地址'),
            ({'type': 'menu', 'path': '/ai/x', 'name': 'AiX', 'title_dup': True}, '已存在'),
            ({'type': 'button', 'perms': None, 'name': 'AiBtn'}, '按钮必须填写权限标识'),
            ({'type': 'link', 'path': '/ai/oa'}, '外链 / 内嵌必须填写地址'),
            ({'type': 'menu', 'path': '/报表'}, '推不出路由名'),
            ({'type': 'embedded', 'path': '/ai/x'}, '菜单类型只能是'),
        ],
        ids=[
            'menu-without-path',
            'duplicate-title',
            'button-without-perms',
            'link-without-url',
            'chinese-path',
            'iframe',
        ],
    )
    def test_invalid_menus_fail_in_preview(self, monkeypatch: pytest.MonkeyPatch, args: dict, expect: str) -> None:
        async def scenario(db: Any) -> Any:
            fields = dict(args)
            title = f'AI 菜单{_code()}'
            if fields.pop('title_dup', False):
                title = (await db.get(Menu, (await _menu_by_perm(db, 'sys:user:del')).parent_id)).title
            return await _dispatch(_ctx(_admin(), db), 'menu_create', title=title, **fields)

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert outcome.confirm_token is None
        assert expect in outcome.payload, outcome.payload


def test_no_menu_rename_tool() -> None:
    """🔴 刻意不给「改菜单名」：界面上的菜单名先按路由地址查语言包，
    内置菜单改了库里的标题界面上不会变（见 menu_tools.py）"""
    load_builtin_tools()
    assert {'menu_create', 'menu_set_status'} <= _REGISTRY.keys()
    assert not any(name.startswith('menu_') and 'rename' in name for name in _REGISTRY)

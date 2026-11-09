"""数据变更审计（#260）的内置登记：用户 / 部门 / 角色 / 菜单 + 三张关联表 + 用户的二次验证。

🔴 **每一列都要归类**（`registry.register_audited` 当场校验）。给这几张表加列时，先想清楚它属于哪一类：
普通（记旧值 → 新值）· 引用（另存当时的名字）· 敏感（只记「改过」）· 忽略（时间戳、冗余列）。
字段的中文名同时要进 `packages/i18n` 的两个语言包和 `server-data-keys.json`（`test_data_change.py` 守着）。
"""

import json

from collections.abc import Mapping
from typing import Any

from backend.app.admin.model import Dept, Menu, Role, User, UserMfa
from backend.app.admin.model.m2m import role_data_scope, role_menu, user_role
from backend.common.data_change import ChildValue, Ref, register_audited, register_audited_child, register_audited_set

_STATUS = {0: '停用', 1: '正常'}
_YES_NO = {0: '否', 1: '是'}
#: 生命周期时间戳、逻辑删除时间：前者每次都变，后者由「删除」这个动作表达
_TIMESTAMPS = {'created_time', 'updated_time', 'deleted_time'}

register_audited(
    User,
    entity='user',
    title='用户',
    label='username',
    fields={
        'username': '用户名',
        'nickname': '昵称',
        'email': '邮箱',
        'phone': '手机号',
        'phone_verified_time': '手机号验证时间',
        'avatar': '头像',
        'timezone': '显示时区',
        'status': '状态',
        'is_superuser': '超级管理员',
        'is_staff': '后台管理登录',
    },
    refs={'dept_id': ('部门', Ref('sys_dept', 'name'))},
    enums={'status': _STATUS},
    secret={'password': '密码'},
    # salt 跟着密码一起变，记「密码改过」就够了；last_password_changed_time 同理；
    # last_login_time 每次登录都写，记它就是刷屏；uuid / join_time 建号后不变
    ignore={'uuid', 'salt', 'join_time', 'last_login_time', 'last_password_changed_time', *_TIMESTAMPS},
    soft_delete='deleted',
)
register_audited_set(
    user_role,
    entity='user',
    parent='user_id',
    member='role_id',
    field='roles',
    label='角色',
    ref=Ref('sys_role', 'name'),
)


def _recovery_batch(row: Mapping[str, Any]) -> frozenset[str]:
    """这一批恢复码是哪几个（哈希）。重新生成会换掉整批；登录时用掉一个只是标上「用过」，不算改"""
    try:
        items = json.loads(row['recovery_hashes'] or '[]')
    except ValueError:
        return frozenset()
    return frozenset(str(i.get('h')) for i in items if isinstance(i, dict))


# 二次验证（#181）：开了才有这一行。开启 / 自己关 / 管理员重置都记在**用户**名下 ——
# 「谁把他的二次验证关了」要在用户的变更记录里看得到。管理员重置和自己关的区别是操作人。
# 密钥密文、恢复码哈希一个字都不进审计表：恢复码只记「改过」
register_audited_child(
    UserMfa,
    entity='user',
    parent='user_id',
    field='mfa',
    label='二次验证',
    states=('未开启', '已开启'),
    values={'mfa_recovery_codes': ChildValue('恢复码', _recovery_batch, secret=True)},
    # 每次用动态码登录都写 last_step（防重放）
    ignore={'last_step', 'updated_time'},
)

register_audited(
    Dept,
    entity='dept',
    title='部门',
    label='name',
    fields={
        'code': '部门编码',
        'name': '部门名称',
        'sort': '排序',
        'phone': '联系电话',
        'email': '邮箱',
        'status': '状态',
    },
    refs={
        'parent_id': ('上级部门', Ref('sys_dept', 'name')),
        'leader_id': ('负责人', Ref('sys_user', 'username')),
    },
    enums={'status': _STATUS},
    ignore=_TIMESTAMPS,
    soft_delete='deleted',
)

register_audited(
    Role,
    entity='role',
    title='角色',
    label='name',
    fields={
        'code': '角色编码',
        'name': '角色名称',
        'status': '状态',
        'is_filter_scopes': '过滤数据权限',
        'remark': '备注',
    },
    enums={'status': _STATUS},
    ignore=_TIMESTAMPS,
    soft_delete='deleted',
)
register_audited_set(
    role_menu,
    entity='role',
    parent='role_id',
    member='menu_id',
    field='menus',
    label='菜单权限',
    ref=Ref('sys_menu', 'title'),
)
register_audited_set(
    role_data_scope,
    entity='role',
    parent='role_id',
    member='data_scope_id',
    field='data_scopes',
    label='数据范围',
    ref=Ref('sys_data_scope', 'name'),
)

register_audited(
    Menu,
    entity='menu',
    title='菜单',
    label='title',
    fields={
        'title': '菜单标题',
        'name': '菜单名称',
        'path': '路由地址',
        'sort': '排序',
        'icon': '图标',
        'type': '菜单类型',
        'perms': '权限标识',
        'status': '状态',
        'display': '是否显示',
        'link': '外链地址',
        'remark': '备注',
    },
    refs={'parent_id': ('上级菜单', Ref('sys_menu', 'title'))},
    enums={
        'type': {0: '目录', 1: '菜单', 2: '按钮', 3: '内嵌', 4: '外链'},
        'status': _STATUS,
        'display': _YES_NO,
    },
    ignore=_TIMESTAMPS,
    soft_delete='deleted',
)

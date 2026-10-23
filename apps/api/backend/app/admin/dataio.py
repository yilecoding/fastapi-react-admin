"""核心资源的导出定义：用户 · 部门 · 登录日志 · 操作日志。

每份定义的取数都调**列表接口用的那个 DAO 查询**（`get_select`），筛选参数和列表接口同名 ——
理由见 `common/dataio/exporting.py` 开头。插件的定义在各自的 `plugin/<名>/dataio.py`。
"""

import dataclasses

from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import datetime
from typing import Any

from pydantic import ConfigDict, Field, ValidationError
from sqlalchemy import Select, and_, select, true
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.app.admin.crud.crud_dept import dept_dao
from backend.app.admin.crud.crud_login_log import login_log_dao
from backend.app.admin.crud.crud_opera_log import opera_log_dao
from backend.app.admin.crud.crud_role import role_dao
from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import Dept, LoginLog, OperaLog, User
from backend.app.admin.schema.dept import CreateDeptParam, UpdateDeptParam
from backend.app.admin.service.dept_service import dept_service, leader_names
from backend.app.admin.service.import_service import pydantic_errors, required_error
from backend.app.admin.service.user_service import UserService
from backend.app.admin.utils.password_security import validate_password_strength
from backend.common.dataio.exporting import ExportColumn, ExportSpec, register_export
from backend.common.dataio.importing import (
    ENABLE_STATUS_ALIASES,
    CommitOutcome,
    ImportColumn,
    ImportContext,
    ImportRow,
    ImportSpec,
    register_import,
)
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.schema import ColumnLengthChecked, CustomEmailStr, CustomPhoneNumber, SchemaBase
from backend.common.security.data_scope import bypass_data_scope
from backend.common.security.permission import filter_data_permission_for_user
from backend.core.conf import settings
from backend.utils.serializers import select_columns_serialize, select_join_serialize

#: 状态类的取值 → 翻译键。表里存 0/1，导出要的是字
_ENABLE_STATUS = {0: 'export.value.disabled', 1: 'export.value.enabled'}
_RESULT_STATUS = {0: 'export.value.failed', 1: 'export.value.succeeded'}


class _Filters(SchemaBase):
    """筛选参数的共同基类。

    🔴 `extra='forbid'`：不认识的参数**报错**。忽略的话前端拼错一个参数名，那个条件就静默消失，
    导出的是全表而用户以为是筛过的那批（`export_service._parse_filters`）
    """

    model_config = ConfigDict(extra='forbid')


async def _columns_only(_db: AsyncSession, rows: Sequence[Any]) -> list[dict[str, Any]]:  # ruff: ignore[unused-async]
    """单表查询的行：`Row(Model,)` → 列字典（`shape` 的签名是异步的：用户那份要查库补角色）"""
    return [select_columns_serialize(row[0]) for row in rows]


def _location(row: dict[str, Any]) -> str | None:
    """同前端 `formatLocation`：内网 IP 后端存的是 `Reserved`，不摊出去"""
    parts = [row.get(key) for key in ('country', 'region', 'city')]
    parts = [part for part in parts if part and part != 'Reserved']
    return ' '.join(parts) if parts else None


# ─────────────────────────────── 用户 ───────────────────────────────


class UserExportFilters(_Filters):
    dept: int | None = Field(None, description='部门 ID')
    username: str | None = Field(None, description='用户名')
    phone: str | None = Field(None, description='手机号')
    status: int | None = Field(None, description='状态')
    role: int | None = Field(None, description='角色 ID')


async def _user_select(f: UserExportFilters, _user: Any) -> Select:
    return await user_dao.get_select(dept=f.dept, username=f.username, phone=f.phone, status=f.status, role=f.role)


async def _user_shape(db: AsyncSession, rows: Sequence[Any]) -> list[dict[str, Any]]:
    """和列表接口一样：先把 join 进来的部门拼进去，再按这一批的 ID 补角色（m2m 不进分页的 join）"""
    items = select_join_serialize(list(rows), relationships=['User-m2o-Dept'], return_as_dict=True)
    items = [items] if isinstance(items, dict) else list(items or [])
    await UserService.attach_roles(db=db, items=items)
    return items


def _dept_field(field: str) -> Callable[[Mapping[str, Any]], Any]:
    return lambda row: (row.get('dept') or {}).get(field)


def _role_field(field: str) -> Callable[[Mapping[str, Any]], Any]:
    return lambda row: [role.get(field) for role in row.get('roles') or []]


USER_EXPORT = register_export(
    ExportSpec(
        resource='sys.user',
        label='export.resource.user',
        perm='sys:user:export',
        columns=(
            ExportColumn('username', 'export.column.username', width=18),
            ExportColumn('nickname', 'export.column.nickname', width=16),
            ExportColumn('dept_name', 'export.column.dept_name', get=_dept_field('name'), width=18),
            # 编码列和导入模板的 `dept_code` / `role_codes` 同义：导出的表改完能原样导回去
            ExportColumn('dept_code', 'export.column.dept_code', get=_dept_field('code'), width=14),
            ExportColumn('role_names', 'export.column.role_names', kind='list', get=_role_field('name'), width=22),
            ExportColumn('role_codes', 'export.column.role_codes', kind='list', get=_role_field('code'), width=22),
            ExportColumn('email', 'export.column.email', width=26),
            ExportColumn('phone', 'export.column.phone', width=14),
            ExportColumn('status', 'export.column.status', kind='enum', choices=_ENABLE_STATUS, width=8),
            ExportColumn('is_superuser', 'export.column.is_superuser', kind='bool', width=10),
            ExportColumn('is_staff', 'export.column.is_staff', kind='bool', width=10),
            ExportColumn('join_time', 'export.column.join_time', kind='datetime', width=20),
            ExportColumn('last_login_time', 'export.column.last_login_time', kind='datetime', width=20),
            ExportColumn('id', 'export.column.user_id', kind='id', width=22),
        ),
        filters=UserExportFilters,
        filter_labels={
            'dept': 'export.filter.dept',
            'username': 'export.column.username',
            'phone': 'export.column.phone',
            'status': 'export.column.status',
            'role': 'export.filter.role',
        },
        select=_user_select,
        id_column=User.id,
        shape=_user_shape,
    )
)


# ─────────────────────────────── 部门 ───────────────────────────────


class DeptExportFilters(_Filters):
    name: str | None = Field(None, description='部门名称')
    code: str | None = Field(None, description='部门编码')
    phone: str | None = Field(None, description='联系电话')
    status: int | None = Field(None, description='状态')


async def _dept_select(f: DeptExportFilters, user: Any) -> Select:
    # 部门的数据范围在列表接口里是**显式入参**（`DataPermissionFilter(Dept)`），这里照样显式算一次。
    # DAO 自己也会按上下文再加一遍 —— 同一个条件 AND 两次，结果不变
    return await dept_dao.get_select(
        filter_data_permission_for_user(user, Dept), name=f.name, code=f.code, phone=f.phone, status=f.status
    )


async def _dept_shape(db: AsyncSession, rows: Sequence[Any]) -> list[dict[str, Any]]:
    items = [select_columns_serialize(row[0]) for row in rows]
    # 负责人昵称和部门树上显示的是同一份（`dept_service.leader_names`）
    leader_ids = {item['leader_id'] for item in items if item.get('leader_id')}
    names = await leader_names(db, leader_ids)
    usernames = await _usernames(db, leader_ids)
    for item in items:
        leader_id = item.get('leader_id')
        item['leader_name'] = names.get(str(leader_id)) if leader_id is not None else None
        item['leader_username'] = usernames.get(leader_id) if leader_id is not None else None
    return items


async def _usernames(db: AsyncSession, ids: set[int]) -> dict[int, str]:
    """负责人 ID → 用户名。导出带上它，是为了和部门导入的「负责人用户名」列对上（昵称会重名，用户名不会）"""
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.username).where(User.id.in_(ids), User.deleted == 0))
    return dict(rows.all())


def _dept_tree_order(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按树序排：上级在前、同级按排序号。顺带回填上级的编码和名称。

    🔴 上级只从**这次导出的结果里**找：上级在导出人的数据范围之外时留空 —— 和部门树上
    「看不见的上级不显示」一致，不在文件里把看不见的部门名摊出去
    """
    by_id = {row['id']: row for row in rows}
    children: dict[Any, list[dict[str, Any]]] = {}
    roots: list[dict[str, Any]] = []
    for row in rows:
        parent = by_id.get(row.get('parent_id'))
        row['parent_code'] = parent['code'] if parent else None
        row['parent_name'] = parent['name'] if parent else None
        (children.setdefault(parent['id'], []) if parent else roots).append(row)

    def key(row: dict[str, Any]) -> tuple[int, int]:
        return row.get('sort') or 0, int(row['id'])

    ordered: list[dict[str, Any]] = []
    stack = sorted(roots, key=key, reverse=True)
    seen: set[Any] = set()
    while stack:
        row = stack.pop()
        if row['id'] in seen:
            continue
        seen.add(row['id'])
        ordered.append(row)
        stack.extend(sorted(children.get(row['id'], []), key=key, reverse=True))
    # 成环的数据（理论上建不出来）排在最后，不丢行
    ordered.extend(row for row in rows if row['id'] not in seen)
    return ordered


DEPT_EXPORT = register_export(
    ExportSpec(
        resource='sys.dept',
        label='export.resource.dept',
        perm='sys:dept:export',
        columns=(
            ExportColumn('code', 'export.column.dept_code', width=14),
            ExportColumn('name', 'export.column.dept_name', width=20),
            # 和部门导入模板的 `parent_code` 同义：导出的表改完能原样导回去
            ExportColumn('parent_code', 'export.column.parent_code', width=14),
            ExportColumn('parent_name', 'export.column.parent_name', width=20),
            ExportColumn('leader_name', 'export.column.leader', width=14),
            ExportColumn('leader_username', 'export.column.leader_username', width=16),
            ExportColumn('phone', 'export.column.phone', width=14),
            ExportColumn('email', 'export.column.email', width=26),
            ExportColumn('sort', 'export.column.sort', kind='int', width=8),
            ExportColumn('status', 'export.column.status', kind='enum', choices=_ENABLE_STATUS, width=8),
            ExportColumn('created_time', 'export.column.created_time', kind='datetime', width=20),
            ExportColumn('id', 'export.column.dept_id', kind='id', width=22),
        ),
        filters=DeptExportFilters,
        filter_labels={
            'name': 'export.column.dept_name',
            'code': 'export.column.dept_code',
            'phone': 'export.column.phone',
            'status': 'export.column.status',
        },
        select=_dept_select,
        id_column=Dept.id,
        shape=_dept_shape,
        # 部门要整棵树排完再写；组织架构上万个部门已经很罕见了
        max_rows=20_000,
        reorder=_dept_tree_order,
    )
)


# ─────────────────────────────── 日志 ───────────────────────────────


class LogExportFilters(_Filters):
    """登录日志、操作日志的筛选参数一样（两个列表接口的查询参数一样）"""

    username: str | None = Field(None, description='用户名')
    status: int | None = Field(None, description='状态')
    ip: str | None = Field(None, description='IP 地址')
    start_time: datetime | None = Field(None, description='时间起（含）')
    end_time: datetime | None = Field(None, description='时间止（含）')


_LOG_FILTER_LABELS = {
    'username': 'export.column.username',
    'status': 'export.column.result',
    'ip': 'export.column.ip',
    'start_time': 'export.filter.start_time',
    'end_time': 'export.filter.end_time',
}


async def _login_log_select(f: LogExportFilters, _user: Any) -> Select:
    return await login_log_dao.get_select(
        username=f.username, status=f.status, ip=f.ip, start_time=f.start_time, end_time=f.end_time
    )


async def _opera_log_select(f: LogExportFilters, _user: Any) -> Select:
    return await opera_log_dao.get_select(
        username=f.username, status=f.status, ip=f.ip, start_time=f.start_time, end_time=f.end_time
    )


LOGIN_LOG_EXPORT = register_export(
    ExportSpec(
        resource='log.login',
        label='export.resource.login_log',
        perm='log:login:export',
        columns=(
            ExportColumn('login_time', 'export.column.login_time', kind='datetime', width=20),
            # 🔴 失败登录记的是**请求里填的**用户名 —— 没登录的人能往这一列里写任何东西（含 `=…`）。
            # 公式注入就是在这一列上实测的（见 common/dataio/AGENTS.md）
            ExportColumn('username', 'export.column.login_account', width=18),
            ExportColumn('status', 'export.column.result', kind='enum', choices=_RESULT_STATUS, width=8),
            ExportColumn('msg', 'export.column.message', width=28),
            ExportColumn('ip', 'export.column.ip', width=16),
            ExportColumn('location', 'export.column.location', get=_location, width=18),
            ExportColumn('browser', 'export.column.browser', width=14),
            ExportColumn('os', 'export.column.os', width=14),
            ExportColumn('device', 'export.column.device', width=12),
            ExportColumn('user_uuid', 'export.column.user_uuid', width=38),
        ),
        filters=LogExportFilters,
        filter_labels=_LOG_FILTER_LABELS,
        select=_login_log_select,
        id_column=LoginLog.id,
        shape=_columns_only,
    )
)

OPERA_LOG_EXPORT = register_export(
    ExportSpec(
        resource='log.opera',
        label='export.resource.opera_log',
        perm='log:opera:export',
        columns=(
            ExportColumn('opera_time', 'export.column.opera_time', kind='datetime', width=20),
            ExportColumn('username', 'export.column.operator', width=16),
            ExportColumn('title', 'export.column.opera_title', width=24),
            ExportColumn('method', 'export.column.method', width=8),
            ExportColumn('path', 'export.column.path', width=36),
            ExportColumn('status', 'export.column.result', kind='enum', choices=_RESULT_STATUS, width=8),
            ExportColumn('code', 'export.column.status_code', width=8),
            ExportColumn('msg', 'export.column.message', width=28),
            ExportColumn('ip', 'export.column.ip', width=16),
            ExportColumn('location', 'export.column.location', get=_location, width=18),
            ExportColumn('cost_time', 'export.column.cost_ms', kind='number', width=10),
            ExportColumn('browser', 'export.column.browser', width=14),
            ExportColumn('os', 'export.column.os', width=14),
            ExportColumn('trace_id', 'export.column.trace_id', width=34),
        ),
        filters=LogExportFilters,
        filter_labels=_LOG_FILTER_LABELS,
        select=_opera_log_select,
        id_column=OperaLog.id,
        shape=_columns_only,
    )
)


# ═══════════════════════════════ 导入 ═══════════════════════════════
#
# 列名和上面导出用的是同一套翻译键 —— 导出的文件改完能原样导回来（框架按任一语言的列名认表头）


async def _dept_codes(db: AsyncSession) -> list[str]:
    """模板里「部门编码 / 上级部门编码」的下拉：导入人**看得见**的部门（DAO 按数据范围过滤）"""
    stmt = await dept_dao.get_select(true(), name=None, code=None, phone=None, status=None)
    return [dept.code for dept in (await db.execute(stmt)).scalars().all()][:500]


async def _role_codes(db: AsyncSession) -> list[str]:
    roles = await role_dao.get_all(db)
    return [role.code for role in roles][:500]


# ─────────────────────────────── 用户 ───────────────────────────────

#: 角色列里的分隔符。中英文逗号、顿号、分号都收 —— 用户不会记得该用哪个
_ROLE_SEPARATORS = str.maketrans({'，': ',', '、': ',', ';': ',', '；': ','})


class _UserRow(ColumnLengthChecked, SchemaBase):
    """一行用户的字段校验（长度按 `sys_user` 的列现读，格式和新增用户同一套类型）"""

    __sa_model__ = User

    username: str = Field(min_length=1, description='用户名')
    nickname: str | None = Field(None, description='昵称')
    email: CustomEmailStr | None = Field(None, description='邮箱')
    phone: CustomPhoneNumber | None = Field(None, description='手机号')


def _split_roles(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip().upper() for part in value.translate(_ROLE_SEPARATORS).split(',') if part.strip()]


def _default_password() -> str:
    """系统默认密码。🔴 空串 = 这套部署没配 = 用户导入关闭，不给内置兜底值（内置值会跟着仓库公开）"""
    password = settings.USER_IMPORT_DEFAULT_PASSWORD
    if not password:
        raise errors.RequestError(msg=t('error.import.default_password_unset'))
    return password


class _CodeCache:
    """编码 → ID 的查询在一次校验里缓存：200 行的表里通常只有个位数的不同部门，逐行查是 200 次往返换同样的答案"""

    def __init__(self, lookup: Any) -> None:
        self._lookup = lookup
        self._ids: dict[str, int | None] = {}

    async def get(self, db: AsyncSession, code: str) -> int | None:
        if code not in self._ids:
            found = await self._lookup(db, code)
            self._ids[code] = found.id if found else None
        return self._ids[code]


async def _user_row(db: AsyncSession, row: ImportRow, depts: _CodeCache, roles: _CodeCache) -> None:
    """一行：字段格式 + 部门 / 角色编码换成 ID"""
    values = row.values
    try:
        _UserRow.model_validate({key: values.get(key) for key in ('username', 'nickname', 'email', 'phone')})
    except ValidationError as e:
        row.errors.extend(pydantic_errors(USER_IMPORT, e))

    dept_id = None
    if values.get('dept_code'):
        dept_id = await depts.get(db, values['dept_code'])
        if dept_id is None:
            row.errors.append(t('error.import.dept_code_not_found', code=values['dept_code']))

    role_ids: list[int] = []
    for role_code in _split_roles(values.get('role_codes')):
        role_id = await roles.get(db, role_code)
        if role_id is None:
            row.errors.append(t('error.import.role_code_not_found', code=role_code))
        else:
            role_ids.append(role_id)

    row.action = 'create'
    row.payload = {
        'username': values.get('username'),
        'nickname': values.get('nickname') or values.get('username'),
        'email': values.get('email'),
        'phone': values.get('phone'),
        'dept_id': dept_id,
        'role_ids': role_ids,
    }


async def _user_validate(db: AsyncSession, rows: list[ImportRow], _mode: str, _ctx: ImportContext) -> None:
    """部门 / 角色编码 → ID，邮箱在文件里和库里都不能重复，用户名在库里不能已存在（文件里的重复框架查过了）

    🔴 默认密码每次都现校验一遍强度：不校验的失败是延迟且分裂的 —— 导入成功、能登录，
    但本人改密码时被「必须含字母」挡住，两件事看不出是同一个原因（`123456` 就过不了）
    """
    await validate_password_strength(db, _default_password())

    depts, roles = _CodeCache(dept_dao.get_by_code), _CodeCache(role_dao.get_by_code)
    emails_seen: dict[str, int] = {}
    for row in rows:
        await _user_row(db, row, depts, roles)
        email = row.values.get('email')
        if not email:
            continue
        if email in emails_seen:
            row.errors.append(t('error.import.duplicated_email', value=email, row_no=emails_seen[email]))
        else:
            emails_seen[email] = row.row_no

    # 和库里已有的重复：两次批量查询，不逐行往返（两者都豁免数据范围：冲突检查不是「展示读」）
    usernames = [row.values['username'] for row in rows if row.values.get('username')]
    taken_names = await user_dao.get_existing_usernames(db, usernames)
    taken_emails = await user_dao.get_existing_emails(db, list(emails_seen))
    for row in rows:
        if row.values.get('username') in taken_names:
            row.errors.append(t('error.user.username_registered'))
        if row.values.get('email') in taken_emails:
            row.errors.append(t('error.user.email_bound'))


async def _user_commit(db: AsyncSession, rows: list[ImportRow], _ctx: ImportContext) -> CommitOutcome:
    """整批一次 bcrypt（`user_dao.bulk_add`），所以一批要么全进要么全不进。

    不改成逐行建号：逐行就是逐行 bcrypt，87 行占住事件循环 16 秒（admin 分册）
    """
    try:
        async with db.begin_nested():
            created = await user_dao.bulk_add(db, [row.payload for row in rows], _default_password())
    except SQLAlchemyError:
        log.exception('批量建号失败')
        return CommitOutcome(failed={row.row_no: t('error.import.row_unexpected') for row in rows})
    # 🔴 只回报「用了默认密码」这件事，不回报密码本身：操作日志会把响应体原样落库
    return CommitOutcome(created=created, notes=[t('import.note.user_default_password')])


USER_IMPORT = register_import(
    ImportSpec(
        resource='sys.user',
        label='export.resource.user',
        # 部门和角色一律填编码，不填名字：部门名只在同级唯一（「技术中心/测试组」「质量中心/测试组」都合法），
        # 一列「测试组」定位不到是哪一个；ID 更不行 —— 19 位数字贴进 Excel 那一刻就塌成科学计数（硬纪律 6）
        columns=(
            ImportColumn('username', 'export.column.username', required=True, note='import.note.username'),
            ImportColumn('nickname', 'export.column.nickname', note='import.note.nickname'),
            ImportColumn('email', 'export.column.email', note='import.note.email', width=26),
            ImportColumn('phone', 'export.column.phone', note='import.note.phone', width=14),
            ImportColumn(
                'dept_code',
                'export.column.dept_code',
                required=True,
                upper=True,
                aliases=('dept',),
                note='import.note.dept_code',
                options=_dept_codes,
            ),
            ImportColumn(
                'role_codes',
                'export.column.role_codes',
                aliases=('roles', 'role_code'),
                note='import.note.role_codes',
                options=_role_codes,
                dropdown=False,
                width=24,
            ),
        ),
        key_of=lambda values: values.get('username'),
        validate=_user_validate,
        commit=_user_commit,
        modes=('create',),
        notes=('import.note.user_default_password',),
    )
)


# ─────────────────────────────── 部门 ───────────────────────────────


async def _depts_by_code(db: AsyncSession, codes: Iterable[str], *, scoped: bool) -> dict[str, Dept]:
    """
    按编码批量取部门（一次查完，不逐行往返）。

    `scoped=False` 是存在性检查：豁免数据范围（理由同 `dept_dao.get_by_code`：冲突检查不是展示读）；
    `scoped=True` 是「导入人看不看得见」—— 能不能改它、能不能挂到它下面，看不见就是不能，
    和新增部门时 `check_create` 按 ID 查上级同一个口径
    """
    ordered = sorted(codes)
    found: dict[str, Dept] = {}
    for start in range(0, len(ordered), 1000):  # SQL Server 一句最多 2100 个参数
        chunk = ordered[start : start + 1000]
        if scoped:
            depts = await dept_dao.select_models(db, code__in=chunk, deleted=0)
        else:
            with bypass_data_scope():
                depts = await dept_dao.select_models(db, code__in=chunk, deleted=0)
        found.update({dept.code: dept for dept in depts})
    return found


async def _dept_parent_codes(db: AsyncSession) -> dict[str, str | None]:
    """
    库里每个部门的上级编码，整张表一次查完 —— 查环要沿着上级一路往上走，逐级查是「深度 × 行数」次往返。

    结构检查，不按数据范围过滤：看不见的那一段上级链一样会成环
    """
    parent = aliased(Dept)
    stmt = (
        select(Dept.code, parent.code)
        .outerjoin(parent, and_(parent.id == Dept.parent_id, parent.deleted == 0))
        .where(Dept.deleted == 0)
    )
    return dict((await db.execute(stmt)).all())


async def _leaders(db: AsyncSession, usernames: set[str]) -> dict[str, tuple[int, bool]]:
    """负责人用户名 → (ID, 是否启用)"""
    if not usernames:
        return {}
    stmt = select(User.username, User.id, User.status).where(User.username.in_(usernames), User.deleted == 0)
    return {username: (pk, status == 1) for username, pk, status in (await db.execute(stmt)).all()}


@dataclasses.dataclass
class _DeptLookup:
    """一次校验要用的库里的现状：批量查好，逐行只查内存"""

    #: 文件里的行，按编码。编码重复的只认第一行（第二行已经被框架标了「和第 N 行重复」）
    rows: dict[str, ImportRow]
    #: 编码 → 部门，不论导入人看不看得见
    existing: dict[str, Dept]
    #: 其中导入人看得见的
    visible: dict[str, Dept]
    leaders: dict[str, tuple[int, bool]]


def _dept_fields(values: dict[str, Any], current: Dept | None) -> dict[str, Any]:
    """一行要写成的字段。更新时**空白单元格表示保持原值**（不是清空）—— 只改一列的人不用把整行抄全"""

    def pick(key: str, default: Any) -> Any:
        value = values.get(key)
        if value is not None:
            return value
        return getattr(current, key) if current is not None else default

    return {
        'name': pick('name', None),
        'sort': pick('sort', 0),
        'status': pick('status', 1),
        'phone': pick('phone', None),
        'email': pick('email', None),
    }


def _resolve_parent(row: ImportRow, current: Dept | None, lookup: _DeptLookup) -> tuple[int | None, str | None]:
    """
    上级 → (库里的 ID, 文件里那一行的编码)。

    - 上级在库里：给 ID（导入人还得看得见它）；它同时也在文件里的话再给编码 —— 提交时按它排先后
    - 上级只在文件里（同一份文件新建的）：只给编码，ID 要等那一行建出来
    - 留空：新建的是顶级部门；更新的**保持原上级**（空白单元格一律表示不改）
    """
    code, parent_code = row.values['code'], row.values.get('parent_code')
    if not parent_code:
        return (current.parent_id if current is not None else None), None
    if parent_code == code:
        row.errors.append(t('error.dept.cannot_be_own_parent'))
        return None, None
    in_file = parent_code if parent_code in lookup.rows else None
    if parent_code not in lookup.existing:
        if in_file is None:
            row.errors.append(t('error.import.parent_not_found', code=parent_code))
        return None, in_file
    parent = lookup.visible.get(parent_code)
    if parent is None:
        row.errors.append(t('error.import.parent_not_found', code=parent_code))
        return None, None
    return parent.id, in_file


def _resolve_leader(row: ImportRow, current: Dept | None, lookup: _DeptLookup) -> int | None:
    """
    负责人用户名 → ID。只认启用的账号（同 `dept_service._check_leader`）。

    但更新时填的就是**现任**负责人的话照常放行：service 也是「换了负责人才校验」——
    否则负责人一离职，这个部门在导入里就再也改不了（导出的文件原样导回来就会撞上）
    """
    username = row.values.get('leader')
    if not username:
        return current.leader_id if current is not None else None
    found = lookup.leaders.get(username)
    if found is not None and (found[1] or (current is not None and found[0] == current.leader_id)):
        return found[0]
    row.errors.append(t('error.import.leader_not_found', username=username))
    return None


async def _dept_row(db: AsyncSession, row: ImportRow, mode: str, lookup: _DeptLookup) -> None:
    """一行：按编码定新增还是更新 → 上级 / 负责人 → 字段校验 → service 的业务规则"""
    code = row.values['code']
    found = lookup.existing.get(code)
    if found is not None and mode == 'create':
        row.errors.append(t('error.import.key_exists', key=code))
        return
    if found is None and mode == 'update':
        row.errors.append(t('error.import.key_not_found', key=code))
        return
    current = lookup.visible.get(code)
    if found is not None and current is None:
        # 存在但在导入人的数据范围之外：说「不存在」，和接口上按 ID 改一个看不见的部门同一个口径
        row.errors.append(t('error.dept.not_found'))
        return
    if current is None and not row.values.get('name'):
        row.errors.append(required_error(DEPT_IMPORT, 'name'))
        return
    row.action = 'update' if current is not None else 'create'
    row.target_id = current.id if current is not None else None

    parent_id, parent_row = _resolve_parent(row, current, lookup)
    leader_id = _resolve_leader(row, current, lookup)
    fields = {**_dept_fields(row.values, current), 'leader_id': leader_id, 'parent_id': parent_id}
    try:
        param = CreateDeptParam(code=code, **fields) if current is None else UpdateDeptParam(**fields)
    except ValidationError as e:
        row.errors.extend(pydantic_errors(DEPT_IMPORT, e))
        return
    # 业务规则（同级重名、负责人、上级存在……）走 service 那一份，不另写。上级是文件里新建的那一行时库里还没有它，
    # 这些规则留给提交（`_dept_commit` 调的就是 service）；文件里的行之间的同级重名、成环由 `_check_tree` 查
    if row.ok and not (parent_row and parent_id is None):
        try:
            if current is None:
                await dept_service.check_create(db=db, obj=param)
            else:
                await dept_service.check_update(db=db, pk=current.id, obj=param, check_ancestry=False)
        except errors.BaseExceptionError as e:
            row.errors.append(e.msg)
    row.payload = {**param.model_dump(mode='json'), 'code': code, 'parent_code': parent_row}


async def _dept_validate(db: AsyncSession, rows: list[ImportRow], mode: str, _ctx: ImportContext) -> None:
    """编码定新增还是更新；上级可以是库里**看得见的**部门，也可以是同一份文件里的另一行"""
    by_code: dict[str, ImportRow] = {}
    for row in rows:
        if row.values.get('code'):
            by_code.setdefault(row.values['code'], row)
    codes = {*by_code, *(row.values['parent_code'] for row in rows if row.values.get('parent_code'))}
    existing = await _depts_by_code(db, codes, scoped=False)
    lookup = _DeptLookup(
        rows=by_code,
        existing=existing,
        visible=await _depts_by_code(db, existing, scoped=True),
        leaders=await _leaders(db, {row.values['leader'] for row in rows if row.values.get('leader')}),
    )
    for row in by_code.values():
        await _dept_row(db, row, mode, lookup)
    _check_tree(rows, by_code, await _dept_parent_codes(db))


def _check_tree(rows: list[ImportRow], by_code: dict[str, ImportRow], db_parents: dict[str, str | None]) -> None:
    """
    文件里的行之间的上下级，按「**整份文件导完之后**的树」查，不按库里现在的树查 ——
    同一份文件里可以先把 B 挪走、再把 A 挂到 B 下面，按现在的树查会误报成环。

    1. 成环：改了上级的行沿着「导完之后的上级」一路往上走，走回自己就是环（环上每一行改了上级的都标）
    2. 同一个上级下重名（文件里的行之间；和库里已有的兄弟比，service 已经查过了）
    3. 上级是文件里新建的那一行、而那一行导不了：下级也导不了 —— 要在预览里就说清楚，别等提交时才冒出来
    4. 记下每一行在导完之后的树里有多深：提交按它从浅到深写，上级总是先就位
    """
    after = _tree_after(by_code, db_parents)
    for code, row in by_code.items():
        if row.ok and row.values.get('parent_code'):
            cycle = _cycle_from(code, after)
            if cycle:
                row.errors.append(t('error.import.parent_cycle', codes=' → '.join(cycle)))
    _check_sibling_names(rows)
    _propagate_parent_errors(by_code)
    after = _tree_after(by_code, db_parents)
    for code, row in by_code.items():
        if row.ok and row.payload is not None:
            row.payload['depth'] = _depth(code, after)


def _tree_after(by_code: dict[str, ImportRow], db_parents: dict[str, str | None]) -> dict[str, str | None]:
    """导完之后每个部门的上级编码：库里的现状，叠上文件里（能导的）每一行要改成的"""
    after = dict(db_parents)
    for code, row in by_code.items():
        if row.ok and row.payload is not None:
            after[code] = row.values.get('parent_code') or (db_parents.get(code) if row.action == 'update' else None)
    return after


def _cycle_from(code: str, after: dict[str, str | None]) -> list[str] | None:
    """从 `code` 沿上级往上走，走回自己就返回那一圈（`A → B → A`）。库里原来就有、不经过它的环不算它的"""
    path, node = [code], after.get(code)
    while node is not None and node not in path:
        path.append(node)
        node = after.get(node)
    return [*path, code] if node == code else None


def _depth(code: str, after: dict[str, str | None]) -> int:
    seen, node = {code}, after.get(code)
    while node is not None and node not in seen:
        seen.add(node)
        node = after.get(node)
    return len(seen) - 1


def _check_sibling_names(rows: list[ImportRow]) -> None:
    siblings: dict[tuple[Any, str], int] = {}
    for row in rows:
        payload = row.payload
        if not row.ok or not payload:
            continue
        # 上级是文件里新建的那一行：按它的编码认；否则按库里的 ID（顶级是 None）
        new_parent = payload['parent_code'] if payload['parent_id'] is None else None
        key = (('row', new_parent) if new_parent else ('id', payload['parent_id']), payload['name'])
        if key in siblings:
            row.errors.append(t('error.import.duplicated_name_in_level', row_no=siblings[key]))
        else:
            siblings[key] = row.row_no


def _propagate_parent_errors(by_code: dict[str, ImportRow]) -> None:
    changed = True
    while changed:
        changed = False
        for row in by_code.values():
            payload = row.payload
            if not row.ok or not payload or not payload['parent_code'] or payload['parent_id'] is not None:
                continue
            if not by_code[payload['parent_code']].ok:
                row.errors.append(t('error.import.parent_row_invalid', code=payload['parent_code']))
                changed = True


async def _dept_commit(db: AsyncSession, rows: list[ImportRow], ctx: ImportContext) -> CommitOutcome:
    """
    从浅到深写（`_check_tree` 记的深度）：上级总是先就位 —— 新建的下级要等上级建出来拿到 ID，
    挪位置的要等它的新上级先挪到位（否则 service 按当时的树查环会误判）。

    一行一个保存点：一行写不进去不影响别的行（PostgreSQL 上一句失败整个事务就作废，不能只吞异常）
    """
    created: list[str] = []
    updated: list[str] = []
    failed: dict[int, str] = {}
    ids: dict[str, int] = {}
    for row in sorted(rows, key=lambda item: item.payload['depth']):
        payload = dict(row.payload)
        code, parent_row = payload.pop('code'), payload.pop('parent_code')
        payload.pop('depth')
        if parent_row and payload['parent_id'] is None:
            if parent_row not in ids:
                failed[row.row_no] = t('error.import.parent_row_failed', code=parent_row)
                continue
            payload['parent_id'] = ids[parent_row]
        try:
            async with db.begin_nested():
                if row.action == 'create':
                    await dept_service.create(db=db, obj=CreateDeptParam(code=code, **payload))
                    # 会话关着 autoflush：不先 flush，紧跟着按编码查是查不到刚建的这一行的
                    await db.flush()
                    ids[code] = (await dept_dao.get_by_code(db, code)).id
                    created.append(code)
                else:
                    await dept_service.update(
                        db=db, background_tasks=ctx.background_tasks, pk=row.target_id, obj=UpdateDeptParam(**payload)
                    )
                    ids[code] = row.target_id
                    updated.append(code)
        except errors.BaseExceptionError as e:
            failed[row.row_no] = e.msg
        except (SQLAlchemyError, ValidationError):
            log.exception(f'导入部门 {code} 失败')
            failed[row.row_no] = t('error.import.row_unexpected')
    return CommitOutcome(created=created, updated=updated, failed=failed)


DEPT_IMPORT = register_import(
    ImportSpec(
        resource='sys.dept',
        label='export.resource.dept',
        columns=(
            ImportColumn(
                'code', 'export.column.dept_code', required=True, upper=True, note='import.note.dept_code_key', width=16
            ),
            # 不是整列必填：更新时空白表示不改名，新建时才必填（`_dept_row` 查）
            ImportColumn('name', 'export.column.dept_name', note='import.note.dept_name', width=20),
            ImportColumn(
                'parent_code',
                'export.column.parent_code',
                upper=True,
                note='import.note.parent_code',
                options=_dept_codes,
                width=16,
            ),
            ImportColumn('leader', 'export.column.leader_username', note='import.note.leader', width=16),
            ImportColumn('phone', 'export.column.phone', width=14),
            ImportColumn('email', 'export.column.email', width=26),
            ImportColumn('sort', 'export.column.sort', kind='int', width=8),
            ImportColumn(
                'status', 'export.column.status', choices=_ENABLE_STATUS, choice_aliases=ENABLE_STATUS_ALIASES, width=8
            ),
        ),
        key_of=lambda values: values.get('code'),
        validate=_dept_validate,
        commit=_dept_commit,
        modes=('create', 'upsert', 'update'),
        notes=('import.note.update_keeps_blank',),
    )
)

"""用户批量导入。

两阶段：**预览校验 → 确认提交**，中间用一个存在 Redis 的短期 token 接住。

为什么不是一次性直接导入 —— 两种现有的批量操作代表两种部分失败哲学，
这个场景哪一种单用都不合适：

- 文件批量删除是**单事务全有全无**：87 行里 3 行打字错误，不该让 84 行正确的
  也全部重来
- 用户批量删除是**跳过失败继续**：用在**创建**上风险更高，删除是幂等的、
  删错顶多是记录消失，创建会产生新数据，混着「没校验干净就落库了」不是好体验

所以拆成两步：预览阶段做完整校验、不落库；提交阶段只可能在「两步之间被别人
抢注了同一个用户名」这种小概率竞态上失败，那时允许单行失败、跳过、汇报清单，
比让一整批回滚划算。

用 Redis token 而不是「预览把数据返回、提交时前端再传回来」：既不用把解析结果
在前端倒一手，也堵住「用户在两步之间改了本地文件」导致预览和提交对不上。
"""

import uuid

from typing import Any

import msgspec

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_dept import dept_dao
from backend.app.admin.crud.crud_role import role_dao
from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.schema.user_import import (
    ImportCommitDetail,
    ImportCommitParam,
    ImportPreviewDetail,
    ImportPreviewRow,
    ImportRowError,
)
from backend.app.admin.utils.password_security import validate_password_strength
from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils.excel_ops import TableColumn, TableData, build_template, parse_table

#: 模板的列。**部门和角色一律用 `code`，不用中文名**，两条理由都是硬的：
#:
#: 1. 部门名称的唯一性 2026-08-22 从「全局唯一」改成了「同级唯一」——
#:    「技术中心/测试组」和「质量中心/测试组」是合法的两个部门，
#:    Excel 里一列中文「测试组」无法唯一定位是哪一个
#: 2. 🔴 就算想用 ID 也不行：雪花 ID 是 19 位，而 Excel 所有数值都是 IEEE
#:    double —— 贴进单元格的那一刻就已经塌成 `1.234567890123457e+18` 了
#:    （实测，和解析库无关）。同硬纪律 6
IMPORT_COLUMNS = [
    TableColumn(key='username', required=True),
    TableColumn(key='nickname'),
    TableColumn(key='email'),
    TableColumn(key='phone'),
    TableColumn(key='dept_code', required=True, aliases=('dept',)),
    TableColumn(key='role_codes', required=False, aliases=('roles', 'role_code')),
]

#: 角色列里的分隔符。中英文逗号、顿号、分号都收 —— 用户不会记得该用哪个
_ROLE_SEPARATORS = str.maketrans({'，': ',', '、': ',', ';': ',', '；': ','})


class UserImportService:
    """用户批量导入服务"""

    @staticmethod
    def template() -> bytes:
        """生成导入模板"""
        notes = {column.key: t(f'import.column.{column.key}') for column in IMPORT_COLUMNS}
        return build_template(IMPORT_COLUMNS, notes=notes)

    @staticmethod
    def _default_password() -> str:
        """
        取系统默认密码，顺便把它自己校验一遍。

        🔴 **默认密码必须自己过强度校验，否则失败是延迟且分裂的**：导入成功、
        用户拿它能登录，但他去改密码时被「必须含字母」之类挡住 —— 而这两件事
        看不出是同一个原因。`123456` 就是过不了的（`is_has_letter`）。
        这里只做「非空」判断，强度交给 `validate_password_strength()`
        （它要读动态配置，得有 db）。
        """
        password = settings.USER_IMPORT_DEFAULT_PASSWORD
        if not password:
            # 空串 = 这套部署没配默认密码 = 功能关闭。不给内置兜底值：
            # 内置值会跟着仓库公开，而每套部署都会照抄
            raise errors.RequestError(msg=t('error.import.default_password_unset'))
        return password

    async def preview(self, *, db: AsyncSession, raw: bytes) -> ImportPreviewDetail:
        """
        解析 + 校验，不落库。

        :param db: 数据库会话
        :param raw: xlsx 字节
        :return:
        """
        password = self._default_password()
        await validate_password_strength(db, password)

        data: TableData = parse_table(raw, IMPORT_COLUMNS)

        # 解析层报出来的问题（公式 / 数值超范围 / 必填为空）按行归拢
        errors_by_row: dict[int, list[str]] = {}
        for issue in data.issues:
            label = f'{issue.column}: {issue.msg}' if issue.column else issue.msg
            errors_by_row.setdefault(issue.row_no, []).append(label)

        parsed = [(row.row_no, dict(row.values)) for row in data.rows]
        await self._check_references(db, parsed, errors_by_row)
        self._check_duplicates_within_file(parsed, errors_by_row)
        await self._check_duplicates_against_db(db, parsed, errors_by_row)

        rows: list[ImportPreviewRow] = []
        payload: list[dict[str, Any]] = []
        for row_no, values in parsed:
            row_errors = errors_by_row.get(row_no, [])
            rows.append(
                ImportPreviewRow(
                    row_no=row_no,
                    username=values.get('username'),
                    nickname=values.get('nickname'),
                    email=values.get('email'),
                    phone=values.get('phone'),
                    dept_code=values.get('dept_code'),
                    role_codes=self._split_roles(values.get('role_codes')),
                    ok=not row_errors,
                    errors=row_errors,
                )
            )
            if not row_errors:
                payload.append({
                    'row_no': row_no,
                    'username': values['username'],
                    'nickname': values.get('nickname') or values['username'],
                    'email': values.get('email'),
                    'phone': values.get('phone'),
                    'dept_id': values['_dept_id'],
                    'role_ids': values['_role_ids'],
                })

        token = uuid.uuid4().hex
        # ⚠️ 存进 Redis 的**只有业务字段**，没有密码 —— 明文密码在整条链路上
        # 一次都不出现（模板里没有这一列，请求、响应、缓存里也都没有）
        await redis_client.set(
            f'{settings.USER_IMPORT_REDIS_PREFIX}:{token}',
            msgspec.json.encode(payload),
            ex=settings.USER_IMPORT_EXPIRE_SECONDS,
        )

        return ImportPreviewDetail(
            import_token=token,
            expire_seconds=settings.USER_IMPORT_EXPIRE_SECONDS,
            total=len(rows),
            valid=len(payload),
            rows=rows,
            ignored_headers=data.ignored_headers,
            empty_rows=data.empty_rows,
        )

    async def commit(self, *, db: AsyncSession, obj: ImportCommitParam) -> ImportCommitDetail:
        """
        按预览留下的 token 真正建号。

        :param db: 数据库会话
        :param obj: 提交参数
        :return:
        """
        password = self._default_password()
        await validate_password_strength(db, password)

        key = f'{settings.USER_IMPORT_REDIS_PREFIX}:{obj.import_token}'
        cached = await redis_client.get(key)
        if not cached:
            raise errors.RequestError(msg=t('error.import.token_expired'))

        # 🔴 **先删 token 再建号。** 不删的话同一个 token 提交两次就是重复建号 ——
        # 第二次会撞用户名唯一约束，但那时第一批已经落库了，用户看到的是
        # 「导入失败」而库里多了 87 个人
        await redis_client.delete(key)

        excluded = set(obj.exclude_rows)
        payload = [row for row in msgspec.json.decode(cached) if row['row_no'] not in excluded]
        if not payload:
            raise errors.RequestError(msg=t('error.import.nothing_to_create'))

        # 预览到提交之间可能有人抢注了同一个用户名/邮箱。这里再查一次，
        # 命中的行跳过而不是让整批失败 —— 这是这个场景唯一预期的失败来源
        failed: list[ImportRowError] = []
        taken_names = await user_dao.get_existing_usernames(db, [row['username'] for row in payload])
        taken_emails = await user_dao.get_existing_emails(db, [row['email'] for row in payload if row['email']])

        creatable: list[dict[str, Any]] = []
        for row in payload:
            if row['username'] in taken_names:
                failed.append(
                    ImportRowError(row_no=row['row_no'], column='username', msg=t('error.user.username_registered'))
                )
                continue
            if row['email'] and row['email'] in taken_emails:
                failed.append(ImportRowError(row_no=row['row_no'], column='email', msg=t('error.user.email_bound')))
                continue
            creatable.append(row)

        created = await user_dao.bulk_add(db, creatable, password) if creatable else []

        return ImportCommitDetail(created=created, failed=failed, used_default_password=True)

    # ------------------------------------------------------------------ 校验

    async def _check_references(
        self, db: AsyncSession, parsed: list[tuple[int, dict]], errors_by_row: dict[int, list[str]]
    ) -> None:
        """把 `dept_code` / `role_codes` 换成 ID，查不到的记成这一行的错。

        编码 → ID 的查询结果在本次预览内缓存 —— 一份 200 行的表里通常只有
        个位数的不同部门，逐行查是 200 次往返换同样的答案。
        """
        dept_ids: dict[str, int | None] = {}
        role_ids: dict[str, int | None] = {}

        for row_no, values in parsed:
            dept_code = values.get('dept_code')
            if dept_code is not None:
                if dept_code not in dept_ids:
                    dept = await dept_dao.get_by_code(db, dept_code)
                    dept_ids[dept_code] = dept.id if dept else None
                if dept_ids[dept_code] is None:
                    errors_by_row.setdefault(row_no, []).append(t('error.import.dept_code_not_found', code=dept_code))
            values['_dept_id'] = dept_ids.get(dept_code)

            resolved: list[int] = []
            for code in self._split_roles(values.get('role_codes')):
                if code not in role_ids:
                    role = await role_dao.get_by_code(db, code)
                    role_ids[code] = role.id if role else None
                if role_ids[code] is None:
                    errors_by_row.setdefault(row_no, []).append(t('error.import.role_code_not_found', code=code))
                else:
                    resolved.append(role_ids[code])
            values['_role_ids'] = resolved

    @staticmethod
    def _check_duplicates_within_file(parsed: list[tuple[int, dict]], errors_by_row: dict[int, list[str]]) -> None:
        """
        文件**内部**的重复。

        🔴 这一维单独查是必须的：库里没有、文件里有两行同名，逐行对着库查
        全都「通过」，然后在提交阶段撞唯一约束 —— 而那时候第一行已经建出来了。
        """
        for field, key in (
            ('username', 'error.import.duplicated_username'),
            ('email', 'error.import.duplicated_email'),
        ):
            seen: dict[str, int] = {}
            for row_no, values in parsed:
                value = values.get(field)
                if value is None:
                    continue
                if value in seen:
                    errors_by_row.setdefault(row_no, []).append(t(key, value=value, row_no=seen[value]))
                else:
                    seen[value] = row_no

    @staticmethod
    async def _check_duplicates_against_db(
        db: AsyncSession, parsed: list[tuple[int, dict]], errors_by_row: dict[int, list[str]]
    ) -> None:
        """和**库里已有**数据的重复。两次批量查询，不逐行往返"""
        usernames = [values['username'] for _, values in parsed if values.get('username')]
        emails = [values['email'] for _, values in parsed if values.get('email')]
        taken_names = await user_dao.get_existing_usernames(db, usernames)
        taken_emails = await user_dao.get_existing_emails(db, emails)

        for row_no, values in parsed:
            if values.get('username') in taken_names:
                errors_by_row.setdefault(row_no, []).append(t('error.user.username_registered'))
            if values.get('email') and values['email'] in taken_emails:
                errors_by_row.setdefault(row_no, []).append(t('error.user.email_bound'))

    @staticmethod
    def _split_roles(value: str | None) -> list[str]:
        """角色列拆成编码列表。分隔符宽容，编码本身不做格式校验（查不到自然会报）"""
        if not value:
            return []
        return [part.strip().upper() for part in value.translate(_ROLE_SEPARATORS).split(',') if part.strip()]


user_import_service: UserImportService = UserImportService()

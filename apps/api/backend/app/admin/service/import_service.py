"""导入（#11 · v0.4）：模板 · 预览 · 提交 · 错误报告。

框架负责的事（资源不用管）：

- **表头三种写法都认**：英文 key、中文列名、英文列名（`_table_columns`）。导出的表头用的是同一套列名，
  所以导出的文件改完能原样导回来
- **单元格 → 值**：固定取值认任一语言的文字和值本身，整数解析，编码转大写（`_convert`）
- **文件内重复**：按业务键查（`spec.key_of`）。🔴 这一维必须单独查：库里没有、文件里有两行同一个键，
  逐行对着库查全都「通过」，到提交时撞唯一约束 —— 而那时前面的行已经写进去了
- **一次性令牌**：`GETDEL` 抢占（同 AI 确认令牌那条：「先读再删」不是原子的，双击 / 重试 / 两个标签页会提交两次）
- **提交前再校验一遍**：预览到提交之间库里可能变了（别人抢注了同一个编码）
- **两种失败哲学由用户选**：部分成功（能导的先导）或全有或全无（`atomic`）
- **错误报告**：有问题的行原样写回一张表，最后加一列原因 —— 用户改完那几行能直接再导
"""

import contextlib
import operator
import os
import tempfile
import uuid

from pathlib import Path
from typing import Any

import anyio
import msgspec

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.schema.data_import import (
    ImportColumnDetail,
    ImportCommitDetail,
    ImportCommitParam,
    ImportPreviewDetail,
    ImportPreviewRow,
    ImportRowError,
)
from backend.common.dataio.cells import int_cell, text_cell
from backend.common.dataio.importing import ImportColumn, ImportContext, ImportMode, ImportRow, ImportSpec, get_import
from backend.common.dataio.writers import SheetColumn, XlsxSheetWriter
from backend.common.exception import errors
from backend.common.i18n import i18n, t
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils.excel_ops import TableColumn, TemplateColumn, build_template, parse_table
from backend.utils.timezone import timezone


def _translations(key: str) -> set[str]:
    """一个翻译键在**所有**语言里的译文（表头、取值文字都按任一语言认）"""
    out = set()
    for language in i18n.locales:
        with i18n.use_language(language):
            text = t(key)
        if text and text != key:
            out.add(text)
    return out


def _table_columns(spec: ImportSpec) -> list[TableColumn]:
    return [
        TableColumn(
            key=column.key,
            required=column.required,
            aliases=tuple({*column.aliases, *_translations(column.label)}),
            label=t(column.label),
        )
        for column in spec.columns
    ]


def _choice_lookup(column: ImportColumn) -> dict[str, Any]:
    lookup: dict[str, Any] = {}
    for value, label in (column.choices or {}).items():
        lookup[str(value).strip().lower()] = value
        for text in _translations(label):
            lookup[text.strip().lower()] = value
    for value, aliases in (column.choice_aliases or {}).items():
        for text in aliases:
            lookup.setdefault(text.strip().lower(), value)
    return lookup


def _convert(column: ImportColumn, text: str | None, lookups: dict[str, dict[str, Any]]) -> tuple[Any, str | None]:
    """一格的文本 → 值。返回 (值, 错误)"""
    if text is None:
        return None, None
    if column.choices:
        value = lookups[column.key].get(text.strip().lower())
        if value is None:
            allowed = ' / '.join(t(label) for label in column.choices.values())
            return None, t('error.import.bad_choice', column=t(column.label), allowed=allowed)
        return value, None
    if column.kind == 'int':
        try:
            return int(text.strip()), None
        except ValueError:
            return None, t('error.import.not_an_integer', column=t(column.label))
    return (text.upper() if column.upper else text), None


def _cell_msg(error: Any) -> str:
    """pydantic 的一条报错 → 给填表的人看的那句话。

    🔴 **两种最常见的格式错不用 pydantic 那句。** 邮箱错报的是 `value_error` + `{reason}`（email-validator 的英文），
    而 `pydantic.value_error` 的译文是「值错误，{error}」—— 原来填不上就把模板原样返回，预览里显示的是
    「邮箱：值错误，{error}」；手机号 / 编码错报的是正则（「字符串应匹配模式 '^1[3-9]\\d{9}$'」），
    对填 Excel 的人等于没说。两个都是目测截图看出来的，测试原来全绿（只断言了列名在不在）。
    格式怎么填写在模板的说明页里，报错指过去
    """
    if error['type'] == 'value_error' and str(error.get('msg', '')).startswith('value is not a valid email address'):
        return t('error.import.bad_email')
    if error['type'] == 'string_pattern_mismatch':
        return t('error.import.bad_format')
    msg = str(error.get('msg', ''))
    # 其余的中文界面才翻（`pydantic.*` 只有 zh-CN 一份，同 `exception_handler`）；
    # 译文要的占位符这条报错没给时，用 pydantic 自己那句，不把 `{xxx}` 原样摊出去
    custom = t(f'pydantic.{error["type"]}') if i18n.current_language != 'en-US' else None
    if custom:
        try:
            return custom.format(**(error.get('ctx') or {}))
        except (KeyError, IndexError):
            return msg
    return msg


def pydantic_errors(spec: ImportSpec, e: ValidationError) -> list[str]:
    """把 pydantic 的校验错误翻成「列名：原因」（给资源的 `validate` 用）"""
    labels = {column.key: t(column.label) for column in spec.columns}
    out = []
    for error in e.errors():
        field = str(error.get('loc', ('-',))[-1])
        out.append(t('import.cell_error', column=labels.get(field, field), msg=_cell_msg(error)))
    return out


def required_error(spec: ImportSpec, key: str) -> str:
    """「列名：必填项不能为空」—— 和解析层报必填同一个说法（给「新建时才必填」的列用：更新时空白表示不改）"""
    return t('import.cell_error', column=t(spec.column(key).label), msg=t('error.table.cell_required'))


def _key(token: str) -> str:
    return f'{settings.IMPORT_REDIS_PREFIX}:{token}'


def _report_key(token: str) -> str:
    return f'{settings.IMPORT_REDIS_PREFIX}:report:{token}'


class ImportService:
    """导入服务"""

    # ─────────────────────────────── 模板 ───────────────────────────────

    @staticmethod
    async def template(*, db: AsyncSession, spec: ImportSpec) -> tuple[bytes, str]:
        """导入模板：(xlsx 字节, 文件名)"""
        columns = []
        for column in spec.columns:
            if column.choices:
                options = tuple(t(label) for label in column.choices.values())
            elif column.options is not None:
                options = tuple(await column.options(db))
            else:
                options = ()
            columns.append(
                TemplateColumn(
                    header=t(column.label),
                    required=column.required,
                    note=t(column.note) if column.note else '',
                    options=options,
                    dropdown=column.dropdown,
                    width=column.width,
                )
            )
        raw = await anyio.to_thread.run_sync(
            lambda: build_template(
                columns,
                readme_header=(
                    t('import.readme.column'),
                    t('import.readme.required'),
                    t('import.readme.note'),
                    t('import.readme.options'),
                ),
                invalid_hint=t('import.readme.invalid_hint'),
                required_mark=t('export.bool_yes'),
                extra_notes=tuple(t(note) for note in spec.notes),
                sheet_title=t('import.readme.data_sheet'),
                readme_title=t('import.readme.sheet'),
                max_rows=spec.max_rows,
            )
        )
        return raw, t('import.template_name', resource=t(spec.label))

    # ─────────────────────────────── 预览 ───────────────────────────────

    @staticmethod
    async def preview(
        *, db: AsyncSession, spec: ImportSpec, raw: bytes, user: Any, mode: ImportMode
    ) -> ImportPreviewDetail:
        """解析 + 校验，不落库"""
        if mode not in spec.modes:
            raise errors.RequestError(msg=t('error.import.mode_unsupported'))

        # 解析放线程里：openpyxl 读一份接近上限的表是几百毫秒的纯 CPU，放事件循环上就是所有人的请求一起停
        # （同批量建号那条，admin 分册）。线程里的 `t()` 照样按这个请求的语言 —— anyio 会把 contextvars 带过去
        table_columns = _table_columns(spec)
        data = await anyio.to_thread.run_sync(lambda: parse_table(raw, table_columns, max_rows=spec.max_rows))
        labels = {column.key: t(column.label) for column in spec.columns}
        lookups = {column.key: _choice_lookup(column) for column in spec.columns if column.choices}

        # 解析层报出来的问题（公式 / 数值超范围 / 必填为空）按行归拢，带上列名
        issues: dict[int, list[str]] = {}
        for issue in data.issues:
            label = (
                t('import.cell_error', column=labels.get(issue.column, issue.column), msg=issue.msg)
                if issue.column
                else issue.msg
            )
            issues.setdefault(issue.row_no, []).append(label)

        rows: list[ImportRow] = []
        for table_row in data.rows:
            row = ImportRow(row_no=table_row.row_no, values={}, raw=dict(table_row.values))
            row.errors.extend(issues.get(table_row.row_no, []))
            for column in spec.columns:
                value, problem = _convert(column, table_row.values.get(column.key), lookups)
                row.values[column.key] = value
                if problem:
                    row.errors.append(problem)
            rows.append(row)

        # 文件内重复：按业务键，报「和第几行重复」—— 用户要回 Excel 里两行对着看
        seen: dict[str, int] = {}
        for row in rows:
            key = spec.key_of(row.values)
            if key is None:
                continue
            if key in seen:
                row.errors.append(t('error.import.duplicated_in_file', row_no=seen[key]))
            else:
                seen[key] = row.row_no

        await spec.validate(db, rows, mode, ImportContext(user=user))

        valid = [row for row in rows if row.ok]
        invalid = [row for row in rows if not row.ok]
        token = f'imp_{uuid.uuid4().hex}'
        # 🔴 存进 Redis 的是「能导的行要怎么写」+「原样的单元格」，**不含**任何密码之类的东西 ——
        # 用户导入的默认密码只在提交那一刻从配置里读
        await redis_client.set(
            _key(token),
            msgspec.json.encode({
                'resource': spec.resource,
                'user_id': str(user.id),
                'mode': mode,
                'rows': [
                    {
                        'row_no': row.row_no,
                        'values': row.values,
                        'raw': row.raw,
                        'action': row.action,
                        'target_id': str(row.target_id) if row.target_id is not None else None,
                        'payload': row.payload,
                    }
                    for row in valid
                ],
            }),
            ex=settings.IMPORT_EXPIRE_SECONDS,
        )
        await ImportService._save_report(token, spec, user, [(row.row_no, row.raw, row.errors) for row in invalid])

        return ImportPreviewDetail(
            import_token=token,
            expire_seconds=settings.IMPORT_EXPIRE_SECONDS,
            mode=mode,
            columns=[
                ImportColumnDetail(key=column.key, label=labels[column.key], required=column.required)
                for column in spec.columns
            ],
            total=len(rows),
            valid=len(valid),
            to_create=sum(1 for row in valid if row.action == 'create'),
            to_update=sum(1 for row in valid if row.action == 'update'),
            rows=[
                ImportPreviewRow(row_no=row.row_no, values=row.raw, ok=row.ok, action=row.action, errors=row.errors)
                for row in rows
            ],
            ignored_headers=data.ignored_headers,
            empty_rows=data.empty_rows,
            has_report=bool(invalid),
        )

    # ─────────────────────────────── 提交 ───────────────────────────────

    @staticmethod
    async def commit(
        *,
        db: AsyncSession,
        spec: ImportSpec,
        user: Any,
        obj: ImportCommitParam,
        background_tasks: Any = None,
    ) -> ImportCommitDetail:
        """
        按预览留下的令牌落库

        :param db: 数据库会话（**不带**自动事务：全有或全无要能整批回滚）
        """
        cached = await redis_client.get(_key(obj.import_token))
        if not cached:
            raise errors.RequestError(msg=t('error.import.token_expired'))
        data = msgspec.json.decode(cached)
        # 不是这个人 / 不是这个资源的令牌：和过期说同一句话，不告诉对方「这个令牌存在」
        if data['resource'] != spec.resource or data['user_id'] != str(user.id):
            raise errors.RequestError(msg=t('error.import.token_expired'))
        # 🔴 抢占：只有 GETDEL 拿到值的那一次才执行。先读后删不是原子的 ——
        # 双击、网络重试、两个标签页会把同一批写两遍（第二次撞唯一约束时第一批早就进去了）
        if await redis_client.getdel(_key(obj.import_token)) is None:
            raise errors.RequestError(msg=t('error.import.token_expired'))

        excluded = set(obj.exclude_rows)
        rows = [
            ImportRow(
                row_no=item['row_no'],
                values=item['values'],
                raw=item['raw'],
                action=item['action'],
                target_id=int(item['target_id']) if item['target_id'] is not None else None,
                payload=item['payload'],
            )
            for item in data['rows']
            if item['row_no'] not in excluded
        ]
        if not rows:
            raise errors.RequestError(msg=t('error.import.nothing_to_commit'))

        # 预览到提交之间库里可能变了：同一份校验再跑一遍，这时候才冒出来的问题记成失败
        ctx = ImportContext(user=user, background_tasks=background_tasks)
        await spec.validate(db, rows, data['mode'], ctx)
        failed: dict[int, str] = {
            row.row_no: t('import.error_separator').join(row.errors) for row in rows if not row.ok
        }
        writable = [row for row in rows if row.ok]

        if obj.atomic and failed:
            await db.rollback()
            return await ImportService._result(obj.import_token, spec, user, rows, failed, committed=False)

        outcome = await spec.commit(db, writable, ctx) if writable else None
        if outcome is not None:
            failed.update(outcome.failed)
        if obj.atomic and failed:
            await db.rollback()
            return await ImportService._result(obj.import_token, spec, user, rows, failed, committed=False)
        await db.commit()
        await ctx.run_after_commit()
        return await ImportService._result(obj.import_token, spec, user, rows, failed, committed=True, outcome=outcome)

    @staticmethod
    async def _result(
        token: str,
        spec: ImportSpec,
        user: Any,
        rows: list[ImportRow],
        failed: dict[int, str],
        *,
        committed: bool,
        outcome: Any = None,
    ) -> ImportCommitDetail:
        if failed:
            by_no = {row.row_no: row for row in rows}
            await ImportService._save_report(
                token,
                spec,
                user,
                [(row_no, by_no[row_no].raw, [msg]) for row_no, msg in sorted(failed.items())],
                append=True,
            )
        return ImportCommitDetail(
            committed=committed,
            created=list(outcome.created) if committed and outcome else [],
            updated=list(outcome.updated) if committed and outcome else [],
            failed=[ImportRowError(row_no=row_no, msg=msg) for row_no, msg in sorted(failed.items())],
            notes=list(outcome.notes) if committed and outcome else [],
            has_report=await redis_client.exists(_report_key(token)) > 0,
        )

    # ─────────────────────────────── 错误报告 ───────────────────────────────

    @staticmethod
    async def _save_report(
        token: str, spec: ImportSpec, user: Any, rows: list[tuple[int, dict, list[str]]], *, append: bool = False
    ) -> None:
        """有问题的行留一份（原样的单元格 + 原因），和令牌同寿命。提交之后令牌没了，报告还在"""
        if not rows:
            return
        key = _report_key(token)
        entries = [{'row_no': row_no, 'raw': raw, 'errors': problems} for row_no, raw, problems in rows]
        if append:
            existing = await redis_client.get(key)
            if existing:
                entries = msgspec.json.decode(existing)['rows'] + entries
        await redis_client.set(
            key,
            msgspec.json.encode({
                'resource': spec.resource,
                'user_id': str(user.id),
                'language': i18n.current_language,
                'rows': entries,
            }),
            ex=settings.IMPORT_EXPIRE_SECONDS,
        )

    @staticmethod
    async def report(*, user: Any, token: str) -> tuple[bytes, str]:
        """错误报告：(xlsx 字节, 文件名)。不是自己的令牌和过期一样说「找不到」"""
        cached = await redis_client.get(_report_key(token))
        if not cached:
            raise errors.NotFoundError(msg=t('error.import.report_expired'))
        data = msgspec.json.decode(cached)
        if data['user_id'] != str(user.id):
            raise errors.NotFoundError(msg=t('error.import.report_expired'))
        spec = get_import(data['resource'])
        if spec is None:
            raise errors.NotFoundError(msg=t('error.import.report_expired'))

        with i18n.use_language(data.get('language')):
            return await anyio.to_thread.run_sync(_render_report, spec, data['rows'])


def _render_report(spec: ImportSpec, rows: list[dict]) -> tuple[bytes, str]:
    """原样的列 + 行号 + 原因。表头和模板一样，所以改完能直接再导（多出来的两列会被当成未识别的表头忽略）"""
    columns = [SheetColumn(title=t(column.label), width=column.width) for column in spec.columns]
    columns += [
        SheetColumn(title=t('import.report.row_no'), width=8),
        SheetColumn(title=t('import.report.errors'), width=60),
    ]
    fd, raw_path = tempfile.mkstemp(prefix='fba-import-report-', suffix='.xlsx')
    os.close(fd)
    path = Path(raw_path)
    try:
        writer = XlsxSheetWriter(
            path,
            sheet_title=t('import.report.sheet'),
            columns=columns,
            expected_rows=len(rows),
            info_title=t('import.report.sheet'),
        )
        for row in sorted(rows, key=operator.itemgetter('row_no')):
            cells = [text_cell((row['raw'] or {}).get(column.key)) for column in spec.columns]
            cells += [int_cell(row['row_no']), text_cell(t('import.error_separator').join(row['errors']))]
            writer.append(cells)
        writer.close()
        content = path.read_bytes()
    finally:
        with contextlib.suppress(OSError):
            path.unlink()
    stamp = timezone.now().strftime('%Y%m%d-%H%M%S')
    return content, t('import.report.file_name', resource=t(spec.label), stamp=stamp)


import_service: ImportService = ImportService()

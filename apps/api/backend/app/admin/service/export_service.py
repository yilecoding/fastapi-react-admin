"""导出（#11 · v0.4）。

一次导出两步：

1. **发起**（`start`，在请求里）：校验参数 → 按**当前用户的数据范围**数一遍 → 为空 / 超限直接拒 →
   落一条记录 → 行数不超过 `EXPORT_SYNC_MAX_ROWS` 就当场生成，否则交给 Celery
2. **执行**（`execute`，请求里和 worker 里是同一份代码）：抢任务 → 以**发起人的身份**分批取数 →
   边取边写临时文件 → 传到存储 → 记录改成完成 / 失败

几条硬规矩，每条都对应一个不这么做就静默出错的后果：

- 🔴 **执行时显式锚定发起人**（`scoped_to_user`）。worker 里没有请求，数据范围的 ContextVar 是空的，
  而空 = 不过滤（`common/security/data_scope.py`）：一个只能看本部门的人发起的大批量导出，
  在 worker 里会查回全库，不报错，文件照样生成
- 🔴 **执行前按发起人现在的状态再核一次权限**：排队期间账号被停用、导出权限被收回，任务不该照跑
- 🔴 **快照上界**：发起时记下 `max(id)`，执行只取 `id <= max_id`。数出来 1,200 行就导这 1,200 行，
  中间新进来的不算 —— 否则「超过上限就拒绝」只在发起那一刻成立
- 🔴 **文件只有发起人能下载**，不进 `sys_file`（理由见 `model/export_job.py`）
- **失败一律落成「失败 + 原因」**，不留在「生成中」：界面上永远转圈和「这个功能坏了」分不开（硬纪律 9）
"""

import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import tempfile

from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anyio

from pydantic import ValidationError
from sqlalchemy import Select, func, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from backend.app.admin.crud.crud_export_job import export_job_dao
from backend.app.admin.crud.crud_storage import storage_dao
from backend.app.admin.model import ExportJob
from backend.app.admin.schema.export_job import StartExportParam
from backend.app.admin.service.storage_service import storage_service
from backend.common.dataio.exporting import ExportColumn, ExportSpec, RenderContext, get_export
from backend.common.dataio.writers import MEDIA_TYPES, CsvSheetWriter, SheetColumn, SheetWriter, XlsxSheetWriter
from backend.common.enums import ExportJobStatus, StatusType
from backend.common.exception import errors
from backend.common.i18n import i18n, t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.common.security.data_scope import scoped_to_user
from backend.common.security.jwt import get_jwt_user
from backend.common.security.rbac import user_can_write, user_has_perm
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.utils.storage_ops import (
    StorageError,
    StorageTarget,
    builtin_target,
    delete_object,
    stat_size,
    write_stream,
)
from backend.utils.timezone import timezone

#: 文件名里不能出现的字符（Windows 最严）。资源名来自翻译文案，理论上干净，这里是第二道
_FILENAME_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


class ExportFailedError(Exception):
    """预期内的失败：原因已经按发起人的语言翻好，原样给用户看"""

    def __init__(self, msg: str) -> None:
        super().__init__(msg)
        self.msg = msg


def _stale_before() -> dt.datetime:
    """早于这个时间还没结束的任务视为死掉了：后台任务的超时（`with_timeout`）再留 5 分钟余量"""
    return timezone.now() - dt.timedelta(seconds=settings.CELERY_TASK_TIME_LIMIT + 300)


def _user_tz(user: Any) -> dt.tzinfo:
    """导出人的**显示时区**。存的值写入时校验过是合法 IANA 标识，这里仍然兜一下 —— 兜不住就是整个导出失败"""
    try:
        return ZoneInfo(getattr(user, 'timezone', None) or settings.DATETIME_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.tz_info


def _file_name(title: str, fmt: str, tz: dt.tzinfo) -> str:
    stamp = timezone.now().astimezone(tz).strftime('%Y%m%d-%H%M%S')
    safe = _FILENAME_ILLEGAL.sub('_', title).strip(' .') or 'export'
    return f'{safe}_{stamp}.{fmt}'


def _restrict_ids(stmt: Select, spec: ExportSpec, ids: Sequence[int] | None) -> Select:
    return stmt.where(spec.id_column.in_(list(ids))) if ids else stmt


async def _count(db: AsyncSession, stmt: Select, id_column: Any) -> tuple[int, int | None]:
    """按列表那条查询数行数、取最大 ID。

    `with_only_columns(..., maintain_column_froms=True)` 保留原查询的 FROM / JOIN / WHERE（含数据范围条件），
    只把选的列换掉。不用 `count(*) from (子查询)`：带 join 的查询做子查询时两张表的 `id` 列会撞名
    """
    counted = stmt.order_by(None).with_only_columns(
        func.count(id_column), func.max(id_column), maintain_column_froms=True
    )
    total, max_id = (await db.execute(counted)).one()
    return int(total or 0), (int(max_id) if max_id is not None else None)


def _parse_filters(spec: ExportSpec, raw: dict[str, Any]) -> Any:
    """筛选参数按定义校验。

    🔴 定义里的筛选模型是 `extra='forbid'`：不认识的参数**报错**而不是忽略。忽略的话，
    前端把 `username` 拼成 `user_name`，这个条件就静默消失 —— 导出的是全表，
    而用户以为导出的是筛过的那批（同 AI 分册「筛选参数要对齐三层」那个物种）
    """
    try:
        return spec.filters.model_validate(raw or {})
    except ValidationError as e:
        first = e.errors()[0]
        field = '.'.join(str(part) for part in first.get('loc', ())) or '-'
        raise errors.RequestError(msg=t('error.export.bad_filter', field=field)) from e


class ExportService:
    """导出服务"""

    # ─────────────────────────────── 发起 ───────────────────────────────

    @staticmethod
    async def start(*, db: AsyncSession, request: Request, spec: ExportSpec, obj: StartExportParam) -> ExportJob:
        """
        发起一次导出。小批量当场生成完再返回，大批量返回「排队」

        :param db: 数据库会话（不带事务的那种：要在投递 Celery 之前先把记录提交出去）
        :param request: 请求
        :param spec: 导出定义
        :param obj: 导出参数
        :return:
        """
        user = request.user
        filters = _parse_filters(spec, obj.filters)
        columns = spec.pick_columns(obj.columns)

        if await export_job_dao.count_active(db, user.id) >= settings.EXPORT_MAX_CONCURRENT_PER_USER:
            raise errors.RequestError(
                msg=t('error.export.too_many_running', limit=settings.EXPORT_MAX_CONCURRENT_PER_USER)
            )

        # 数行数用的是**请求里**的数据范围（JWT 中间件设好的），和列表接口一模一样
        stmt = _restrict_ids(await spec.select(filters, user), spec, obj.ids)
        total, max_id = await _count(db, stmt, spec.id_column)
        limit = spec.max_rows or settings.EXPORT_MAX_ROWS
        if total == 0 or max_id is None:
            raise errors.RequestError(msg=t('error.export.empty'))
        if total > limit:
            raise errors.RequestError(msg=t('error.export.too_many_rows', total=f'{total:,}', limit=f'{limit:,}'))

        title = t(spec.label)
        params = {
            'filters': filters.model_dump(mode='json', exclude_none=True),
            'columns': [column.key for column in columns],
            'ids': [str(pk) for pk in obj.ids] if obj.ids else None,
            'max_id': str(max_id),
        }
        job = ExportJob(
            resource=spec.resource,
            title=title[:128],
            format=obj.format,
            params=json.dumps(params, ensure_ascii=False),
            language=i18n.current_language,
            created_by=user.id,
            total=total,
            file_name=_file_name(title, obj.format, _user_tz(user)),
        )
        db.add(job)
        await db.commit()
        job_id = job.id

        if total <= settings.EXPORT_SYNC_MAX_ROWS:
            await ExportService.execute(job_id)
        else:
            await ExportService._enqueue(db, job_id)

        # `execute` 用的是自己的会话，这里重新读一遍拿最终状态
        await db.refresh(job)
        return job

    @staticmethod
    async def _enqueue(db: AsyncSession, job_id: int) -> None:
        """投给 Celery。投不出去（broker 挂了）当场记成失败，而不是留一条永远「排队」的记录"""
        from backend.app.task.celery import celery_app

        try:
            result = celery_app.send_task('export.run', args=[str(job_id)])
        except Exception as e:
            log.error(f'导出任务 {job_id} 投递失败：{e!s}')
            await db.execute(
                update(ExportJob)
                .where(ExportJob.id == job_id)
                .values(
                    status=ExportJobStatus.failed.value,
                    error=t('error.export.queue_unavailable'),
                    finished_time=timezone.now(),
                )
            )
            await db.commit()
            return
        await db.execute(update(ExportJob).where(ExportJob.id == job_id).values(task_id=result.id))
        await db.commit()

    # ─────────────────────────────── 执行 ───────────────────────────────

    @staticmethod
    async def execute(job_id: int) -> ExportJob | None:
        """
        生成一份导出。请求里的小批量和 worker 里的大批量都走这里

        :param job_id: 导出记录 ID
        :return: 结束后的记录；没抢到（别的 worker 在做 / 已经结束）返回 None
        """
        async with async_db_session() as db:
            claimed = await export_job_dao.claim(db, job_id, stale_before=_stale_before())
            await db.commit()
            if not claimed:
                return None
            job = await export_job_dao.get(db, job_id)
        if job is None:
            return None

        tmp_path: Path | None = None
        with i18n.use_language(job.language):
            try:
                spec = get_export(job.resource)
                if spec is None:
                    raise ExportFailedError(t('error.export.resource_unavailable'))
                user = await ExportService._executor(job.created_by, spec)
                tmp_path, row_count = await ExportService._generate(job, spec, user)
                storage_id, object_key, size, sha256 = await ExportService._store(job, tmp_path)
            except ExportFailedError as e:
                await ExportService._fail(job_id, e.msg)
            except Exception as e:
                log.exception(f'导出任务 {job_id} 失败：{e!s}')
                await ExportService._fail(job_id, t('error.export.unexpected'))
            else:
                async with async_db_session() as db:
                    now = timezone.now()
                    await db.execute(
                        update(ExportJob)
                        .where(ExportJob.id == job_id)
                        .values(
                            status=ExportJobStatus.succeeded.value,
                            row_count=row_count,
                            file_size=size,
                            file_sha256=sha256,
                            storage_id=storage_id,
                            object_key=object_key,
                            finished_time=now,
                            expire_time=now + dt.timedelta(hours=settings.EXPORT_FILE_RETENTION_HOURS),
                            error=None,
                        )
                    )
                    await db.commit()
            finally:
                if tmp_path is not None:
                    with contextlib.suppress(OSError):
                        await anyio.Path(tmp_path).unlink(missing_ok=True)

        async with async_db_session() as db:
            return await export_job_dao.get(db, job_id)

    @staticmethod
    async def _executor(user_id: int, spec: ExportSpec) -> Any:
        """以谁的身份导：发起人**现在**的样子。

        `get_jwt_user` 和 JWT 鉴权是同一份用户快照（停用 / 改角色时会被清掉重建），
        所以这里看到的权限就是他此刻在网页上的权限
        """
        try:
            user = await get_jwt_user(user_id)
        except errors.BaseExceptionError as e:
            raise ExportFailedError(t('error.export.user_unavailable')) from e
        if user.status != StatusType.enable:
            raise ExportFailedError(t('error.export.user_unavailable'))
        if not user_can_write(user) or not user_has_perm(user, spec.perm):
            raise ExportFailedError(t('error.export.permission_revoked'))
        return user

    @staticmethod
    async def _generate(job: ExportJob, spec: ExportSpec, user: Any) -> tuple[Path, int]:
        """取数 + 写临时文件。返回 (文件路径, 写了多少行)"""
        params = json.loads(job.params)
        filters = spec.filters.model_validate(params.get('filters') or {})
        columns: list[ExportColumn] = spec.pick_columns(params.get('columns'))
        ids = [int(pk) for pk in params['ids']] if params.get('ids') else None
        max_id = int(params['max_id'])
        limit = spec.max_rows or settings.EXPORT_MAX_ROWS
        tz = _user_tz(user)
        ctx = RenderContext.current(tz)

        fd, raw_path = tempfile.mkstemp(prefix='fba-export-', suffix=f'.{job.format}')
        os.close(fd)
        path = Path(raw_path)
        writer = ExportService._open_writer(job, spec, user, columns, path, tz, params)

        written = 0
        try:
            # 🔴 整段取数都在发起人的数据范围里：`spec.select()` 造出来的 Select 带不带范围条件，
            # 取决于**造它的那一刻** ContextVar 里是谁（`DataScopedCRUD._data_scope_condition`）
            with scoped_to_user(user):
                async with async_db_session() as db:
                    stmt = _restrict_ids(await spec.select(filters, user), spec, ids)
                    held: list[dict[str, Any]] = []
                    async for batch in _keyset_batches(db, stmt, spec, max_id=max_id):
                        written += len(batch)
                        if written > limit:
                            # 快照上界之下的行数只会变少；真走到这里说明定义的取数和计数不是同一条查询
                            raise ExportFailedError(
                                t('error.export.too_many_rows', total=f'{written:,}+', limit=f'{limit:,}')
                            )
                        if spec.reorder is not None:
                            held.extend(batch)
                            continue
                        await _write_batch(writer, columns, batch, ctx)
                        # 进度：每批落一次「已写多少行」，记录页 / 导出按钮拿它画进度条
                        await db.execute(update(ExportJob).where(ExportJob.id == job.id).values(row_count=written))
                        await db.commit()
                    if spec.reorder is not None:
                        await _write_batch(writer, columns, spec.reorder(held), ctx)
            await anyio.to_thread.run_sync(writer.close)
        except BaseException:
            with contextlib.suppress(Exception):
                writer.close()
            with contextlib.suppress(OSError):
                await anyio.Path(path).unlink(missing_ok=True)
            raise
        return path, written

    @staticmethod
    def _open_writer(
        job: ExportJob,
        spec: ExportSpec,
        user: Any,
        columns: list[ExportColumn],
        path: Path,
        tz: dt.tzinfo,
        params: dict[str, Any],
    ) -> SheetWriter:
        sheet_columns = [SheetColumn(title=t(column.label), width=column.width) for column in columns]
        if job.format == 'csv':
            return CsvSheetWriter(path, columns=sheet_columns)
        return XlsxSheetWriter(
            path,
            sheet_title=job.title,
            columns=sheet_columns,
            expected_rows=job.total,
            info_title=t('export.info.sheet'),
            info=_info_rows(job, spec, user, tz, params),
            creator=user.username,
            doc_title=job.title,
        )

    @staticmethod
    async def _store(job: ExportJob, path: Path) -> tuple[int | None, str, int, str]:
        """传到当前默认存储的私有子树，返回 (存储, key, 字节数, SHA-256)。

        key 按记录 ID 定死 —— 同一个任务重跑是覆盖，不会多出一个孤儿对象
        """
        async with async_db_session() as db:
            target = await storage_service.upload_target(db=db, public=False)
        created = job.created_time.astimezone(timezone.tz_info)
        key = f'exports/{created:%Y/%m/%d}/{job.id}.{job.format}'
        digest = hashlib.sha256()
        try:
            await write_stream(
                target, key, _read_chunks(path, digest), content_type=MEDIA_TYPES[job.format].split(';')[0]
            )
        except StorageError as e:
            # 存储层只给稳定标识（上游原文只进日志，见 storage_ops._reason），翻成「测试连接」那套人话
            raise ExportFailedError(
                t('error.export.storage_failed', reason=t(f'error.storage.probe_{e.reason}'))
            ) from e
        return target.storage_id, key, (await anyio.Path(path).stat()).st_size, digest.hexdigest()

    @staticmethod
    async def _fail(job_id: int, msg: str) -> None:
        async with async_db_session() as db:
            await db.execute(
                update(ExportJob)
                .where(ExportJob.id == job_id)
                .values(status=ExportJobStatus.failed.value, error=msg, finished_time=timezone.now())
            )
            await db.commit()

    # ─────────────────────────────── 记录 ───────────────────────────────

    @staticmethod
    async def get_list(*, db: AsyncSession, user_id: int, status: int | None) -> dict[str, Any]:
        """我的导出记录。顺手把卡住的那几条结掉 —— 不然它们在界面上永远是「生成中」"""
        await ExportService.settle_stale(db=db, user_id=user_id)
        return await paging_data(db, await export_job_dao.get_select_mine(user_id, status))

    @staticmethod
    async def get(*, db: AsyncSession, user_id: int, pk: int) -> ExportJob:
        """一条记录。🔴 不是自己的一律 404，不是 403：403 等于告诉对方「这个 ID 存在」"""
        job = await export_job_dao.get_mine(db, pk, user_id)
        if job is None:
            raise errors.NotFoundError(msg=t('error.export.not_found'))
        return job

    @staticmethod
    async def download(*, db: AsyncSession, user_id: int, pk: int) -> tuple[ExportJob, StorageTarget, int]:
        """拿到能下载的文件：(记录, 存储, 字节数)"""
        job = await ExportService.get(db=db, user_id=user_id, pk=pk)
        if job.status == ExportJobStatus.expired.value or (
            job.status == ExportJobStatus.succeeded.value and job.expire_time and job.expire_time < timezone.now()
        ):
            raise errors.RequestError(msg=t('error.export.expired'))
        if job.status != ExportJobStatus.succeeded.value or not job.object_key:
            raise errors.RequestError(msg=t('error.export.not_ready'))
        target = await ExportService._target(db, job.storage_id)
        try:
            size = await stat_size(target, job.object_key)
        except StorageError as e:
            log.warning(f'导出记录 {job.id} 的文件读不到：{e.reason}')
            raise errors.NotFoundError(msg=t('error.export.file_missing')) from e
        await db.execute(
            update(ExportJob).where(ExportJob.id == job.id).values(download_count=ExportJob.download_count + 1)
        )
        await db.commit()
        return job, target, size

    @staticmethod
    async def delete(*, db: AsyncSession, user_id: int, pk: int) -> None:
        """删自己的一条记录（连文件）。生成中的不让删：worker 写完会发现记录没了，文件就成了孤儿"""
        job = await ExportService.get(db=db, user_id=user_id, pk=pk)
        if job.status in {ExportJobStatus.pending.value, ExportJobStatus.running.value}:
            raise errors.RequestError(msg=t('error.export.still_running'))
        if job.object_key and job.status == ExportJobStatus.succeeded.value:
            with contextlib.suppress(errors.BaseExceptionError):
                await delete_object(await ExportService._target(db, job.storage_id), job.object_key)
        await export_job_dao.delete_by_ids(db, [job.id])
        await db.commit()

    @staticmethod
    async def settle_stale(*, db: AsyncSession, user_id: int | None = None) -> int:
        """卡住的任务记成失败（原因按各自发起时的语言写）"""
        stale = await export_job_dao.get_stale(db, stale_before=_stale_before(), user_id=user_id)
        for job in stale:
            with i18n.use_language(job.language):
                msg = t('error.export.timeout')
            await db.execute(
                update(ExportJob)
                .where(ExportJob.id == job.id, ExportJob.status == job.status)
                .values(status=ExportJobStatus.failed.value, error=msg, finished_time=timezone.now())
            )
        if stale:
            await db.commit()
        return len(stale)

    @staticmethod
    async def purge(*, db: AsyncSession, batch: int = 200) -> dict[str, int]:
        """定时清理：过期文件删掉（记录改成「已过期」）· 卡住的结掉 · 过了保留期的记录删掉"""
        now = timezone.now()
        expired = 0
        after_id = 0
        while True:
            jobs = await export_job_dao.get_expired_batch(db, now=now, after_id=after_id, limit=batch)
            if not jobs:
                break
            for job in jobs:
                if job.object_key:
                    try:
                        target = await ExportService._target(db, job.storage_id)
                    except errors.BaseExceptionError:
                        # 存储都没了，对象不可能再读到，记录照样改成过期
                        target = None
                    if target is not None:
                        await delete_object(target, job.object_key)
                await db.execute(
                    update(ExportJob).where(ExportJob.id == job.id).values(status=ExportJobStatus.expired.value)
                )
                expired += 1
            after_id = jobs[-1].id
            await db.commit()

        settled = await ExportService.settle_stale(db=db)

        removed = 0
        before = now - dt.timedelta(days=settings.EXPORT_RECORD_RETENTION_DAYS)
        while ids := await export_job_dao.get_old_ids(db, before=before, limit=batch):
            removed += await export_job_dao.delete_by_ids(db, ids)
            await db.commit()
        return {'expired': expired, 'settled': settled, 'removed': removed}

    @staticmethod
    async def _target(db: AsyncSession, storage_id: int | None) -> StorageTarget:
        if storage_id is None:
            return builtin_target(public=False)
        storage = await storage_dao.get(db, storage_id)
        if storage is None:
            raise errors.NotFoundError(msg=t('error.export.file_missing'))
        return storage_service.row_target(storage, public=False)


def _append_rows(writer: SheetWriter, rows: list[list[Any]]) -> None:
    for cells in rows:
        writer.append(cells)


async def _write_batch(
    writer: SheetWriter, columns: list[ExportColumn], batch: list[dict[str, Any]], ctx: RenderContext
) -> None:
    rows = [[column.render(row, ctx) for column in columns] for row in batch]
    # 写 XML / CSV 是纯 CPU 活儿，放线程里，别占着事件循环
    # （worker 里所有任务共用一个循环；请求里更是所有人的请求）
    await anyio.to_thread.run_sync(_append_rows, writer, rows)


async def _read_chunks(path: Path, digest: Any) -> AsyncIterator[bytes]:
    async with await anyio.open_file(path, 'rb') as f:
        while chunk := await f.read(1024 * 1024):
            digest.update(chunk)
            yield chunk


async def _keyset_batches(
    db: AsyncSession, stmt: Select, spec: ExportSpec, *, max_id: int
) -> AsyncIterator[list[dict[str, Any]]]:
    """按主键倒序分批取（和列表的默认顺序一致：新的在前）。

    不用 OFFSET：越往后越慢，而且两批之间有行被删时会漏行 / 重行。
    每批取完由定义的 `shape` 整理成 dict（补 join 的部门、补角色……），游标取整理后的 `id`
    """
    id_column = spec.id_column
    base = stmt.order_by(None)
    last: int | None = None
    while True:
        bound = id_column <= max_id if last is None else id_column < last
        page = base.where(bound).order_by(id_column.desc()).limit(settings.EXPORT_BATCH_SIZE)
        raw = (await db.execute(page)).all()
        if not raw:
            return
        rows = await spec.shape(db, raw)
        if not rows:
            return
        yield rows
        last = int(rows[-1]['id'])
        if len(raw) < settings.EXPORT_BATCH_SIZE:
            return


def _info_rows(
    job: ExportJob, spec: ExportSpec, user: Any, tz: dt.tzinfo, params: dict[str, Any]
) -> list[tuple[str, str]]:
    """「导出信息」表：谁、什么时候、按什么条件、导了多少行。文件流出去之后，凭它能追到是谁导的"""
    filters = params.get('filters') or {}
    if filters:
        conditions = '\n'.join(
            f'{t(spec.filter_labels[key]) if key in spec.filter_labels else key}: {value}'
            for key, value in filters.items()
        )
    else:
        conditions = t('export.info.no_filter')
    if params.get('ids'):
        conditions = t('export.info.selected_rows', n=len(params['ids']))
    who = f'{user.nickname} ({user.username})' if getattr(user, 'nickname', None) else user.username
    exported_at = timezone.now().astimezone(tz).strftime('%Y-%m-%d %H:%M:%S')
    return [
        (t('export.info.resource'), job.title),
        (t('export.info.exporter'), who),
        (t('export.info.exported_at'), f'{exported_at} ({getattr(tz, "key", str(tz))})'),
        (t('export.info.filters'), conditions),
        (t('export.info.rows'), f'{job.total:,}'),
        (t('export.info.timezone_note'), t('export.info.timezone_value', tz=getattr(tz, 'key', str(tz)))),
    ]


export_service: ExportService = ExportService()

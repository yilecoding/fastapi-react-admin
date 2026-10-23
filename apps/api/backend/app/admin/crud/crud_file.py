from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import File, FileRelation
from backend.common.security.data_scope import DataScopedCRUD
from backend.utils.timezone import timezone


class CRUDFile(DataScopedCRUD[File]):
    """文件数据库操作类"""

    async def get(self, db: AsyncSession, pk: int) -> File | None:
        """
        获取文件

        :param db: 数据库会话
        :param pk: 文件 ID
        :return:
        """
        return await self.select_model(db, pk, deleted=0)

    async def get_by_ids(self, db: AsyncSession, pks: list[int]) -> Sequence[File]:
        """
        按 ID 批量获取文件

        :param db: 数据库会话
        :param pks: 文件 ID 列表
        :return:
        """
        if not pks:
            return []
        return await self.select_models(db, id__in=pks, deleted=0)

    async def get_by_sha256(
        self,
        db: AsyncSession,
        sha256: str,
        created_by: int,
        original_name: str | None = None,
        *,
        is_public: bool = False,
        storage_id: int | None = None,
    ) -> File | None:
        """
        按内容校验和获取**同一上传人**的文件，用于秒传探测

        限定 `created_by` 是刻意的：跨用户命中会让 A 通过「上传一个自己已知的文件」
        探测出 B 传过什么，是个信息泄露面。同一个人重复传同一份文件才走秒传。

        `original_name` 也进 key —— 只按内容去重会**丢掉用户起的名字**：
        把 `sample.docx` 改名成 `季度报告.docx` 再传，会命中旧记录、
        列表里依然显示 `sample.docx`，按新名字还搜不到（实测踩到）。
        同内容不同名视为两条记录，各自可独立删除，所以磁盘上也各存一份。

        🔴 `is_public` **必须**进 key，两个方向都会坏：

        - 命中私有旧记录去满足公开请求 → 那条记录的 `public_url` 是 `None`，
          富文本里就是一张裂图，而且「同一张图第一次传好的、第二次裂」这种
          偶发症状极难排查
        - 命中公开旧记录去满足私有请求 → 一份本该私有的文件被静默地
          按公开直链下发了。**这个方向是安全问题，不是显示问题**

        :param db: 数据库会话
        :param sha256: 文件内容 SHA-256
        :param created_by: 上传人 ID
        :param original_name: 原始文件名；传 None 表示只按内容匹配（/check 探测用）
        :param is_public: 只在同一棵子树里匹配
        :param storage_id: 只在同一个存储里匹配（None = 内置本地存储）
        :return:
        """
        conditions = [
            self.model.sha256 == sha256,
            self.model.created_by == created_by,
            self.model.is_public == is_public,
            # 🔴 只在**同一个存储**里复用：跨存储命中会让新记录指向别的存储里的对象，
            # 那个存储一删，这边就跟着 404。NULL（内置存储）必须写成 IS NULL，`= NULL` 永远不成立
            self.model.storage_id.is_(None) if storage_id is None else self.model.storage_id == storage_id,
            self.model.deleted == 0,
        ]
        if original_name is not None:
            conditions.append(self.model.original_name == original_name)
        stmt = select(self.model).where(*self._scoped(tuple(conditions))).order_by(self.model.id).limit(1)
        result = await db.execute(stmt)
        return result.scalars().first()

    async def get_select(
        self,
        name: str | None,
        type: str | None,
        ext: str | None,
        created_by: int | None,
        start_time: str | None,
        end_time: str | None,
    ) -> Select:
        """
        获取文件列表查询表达式

        :param name: 原始文件名（模糊）
        :param type: 文件分类
        :param ext: 扩展名
        :param created_by: 上传人 ID
        :param start_time: 上传时间起
        :param end_time: 上传时间止
        :return:
        """
        filters = {'deleted': 0}

        if name is not None:
            filters['original_name__like'] = f'%{name}%'
        if type is not None:
            filters['type'] = type
        if ext is not None:
            filters['ext'] = ext.lower().lstrip('.')
        if created_by is not None:
            filters['created_by'] = created_by
        if start_time is not None:
            filters['created_time__ge'] = start_time
        if end_time is not None:
            filters['created_time__le'] = end_time

        return await self.select_order('created_time', 'desc', **filters)

    async def create(self, db: AsyncSession, obj: dict) -> File:
        """
        创建文件记录

        用 dict 而不是 pydantic 参数模型：入参不是客户端提交的 body，
        而是 service 层从落盘结果（`SavedFile`）组装出来的，没有可校验的外部输入。

        :param db: 数据库会话
        :param obj: 文件字段
        :return:
        """
        file = self.model(**obj)
        db.add(file)
        await db.flush()
        return file

    async def delete(self, db: AsyncSession, pks: list[int], *, at: datetime | None = None) -> int:
        """
        批量逻辑删除文件（进回收站，或者在关掉回收站时紧接着被标成已清除）

        :param db: 数据库会话
        :param pks: 文件 ID 列表
        :param at: 删除时间。🔴 要和 `file_relation_dao.delete_by_file_ids` 传**同一个值** ——
            还原时靠「关联的 deleted_time == 文件的 deleted_time」认出哪些关联是这一次删除连带解开的
        :return:
        """
        return await self.delete_model_by_column(
            db,
            allow_multiple=True,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=at or timezone.now(),
            id__in=pks,
            deleted=0,
        )

    def _recycled(self) -> tuple:
        """「在回收站里」：删了、但对象还没清除"""
        return (self.model.deleted != 0, self.model.purged_time.is_(None))

    async def get_recycled_select(self, name: str | None) -> Select:
        """
        回收站列表（最近删的在前）。按数据范围过滤 —— 同正常列表，看不见的文件在回收站里也看不见

        :param name: 原始文件名（模糊）
        :return:
        """
        conditions = [*self._recycled()]
        if name:
            conditions.append(self.model.original_name.like(f'%{name}%'))
        stmt = await self.select(*conditions)
        # SQL Server 的 OFFSET FETCH 强制要求 ORDER BY；id 兜底保证翻页稳定
        return stmt.order_by(self.model.deleted_time.desc(), self.model.id.desc())

    async def get_recycled_by_ids(self, db: AsyncSession, pks: list[int]) -> Sequence[File]:
        """
        按 ID 取回收站里的文件（按数据范围过滤：还原 / 彻底删除只能动看得见的）

        :param db: 数据库会话
        :param pks: 文件 ID 列表
        :return:
        """
        if not pks:
            return []
        stmt = select(self.model).where(*self._scoped((*self._recycled(), self.model.id.in_(pks))))
        return (await db.execute(stmt)).scalars().all()

    async def get_recycled_ids(
        self, db: AsyncSession, *, before: datetime | None = None, after_id: int = 0, limit: int
    ) -> Sequence[int]:
        """
        回收站里的一批 ID，给清空 / 定时清理分批用

        🔴 按 `id > after_id` 往后翻（keyset），不要每批都从头取：「从头取」只要有一行清不掉
        （它一直留在回收站里），每一批都会把它取回来 —— 死循环。变异检验踩到过：让「在回收站里」
        不看 purged_time，清空接口直接挂死到超时

        :param db: 数据库会话
        :param before: 只要这个时间之前删的（定时清理按保留期）；None = 不限
        :param after_id: 只要 ID 大于它的（上一批的最后一个）
        :param limit: 一批多少
        :return:
        """
        conditions = [*self._recycled(), self.model.id > after_id]
        if before is not None:
            conditions.append(self.model.deleted_time < before)
        stmt = select(self.model.id).where(*self._scoped(tuple(conditions))).order_by(self.model.id).limit(limit)
        return (await db.execute(stmt)).scalars().all()

    async def restore(self, db: AsyncSession, pks: list[int]) -> int:
        """
        还原：清掉删除标记。调用方要先用 `get_recycled_by_ids` 过一遍数据范围

        :param db: 数据库会话
        :param pks: 文件 ID 列表
        :return:
        """
        if not pks:
            return 0
        stmt = (
            sa.update(self.model).where(self.model.id.in_(pks), *self._recycled()).values(deleted=0, deleted_time=None)
        )
        return (await db.execute(stmt)).rowcount or 0

    async def mark_purged(self, db: AsyncSession, pks: list[int], *, at: datetime) -> int:
        """
        标成「已彻底删除」（对象由调用方去删）。只动还在回收站里的行

        :param db: 数据库会话
        :param pks: 文件 ID 列表
        :param at: 清除时间
        :return:
        """
        if not pks:
            return 0
        stmt = sa.update(self.model).where(self.model.id.in_(pks), *self._recycled()).values(purged_time=at)
        return (await db.execute(stmt)).rowcount or 0

    async def get_recycle_statistics(self, db: AsyncSession) -> sa.Row:
        """
        回收站里有几个文件、占多少字节（对象还在存储里，空间还没释放）。不按数据范围过滤，同 `get_statistics`

        :param db: 数据库会话
        :return:
        """
        stmt = select(
            sa.func.count(self.model.id).label('count'),
            sa.func.coalesce(sa.func.sum(self.model.size), 0).label('size'),
        ).where(*self._recycled())
        return (await db.execute(stmt)).one()

    async def get_statistics(self, db: AsyncSession) -> Sequence[sa.Row]:
        """
        按分类聚合文件数与占用字节数

        在库里 GROUP BY 而不是把全表捞出来在 Python 里数 ——
        文件表是会长到几十万行的，捞全表就是把内存和这个接口一起打爆。

        :param db: 数据库会话
        :return:
        """
        stmt = select(
            self.model.type,
            sa.func.count(self.model.id).label('count'),
            sa.func.coalesce(sa.func.sum(self.model.size), 0).label('size'),
        )
        stmt = stmt.where(self.model.deleted == 0).group_by(self.model.type)
        result = await db.execute(stmt)
        return result.all()

    async def get_public_by_path(self, db: AsyncSession, path: str) -> File | None:
        """
        按 key 找公开文件（`/uploads/{key}` 用，要先知道它在哪个存储才能去取）

        **不按数据范围过滤**：这条路不登录，没有「当前用户的数据范围」可言

        :param db: 数据库会话
        :param path: 相对公开子树根的 key
        :return:
        """
        stmt = (
            select(self.model)
            .where(self.model.path == path, self.model.is_public == True, self.model.deleted == 0)  # ruff: ignore[true-false-comparison]
            .order_by(self.model.id)
            .limit(1)
        )
        result = await db.execute(stmt)
        return result.scalars().first()

    async def get_storage_counts(self, db: AsyncSession) -> dict[int | None, tuple[int, int]]:
        """
        每个存储下的（正常文件数, 回收站里的文件数）（None = 内置本地存储）。存储页显示、删存储前判断都用它

        **不按数据范围过滤**（同 `get_statistics`）：「这个存储还有没有文件」是业务规则检查，
        受限用户看不见的文件也是文件 —— 过滤了就会放行删除一个还有文件的存储

        🔴 回收站里的也要算：它们的对象还在这个存储里，删了存储它们就永远还原不回来了

        :param db: 数据库会话
        :return:
        """
        in_bin = sa.case((self.model.deleted != 0, 1), else_=0)
        stmt = (
            select(
                self.model.storage_id,
                sa.func.count(self.model.id) - sa.func.sum(in_bin),
                sa.func.sum(in_bin),
            )
            .where(self.model.purged_time.is_(None))
            .group_by(self.model.storage_id)
        )
        result = await db.execute(stmt)
        return {row[0]: (int(row[1] or 0), int(row[2] or 0)) for row in result.all()}


class CRUDFileRelation(DataScopedCRUD[FileRelation]):
    """文件关联数据库操作类"""

    async def get_file_ids_by_target(self, db: AsyncSession, target_type: str, target_id: int) -> Sequence[int]:
        """
        获取某个业务对象挂着的文件 ID（按 sort 再按 id）

        :param db: 数据库会话
        :param target_type: 业务对象类型
        :param target_id: 业务对象 ID
        :return:
        """
        stmt = select(self.model.file_id).where(
            self.model.target_type == target_type,
            self.model.target_id == target_id,
            self.model.deleted == 0,
        )
        stmt = stmt.order_by(self.model.sort, self.model.id)
        result = await db.execute(stmt)
        return result.scalars().all()

    async def get_existing_file_ids(
        self, db: AsyncSession, target_type: str, target_id: int, file_ids: list[int]
    ) -> Sequence[int]:
        """
        取出这批文件里**已经**挂在该目标上的，用于挂载时跳过重复

        :param db: 数据库会话
        :param target_type: 业务对象类型
        :param target_id: 业务对象 ID
        :param file_ids: 文件 ID 列表
        :return:
        """
        if not file_ids:
            return []
        stmt = select(self.model.file_id).where(
            self.model.target_type == target_type,
            self.model.target_id == target_id,
            self.model.file_id.in_(file_ids),
            self.model.deleted == 0,
        )
        result = await db.execute(stmt)
        return result.scalars().all()

    async def get_max_sort(self, db: AsyncSession, target_type: str, target_id: int) -> int:
        """
        取该目标下当前最大的 sort，新挂的接在后面

        :param db: 数据库会话
        :param target_type: 业务对象类型
        :param target_id: 业务对象 ID
        :return:
        """
        stmt = select(sa.func.coalesce(sa.func.max(self.model.sort), -1)).where(
            self.model.target_type == target_type,
            self.model.target_id == target_id,
            self.model.deleted == 0,
        )
        return int(await db.scalar(stmt) or -1)

    async def bulk_create(self, db: AsyncSession, rows: list[dict]) -> int:
        """
        批量创建关联

        :param db: 数据库会话
        :param rows: 关联字段列表
        :return:
        """
        if not rows:
            return 0
        db.add_all([self.model(**row) for row in rows])
        await db.flush()
        return len(rows)

    async def delete_by_target(self, db: AsyncSession, target_type: str, target_id: int, file_ids: list[int]) -> int:
        """
        批量逻辑删除关联

        :param db: 数据库会话
        :param target_type: 业务对象类型
        :param target_id: 业务对象 ID
        :param file_ids: 文件 ID 列表
        :return:
        """
        if not file_ids:
            return 0
        return await self.delete_model_by_column(
            db,
            allow_multiple=True,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            target_type=target_type,
            target_id=target_id,
            file_id__in=file_ids,
            deleted=0,
        )

    async def delete_by_file_ids(self, db: AsyncSession, file_ids: list[int], *, at: datetime | None = None) -> int:
        """
        文件被删时，连带删掉它的所有关联

        不做这一步会留下指向已删文件的关联行，业务侧查附件会拿到一批空洞。

        :param db: 数据库会话
        :param file_ids: 文件 ID 列表
        :param at: 删除时间，和文件那一侧传同一个值（还原时据此认出这次删除连带解开的关联）
        :return:
        """
        if not file_ids:
            return 0
        return await self.delete_model_by_column(
            db,
            allow_multiple=True,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=at or timezone.now(),
            file_id__in=file_ids,
            deleted=0,
        )

    async def restore_removed_with(self, db: AsyncSession, file_id: int, deleted_time: datetime) -> int:
        """
        还原文件时，把**删它那一次**连带解开的关联挂回去 —— 「还原」就是撤销那一次删除。
        之前手动从附件面板「移除」的关联（删除时间不同）不动

        🔴 先查后改，不用 `UPDATE … WHERE NOT EXISTS (同表子查询)`：MySQL 不允许 UPDATE 的子查询
        引用同一张表（error 1093）。同一目标上已经有一条正常的关联时跳过 —— 唯一约束
        `(file_id, target_type, target_id, deleted)` 会让第二条 deleted=0 的行撞上

        :param db: 数据库会话
        :param file_id: 文件 ID
        :param deleted_time: 那个文件的删除时间
        :return:
        """
        rows = (
            await db.execute(
                select(self.model.id, self.model.target_type, self.model.target_id, self.model.deleted).where(
                    self.model.file_id == file_id
                )
            )
        ).all()
        alive = {(r.target_type, r.target_id) for r in rows if r.deleted == 0}
        removed = (
            await db.execute(
                select(self.model.id, self.model.target_type, self.model.target_id).where(
                    self.model.file_id == file_id,
                    self.model.deleted != 0,
                    self.model.deleted_time == deleted_time,
                )
            )
        ).all()
        ids: list[int] = []
        for r in removed:
            if (r.target_type, r.target_id) in alive:
                continue
            alive.add((r.target_type, r.target_id))
            ids.append(r.id)
        if not ids:
            return 0
        stmt = sa.update(self.model).where(self.model.id.in_(ids)).values(deleted=0, deleted_time=None)
        return (await db.execute(stmt)).rowcount or 0


file_dao: CRUDFile = CRUDFile(File)
file_relation_dao: CRUDFileRelation = CRUDFileRelation(FileRelation)

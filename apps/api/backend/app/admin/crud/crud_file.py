from collections.abc import Sequence

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
        :return:
        """
        filters = {'sha256': sha256, 'created_by': created_by, 'is_public': is_public, 'deleted': 0}
        if original_name is not None:
            filters['original_name'] = original_name
        return await self.select_model_by_column(db, **filters)

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

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        """
        批量逻辑删除文件

        :param db: 数据库会话
        :param pks: 文件 ID 列表
        :return:
        """
        return await self.delete_model_by_column(
            db,
            allow_multiple=True,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            id__in=pks,
            deleted=0,
        )

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

    async def delete_by_file_ids(self, db: AsyncSession, file_ids: list[int]) -> int:
        """
        文件被删时，连带删掉它的所有关联

        不做这一步会留下指向已删文件的关联行，业务侧查附件会拿到一批空洞。

        :param db: 数据库会话
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
            file_id__in=file_ids,
            deleted=0,
        )


file_dao: CRUDFile = CRUDFile(File)
file_relation_dao: CRUDFileRelation = CRUDFileRelation(FileRelation)

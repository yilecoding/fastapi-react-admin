from collections.abc import Sequence

from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy_crud_plus import CRUDPlus

from backend.plugin.notice.model import Notice
from backend.plugin.notice.schema.notice import CreateNoticeParam, UpdateNoticeParam
from backend.utils.timezone import timezone


class CRUDNotice(CRUDPlus[Notice]):
    """通知公告数据库操作类"""

    async def get(self, db: AsyncSession, pk: int) -> Notice | None:
        """
        获取通知公告

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return:
        """
        return await self.select_model(db, pk, deleted=0)

    async def get_select(self, title: str, type: int | None, status: int | None) -> Select:
        """
        获取通知公告列表查询表达式

        :param title: 通知公告标题
        :param type: 通知公告类型
        :param status: 通知公告状态
        :return:
        """
        filters = {'deleted': 0}

        if title is not None:
            filters['title__like'] = f'%{title}%'
        if type is not None:
            filters['type'] = type
        if status is not None:
            filters['status'] = status

        return await self.select_order('created_time', 'desc', **filters)

    async def get_all(self, db: AsyncSession) -> Sequence[Notice]:
        """
        获取所有通知公告

        :param db: 数据库会话
        :return:
        """
        return await self.select_models(db, deleted=0)

    async def create(self, db: AsyncSession, obj: CreateNoticeParam) -> Notice:
        """
        创建通知公告，返回创建出来的对象

        返回**实例**而不是 None：正文里的内联图要在保存后挂到
        `sys_file_relation` 上（`target_id` 就是这条公告的 id），
        而创建接口原来不下发 id —— 前端拿不到 id 就没法挂关联，
        于是新建公告里的图会变成谁也不认领的孤儿文件。

        ⚠️ `flush=True` 不能省。`create_model` 默认既不 flush 也不 commit，
        而 `id` 是数据库侧生成的（`id_key` → BigInteger 主键）——
        不 flush 就返回，实例的 `id` 还是 `None`，序列化响应时直接 500：
        `1 validation error: ('response','data','id') Input should be a valid integer`
        （实测踩到）。事务仍由 `CurrentSessionTransaction` 统一提交。

        :param db: 数据库会话
        :param obj: 创建通知公告参数
        :return:
        """
        return await self.create_model(db, obj, flush=True)

    async def update(self, db: AsyncSession, pk: int, obj: UpdateNoticeParam) -> int:
        """
        更新通知公告

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :param obj: 更新通知公告参数
        :return:
        """
        return await self.update_model_by_column(db, obj, id=pk, deleted=0)

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        """
        批量删除通知公告

        :param db: 数据库会话
        :param pks: 通知公告 ID 列表
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


notice_dao: CRUDNotice = CRUDNotice(Notice)

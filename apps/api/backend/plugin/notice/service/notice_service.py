from collections.abc import Sequence
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_file import file_relation_dao
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.plugin.notice.crud.crud_notice import notice_dao
from backend.plugin.notice.model import Notice
from backend.plugin.notice.schema.notice import CreateNoticeParam, DeleteNoticeParam, UpdateNoticeParam

#: 一条公告挂着两种独立的附件关系（前端 `pages/notice/api.ts` 的常量）：
#: `NOTICE` 是"附件"面板，`NOTICE_CONTENT` 是正文里的内联图。两者都要在
#: 公告删除时一并解除关联，否则 (issue #63) 已删除公告的图片仍能通过
#: `GET /sys/files/targets/{target_type}/{target_id}` 被任意登录用户查到。
_NOTICE_TARGET_TYPES = ('NOTICE', 'NOTICE_CONTENT')


class NoticeService:
    """通知公告服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Notice:
        """
        获取通知公告

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return:
        """

        notice = await notice_dao.get(db, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        return notice

    @staticmethod
    async def get_list(db: AsyncSession, title: str | None, type: int | None, status: int | None) -> dict[str, Any]:
        """
        获取通知公告列表

        :param db: 数据库会话
        :param title: 通知公告标题
        :param type: 通知公告类型
        :param status: 通知公告状态
        :return:
        """
        notice_select = await notice_dao.get_select(title, type, status)
        return await paging_data(db, notice_select)

    @staticmethod
    async def get_all(*, db: AsyncSession) -> Sequence[Notice]:
        """
        获取所有通知公告

        :param db: 数据库会话
        :return:
        """

        notices = await notice_dao.get_all(db)
        return notices

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateNoticeParam) -> Notice:
        """
        创建通知公告，返回创建出来的对象（前端要用 id 去挂正文里的内联图）

        :param db: 数据库会话
        :param obj: 创建通知公告参数
        :return:
        """

        return await notice_dao.create(db, obj)

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateNoticeParam) -> int:
        """
        更新通知公告

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :param obj: 更新通知公告参数
        :return:
        """

        notice = await notice_dao.get(db, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        count = await notice_dao.update(db, pk, obj)
        return count

    @staticmethod
    async def delete(*, db: AsyncSession, obj: DeleteNoticeParam) -> int:
        """
        批量删除通知公告

        :param db: 数据库会话
        :param obj: 通知公告 ID 列表
        :return:
        """

        count = await notice_dao.delete(db, obj.pks)
        # (issue #63) 只删公告本身不够——挂在它上面的附件/内联图关联要一并
        # 解除，否则 sys_file_relation 里留着指向已删公告的行，永久占用
        # /sys/files/statistics 的计数，且 GET /sys/files/targets/{type}/{id}
        # 不检查目标是否存在，任何登录用户仍能查到"已删除"公告的附件列表。
        # 这里只解关联、不删底层 sys_file——和现有的 detach 接口
        # （DELETE /sys/files/relations）同一套语义：卸载不等于销毁文件，
        # 万一同一份文件被挂在别处（复制粘贴同一张图）不会被连带删掉。
        for pk in obj.pks:
            for target_type in _NOTICE_TARGET_TYPES:
                file_ids = await file_relation_dao.get_file_ids_by_target(db, target_type, pk)
                if file_ids:
                    await file_relation_dao.delete_by_target(db, target_type, pk, list(file_ids))
        return count


notice_service: NoticeService = NoticeService()

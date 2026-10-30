from collections.abc import Sequence

from sqlalchemy import ColumnElement, Select, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.enums import StatusType
from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notice.model import Notice
from backend.plugin.notice.schema.notice import NoticeWriteParam
from backend.utils.timezone import timezone

#: 入参里不是列的字段（附件另走 `sys_file_relation`）
_NON_COLUMN_FIELDS = {'attachment_ids'}


def readable_clause() -> ColumnElement[bool]:
    """「读者看得见这条公告」：没删 · 显示 · 没过期（#186）

    🔴 **唯一一份**。给读者的列表、详情、附件下载权限（`_notice_file_access`）、收件箱的附件数都用它 ——
    原来附件权限只看「没删」，于是隐藏的公告附件照样下得到（实测 200），而列表上已经看不见了
    """
    return and_(
        Notice.deleted == 0,
        Notice.status == StatusType.enable,
        or_(Notice.expire_time.is_(None), Notice.expire_time > timezone.now()),
    )


class CRUDNotice(DataScopedCRUD[Notice]):
    #: 显式豁免数据权限 —— 公告是**全局内容**，而且这张表没有任何归属维度
    #:
    #: 🔴 **默默继承默认值（过滤）会让公告对所有受限用户消失。** 实测：
    #: 超管看到 3 条，STAFF 角色的用户看到 **0 条**（HTTP 200、空列表、无任何提示），
    #: 仪表盘那张统计卡也跟着显示 0。
    #:
    #: 原因是 fail-closed：`filter_data_permission_for_user` 里
    #: `if not data_rules: return or_(1 != 1)` —— 而四个种子演示角色都是
    #: 「开了 is_filter_scopes 但没配范围」。
    #:
    #: 而且这张表**没有可过滤的维度**：只有 `id / title / type / status / content`，
    #: 没有 `dept_id`、没有 `created_by`。规则想表达「某部门才看得到某公告」
    #: 压根表达不了 —— 所以过滤在这里只有 fail-closed 一种效果。
    #:
    #: ⚠️ `GET /sys/notices` 只挂 `DependsJwtAuth`、**没有权限门禁** ——
    #: 它是给所有登录用户看公告的接口（仪表盘也拿它做统计卡），
    #: 不是管理端列表。和菜单/字典同一类：滤掉了界面就空，而用户不知道为什么。
    data_scope_enabled = False

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

    async def get_readable(self, db: AsyncSession, pk: int) -> Notice | None:
        """
        取一条读者看得见的公告（隐藏 / 过期 / 删了的都当不存在）

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return:
        """
        return await db.scalar(select(Notice).where(Notice.id == pk, readable_clause()))

    def get_feed_select(self) -> Select:
        """
        给读者的列表：置顶的在前，再按发布时间倒序

        排序带上 `id`：同一毫秒建的两条（批量导入）`created_time` 相同，不带的话翻页顺序在两次请求间可以不一样

        :return:
        """
        return (
            select(Notice)
            .where(readable_clause())
            .order_by(Notice.pinned.desc(), Notice.created_time.desc(), Notice.id.desc())
        )

    async def get_all(self, db: AsyncSession) -> Sequence[Notice]:
        """
        获取所有通知公告

        :param db: 数据库会话
        :return:
        """
        return await self.select_models(db, deleted=0)

    async def create(self, db: AsyncSession, obj: NoticeWriteParam) -> Notice:
        """
        创建通知公告，返回创建出来的对象

        返回**实例**而不是 None：正文里的内联图要在保存后挂到
        `sys_file_relation` 上（`target_id` 就是这条公告的 id），
        而创建接口原来不下发 id —— 前端拿不到 id 就没法挂关联，
        于是新建公告里的图会变成谁也不认领的孤儿文件。

        ⚠️ flush 不能省。`id` 是数据库侧生成的（`id_key` → BigInteger 主键）——
        不 flush 就返回，实例的 `id` 还是 `None`，序列化响应时直接 500：
        `1 validation error: ('response','data','id') Input should be a valid integer`
        （实测踩到）。事务仍由 `CurrentSessionTransaction` 统一提交。

        不走 `create_model`：它把整个入参 `model_dump()` 塞进模型，`attachment_ids` 不是列，当场 TypeError。

        :param db: 数据库会话
        :param obj: 创建通知公告参数
        :return:
        """
        notice = self.model(**obj.model_dump(exclude=_NON_COLUMN_FIELDS))
        db.add(notice)
        await db.flush()
        return notice

    async def update(self, db: AsyncSession, pk: int, obj: NoticeWriteParam) -> int:
        """
        更新通知公告

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :param obj: 更新通知公告参数
        :return:
        """
        # `exclude_unset`：没传的字段不写。置顶 / 级别 / 过期时间在入参上有默认值，整份写回的话
        # 只传了标题和正文的调用方（脚本、老客户端）会把一条置顶 + 紧急 + 有期限的公告悄悄改回默认值
        data = obj.model_dump(exclude=_NON_COLUMN_FIELDS, exclude_unset=True)
        return await self.update_model_by_column(db, data, id=pk, deleted=0)

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

from collections.abc import Sequence

from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notice.model import Notice
from backend.plugin.notice.schema.notice import CreateNoticeParam, UpdateNoticeParam
from backend.utils.timezone import timezone


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

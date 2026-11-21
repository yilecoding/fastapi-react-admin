from collections.abc import Sequence
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.cache.decorator import cache_invalidate
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.core.conf import settings
from backend.plugin.dict.crud.crud_dict_data import dict_data_dao
from backend.plugin.dict.crud.crud_dict_type import dict_type_dao
from backend.plugin.dict.model import DictType
from backend.plugin.dict.schema.dict_type import CreateDictTypeParam, DeleteDictTypeParam, UpdateDictTypeParam


class DictTypeService:
    """字典类型服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> DictType:
        """
        获取字典类型详情

        :param db: 数据库会话
        :param pk: 字典类型 ID
        :return:
        """

        dict_type = await dict_type_dao.get(db, pk)
        if not dict_type:
            raise errors.NotFoundError(msg=t('error.dict.type_not_found'))
        return dict_type

    @staticmethod
    async def get_all(*, db: AsyncSession) -> Sequence[DictType]:
        """
        获取所有字典类型

        :param db: 数据库会话
        :return:
        """
        dict_datas = await dict_type_dao.get_all(db)
        return dict_datas

    @staticmethod
    async def get_list(*, db: AsyncSession, name: str | None, code: str | None) -> dict[str, Any]:
        """
        获取字典类型列表

        :param db: 数据库会话
        :param name: 字典类型名称
        :param code: 字典类型编码
        :return:
        """
        dict_type_select = await dict_type_dao.get_select(name=name, code=code)
        return await paging_data(db, dict_type_select)

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateDictTypeParam) -> None:
        """
        创建字典类型

        :param db: 数据库会话
        :param obj: 字典类型创建参数
        :return:
        """

        dict_type = await dict_type_dao.get_by_code(db, obj.code)
        if dict_type:
            raise errors.ConflictError(msg=t('error.dict.type_exists'))
        await dict_type_dao.create(db, obj)

    @staticmethod
    @cache_invalidate(namespace=settings.CACHE_DICT_REDIS_PREFIX)
    async def update(*, db: AsyncSession, pk: int, obj: UpdateDictTypeParam) -> int:
        """
        更新字典类型

        :param db: 数据库会话
        :param pk: 字典类型 ID
        :param obj: 字典类型更新参数
        :return:

        🔴 改编码要连带数据项冗余存的 `type_code` 和 `fba:cache:dict`（#395）：漏了前者，新编码查不到、
        再建一个复用旧编码的类型会「继承」那批孤儿项；漏了后者，旧编码的缓存继续返回两小时。
        缓存走 `@cache_invalidate` 整个命名空间清（和字典数据的增删改同一条路，提交后再清一次也跟着它）
        """

        dict_type = await dict_type_dao.get(db, pk)
        if not dict_type:
            raise errors.NotFoundError(msg=t('error.dict.type_not_found'))
        # 先抓成局部变量：`update` 之后同一个 ORM 实例上读到的已经是新编码（apps/api 分册「改完再读同一个 ORM 实例」）
        code_changed = dict_type.code != obj.code
        if code_changed and await dict_type_dao.get_by_code(db, obj.code):
            raise errors.ConflictError(msg=t('error.dict.type_exists'))
        count = await dict_type_dao.update(db, pk, obj)
        if code_changed:
            await dict_data_dao.update_type_code(db, pk, obj.code)
        return count

    @staticmethod
    @cache_invalidate(namespace=settings.CACHE_DICT_REDIS_PREFIX)
    async def delete(*, db: AsyncSession, obj: DeleteDictTypeParam) -> int:
        """
        批量删除字典类型

        :param db: 数据库会话
        :param obj: 字典类型 ID 列表
        :return:

        数据项跟着级联软删，所以下拉缓存（`type:{code}`）也要清（#395）
        """

        count = await dict_type_dao.delete(db, obj.pks)
        return count


dict_type_service: DictTypeService = DictTypeService()

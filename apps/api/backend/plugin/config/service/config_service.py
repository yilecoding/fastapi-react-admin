from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.common.secret_keys import is_secret_key_name
from backend.plugin.config.crud.crud_config import config_dao
from backend.plugin.config.model import Config
from backend.plugin.config.schema.config import (
    CreateConfigParam,
    UpdateConfigParam,
    UpdateConfigsParam,
)
from backend.plugin.config.secret import encrypt_secret
from backend.utils.dynamic_config import PASSWORD_LENGTH_PAIR, check_password_length_pair


def _update_data(obj: UpdateConfigParam, config: Config) -> dict[str, Any]:
    """单条和批量更新共用密钥语义；保留旧值时不写 value，避免覆盖并发的新密钥。"""
    if obj.key != config.key:
        raise errors.RequestError(msg=t('error.config.key_immutable'))
    data = obj.model_dump(exclude={'clear_secret', 'id'})
    if is_secret_key_name(config.key):
        data['is_frontend'] = False
        if obj.clear_secret:
            data['value'] = ''
        elif obj.value:
            data['value'] = encrypt_secret(obj.value)
        else:
            data.pop('value')
    return data


async def _check_pairs(db: AsyncSession, touched: set[str]) -> None:
    """写完、提交前再看一遍有大小关系的那一对（#395）；不合格就抛，事务回滚

    放在写完之后看库里的值：单条改只带一个键，另一个键是库里现有的；批量改可能两个一起变
    """
    if not touched & set(PASSWORD_LENGTH_PAIR):
        return
    # 会话是 autoflush=False：`create` 刚 add 的行不 flush 就查不到（update 走的是直接 UPDATE 语句，不受影响）
    await db.flush()
    rows = await db.execute(
        select(Config.key, Config.value).where(Config.key.in_(PASSWORD_LENGTH_PAIR), Config.deleted == 0)
    )
    values = dict(rows.tuples().all())
    low, high = PASSWORD_LENGTH_PAIR
    if low in values and high in values and (problem := check_password_length_pair(values[low], values[high])):
        raise errors.RequestError(msg=problem)


class ConfigService:
    """参数配置服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Config:
        """
        获取参数配置详情

        :param db: 数据库会话
        :param pk: 参数配置 ID
        :return:
        """
        config = await config_dao.get(db, pk)
        if not config:
            raise errors.NotFoundError(msg=t('error.config.not_found'))
        return config

    @staticmethod
    async def get_all(*, db: AsyncSession, type: str | None) -> Sequence[Config | None]:
        """
        获取所有参数配置

        :param db: 数据库会话
        :param type: 参数配置类型
        :return:
        """
        return await config_dao.get_all(db, type)

    @staticmethod
    async def get_list(*, db: AsyncSession, name: str | None, type: str | None) -> dict[str, Any]:
        """
        获取参数配置列表

        :param db: 数据库会话
        :param name: 参数配置名称
        :param type: 参数配置类型
        :return:
        """
        config_select = await config_dao.get_select(name=name, type=type)
        return await paging_data(db, config_select)

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateConfigParam) -> None:
        """
        创建参数配置

        :param db: 数据库会话
        :param obj: 参数配置创建参数
        :return:
        """
        config = await config_dao.get_by_key(db, obj.key)
        if config:
            raise errors.ConflictError(msg=t('error.config.key_exists', key=obj.key))
        if is_secret_key_name(obj.key):
            obj = obj.model_copy(update={'value': encrypt_secret(obj.value), 'is_frontend': False})
        await config_dao.create(db, obj)
        # 新建也要过：删掉上限那一行再建一条值为 1 的，绕开的就是 `update` 那道闸（#395 评审）
        await _check_pairs(db, {obj.key})

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateConfigParam) -> int:
        """
        更新参数配置

        :param db: 数据库会话
        :param pk: 参数配置 ID
        :param obj: 参数配置更新参数
        :return:
        """
        config = await config_dao.get(db, pk)
        if not config:
            raise errors.NotFoundError(msg=t('error.config.not_found'))
        count = await config_dao.update(db, pk, _update_data(obj, config))
        await _check_pairs(db, {config.key})
        return count

    @staticmethod
    async def bulk_update(*, db: AsyncSession, objs: list[UpdateConfigsParam]) -> int:
        """
        批量更新参数配置

        :param db: 数据库会话
        :param objs: 参数配置批量更新参数
        :return:
        """
        configs = await config_dao.get_all_by_ids(db, list({obj.id for obj in objs}))
        config_map = {config.id: config for config in configs}
        for obj in objs:
            if obj.id not in config_map:
                raise errors.NotFoundError(msg=t('error.config.not_found'))

        if len({obj.id for obj in objs}) != len(objs):
            raise errors.RequestError(msg=t('error.config.duplicate_key'))
        data = [{**_update_data(obj, config_map[obj.id]), 'id': obj.id} for obj in objs]
        count = await config_dao.bulk_update(db, data)
        await _check_pairs(db, {config_map[obj.id].key for obj in objs})
        return count

    @staticmethod
    async def delete(*, db: AsyncSession, pks: list[int]) -> int:
        """
        批量删除参数配置

        :param db: 数据库会话
        :param pks: 参数配置 ID 列表
        :return:
        """
        count = await config_dao.delete(db, pks)
        return count


config_service: ConfigService = ConfigService()

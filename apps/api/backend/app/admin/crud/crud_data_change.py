from datetime import datetime

from sqlalchemy import Select

from backend.app.admin.model import DataChange
from backend.common.security.data_scope import DataScopedCRUD


class CRUDDataChangeDao(DataScopedCRUD[DataChange]):
    """数据变更记录（#260）

    豁免数据权限：看的人要的是「谁改了什么」的全量审计，按操作人或对象所在部门过滤都会让记录凭空消失；
    入口靠 `log:change:list` 一个权限码挡（2026-11-09 #260 拍板，和操作日志同口径）。
    """

    data_scope_enabled = False

    async def get_select(
        self,
        *,
        entity_type: str | None = None,
        entity_id: int | None = None,
        actor: str | None = None,
        source: str | None = None,
        action: str | None = None,
        field: str | None = None,
        trace_id: str | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        filters: dict = {}
        if entity_type is not None:
            filters['entity_type'] = entity_type
        if entity_id is not None:
            filters['entity_id'] = entity_id
        if actor is not None:
            filters['actor_name__like'] = f'%{actor}%'
        if source is not None:
            filters['source'] = source
        if action is not None:
            filters['action'] = action
        if field is not None:
            # `fields` 存成 `,a,b,`：两边带逗号才不会让 `name` 命中 `nickname`
            filters['fields__like'] = f'%,{field},%'
        if trace_id is not None:
            filters['trace_id'] = trace_id
        if start_time is not None:
            filters['created_time__ge'] = start_time
        if end_time is not None:
            filters['created_time__le'] = end_time
        # 同一毫秒里写的几行（一个事务里改了好几个对象）按 id 定序，翻页不乱
        return await self.select_order(['created_time', 'id'], ['desc', 'desc'], **filters)


data_change_dao: CRUDDataChangeDao = CRUDDataChangeDao(DataChange)

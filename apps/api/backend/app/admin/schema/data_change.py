from datetime import datetime
from typing import Any

from pydantic import ConfigDict, Field

from backend.common.schema import SchemaBase


class GetDataChangeDetail(SchemaBase):
    """数据变更记录（#260）"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='记录 ID')
    trace_id: str = Field(description='请求跟踪 ID（和操作日志同一个）')
    entity_type: str = Field(description='对象类型')
    entity_id: int | None = Field(None, description='对象 ID（批量汇总行为空）')
    entity_label: str | None = Field(None, description='对象当时的名字；批量汇总行是命中行数')
    action: str = Field(description='create / update / delete / bulk')
    changes: list[dict[str, Any]] | None = Field(None, description='字段变化')
    actor_id: int | None = Field(None, description='操作人 ID')
    actor_name: str | None = Field(None, description='操作人用户名（快照）')
    source: str = Field(description='来源')
    source_ref: str | None = Field(None, description='来源的引用（AI 工具调用 ID…）')
    ip: str | None = Field(None, description='IP 地址')
    created_time: datetime = Field(description='时间')


class DataChangeField(SchemaBase):
    field: str = Field(description='字段')
    label: str = Field(description='中文名')


class DataChangeEntity(SchemaBase):
    entity: str = Field(description='对象类型')
    title: str = Field(description='中文名')
    fields: list[DataChangeField] = Field(description='记录的字段（含关联表折叠出来的集合字段）')


class DataChangeOption(SchemaBase):
    value: str = Field(description='值')
    label: str = Field(description='中文名')


class GetDataChangeMeta(SchemaBase):
    """筛选下拉和字段翻译用的元数据"""

    entities: list[DataChangeEntity] = Field(description='登记过的对象')
    sources: list[DataChangeOption] = Field(description='来源')
    actions: list[DataChangeOption] = Field(description='动作')

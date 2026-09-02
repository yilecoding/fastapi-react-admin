from datetime import datetime
from typing import Self

from pydantic import ConfigDict, Field, model_validator

from backend.common.schema import SchemaBase
from backend.utils.dynamic_config import check_dynamic_int_bounds


class ConfigSchemaBase(SchemaBase):
    """参数配置基础模型"""

    name: str = Field(description='参数配置名称')
    type: str | None = Field(None, description='参数配置类型')
    key: str = Field(description='参数配置键名')
    value: str = Field(description='参数配置值')
    is_frontend: bool = Field(description='是否前端参数配置')
    remark: str | None = Field(None, description='备注')

    @model_validator(mode='after')
    def check_bounds(self) -> Self:
        """数值型配置必须落在合法范围内

        🔴 **放在 schema 上是刻意的**：`update` / `bulk_update` / `create`
        三条写入路径共用这组模型，校验挂在这里三条一起覆盖，
        不会漏掉哪一条（写在 service 里就要挑一处一处加，而 `bulk_update`
        很容易被忘）。

        范围表和「为什么写入侧此前完全没有校验」见
        `backend/utils/dynamic_config.py: DYNAMIC_INT_BOUNDS`。
        """
        problem = check_dynamic_int_bounds(self.key, self.value)
        if problem:
            raise ValueError(problem)
        return self


class CreateConfigParam(ConfigSchemaBase):
    """创建参数配置参数"""


class UpdateConfigParam(ConfigSchemaBase):
    """更新参数配置参数"""


class UpdateConfigsParam(UpdateConfigParam):
    """批量更新参数配置参数"""

    id: int = Field(description='参数配置 ID')


class GetConfigDetail(ConfigSchemaBase):
    """参数配置详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='参数配置 ID')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')

from datetime import datetime
from typing import Self

from pydantic import ConfigDict, Field, model_validator

from backend.common.schema import ColumnLengthChecked, SchemaBase
from backend.plugin.config.model import Config
from backend.utils.dynamic_config import check_dynamic_choice, check_dynamic_dependency, check_dynamic_int_bounds


class ConfigSchemaBase(SchemaBase):
    """参数配置基础模型"""

    name: str = Field(description='参数配置名称')
    type: str | None = Field(None, description='参数配置类型')
    key: str = Field(description='参数配置键名')
    value: str = Field(description='参数配置值')
    is_frontend: bool = Field(description='是否前端参数配置')
    remark: str | None = Field(None, description='备注')


class _WriteChecked(ConfigSchemaBase):
    """写入路径的值校验（范围 / 固定取值 / 依赖别的配置）"""

    @model_validator(mode='after')
    def check_bounds(self) -> Self:
        """数值型配置必须落在合法范围内

        🔴 **放在写入 schema 上是刻意的**：`update` / `bulk_update` / `create`
        三条写入路径共用这组模型，校验挂在这里三条一起覆盖，
        不会漏掉哪一条（写在 service 里就要挑一处一处加，而 `bulk_update`
        很容易被忘）。

        🔴 **但不能挂在读写共用的基类上**（原来就挂在那儿）：`GetConfigDetail` 也继承它，库里只要有一个
        不合格的值 —— 直接改库、或者范围后来收紧了、或者 #181 那条依赖运行时环境变量的检查
        （没配 MFA_SECRET_KEY 时 LOGIN_MFA_ENFORCE 不许是强制）—— **整个参数配置列表就 500**，
        管理员连在界面上改回去都做不到。读路径不校验，读取侧的回落在 `load_config` 里。

        范围表和「为什么写入侧此前完全没有校验」见
        `backend/utils/dynamic_config.py: DYNAMIC_INT_BOUNDS`。
        """
        problem = (
            check_dynamic_int_bounds(self.key, self.value)
            or check_dynamic_choice(self.key, self.value)
            or check_dynamic_dependency(self.key, self.value)
        )
        if problem:
            raise ValueError(problem)
        return self


class CreateConfigParam(ColumnLengthChecked, _WriteChecked):
    """创建参数配置参数"""

    __sa_model__ = Config


class UpdateConfigParam(ColumnLengthChecked, _WriteChecked):
    """更新参数配置参数"""

    __sa_model__ = Config


class UpdateConfigsParam(UpdateConfigParam):
    """批量更新参数配置参数"""

    id: int = Field(description='参数配置 ID')


class GetConfigDetail(ConfigSchemaBase):
    """参数配置详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='参数配置 ID')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')

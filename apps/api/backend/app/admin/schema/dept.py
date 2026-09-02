from datetime import datetime

from pydantic import ConfigDict, Field

from backend.app.admin.model import Dept
from backend.common.enums import StatusType
from backend.common.schema import (
    ColumnLengthChecked,
    CustomCode,
    CustomEmailStr,
    CustomPhoneNumber,
    SchemaBase,
    SnowflakeIdIn,
)


class DeptSchemaBase(SchemaBase):
    """部门基础模型"""

    name: str = Field(description='部门名称')
    parent_id: SnowflakeIdIn | None = Field(None, description='部门父级 ID')
    sort: int = Field(0, ge=0, description='排序')
    leader: str | None = Field(None, description='负责人')
    phone: CustomPhoneNumber | None = Field(None, description='联系电话')
    email: CustomEmailStr | None = Field(None, description='邮箱')
    status: StatusType = Field(description='状态')


class CreateDeptParam(ColumnLengthChecked, DeptSchemaBase):
    """创建部门参数"""

    __sa_model__ = Dept

    code: CustomCode = Field(description='部门编码')


class UpdateDeptParam(ColumnLengthChecked, DeptSchemaBase):
    """更新部门参数

    刻意**不含** `code` —— 编码是给配置、数据权限规则和外部系统用的稳定引用键，
    改掉它会让所有引用静默指向空（不报错，只是查不到）。要换编码就删了重建。
    `update` 走 model_dump(exclude_unset=True)，字段不在这里就不会被写。
    """

    __sa_model__ = Dept


class GetDeptDetail(DeptSchemaBase):
    """部门详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='部门 ID')
    code: str = Field(description='部门编码')
    deleted: int = Field(description='是否已删除（0：否；id：是）')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')
    deleted_time: datetime | None = Field(None, description='删除时间')


class GetDeptTree(GetDeptDetail):
    """获取部门树"""

    children: list['GetDeptTree'] | None = Field(None, description='子菜单')

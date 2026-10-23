import re

from datetime import datetime
from typing import Self

from pydantic import ConfigDict, Field, model_validator

from backend.app.admin.model import Menu
from backend.common.enums import MenuType, StatusType
from backend.common.schema import ColumnLengthChecked, SchemaBase, SnowflakeIdIn


class MenuSchemaBase(SchemaBase):
    """菜单基础模型"""

    title: str = Field(description='菜单标题')
    name: str = Field(description='菜单名称')
    path: str | None = Field(None, description='路由地址')
    parent_id: SnowflakeIdIn | None = Field(None, description='菜单父级 ID')
    sort: int = Field(0, ge=0, description='排序')
    icon: str | None = Field(None, description='图标')
    type: MenuType = Field(description='菜单类型（0目录 1菜单 2按钮 3内嵌 4外链）')
    perms: str | None = Field(None, description='权限标识')
    status: StatusType = Field(description='状态')
    display: StatusType = Field(description='是否显示')
    link: str | None = Field(None, description='外链地址')
    remark: str | None = Field(None, description='备注')


_ROUTE_NAME = re.compile(r'^[A-Za-z][A-Za-z0-9]*$')


class MenuWriteParam(ColumnLengthChecked, MenuSchemaBase):
    """新建 / 修改菜单共用的写入规则

    🔴 不同类型的必填项不同，这套规则原来**只在前端**（`pages/menu/form.tsx` 的 superRefine）：
    带 token 直接打接口、或者让 AI 建菜单，都能建出没有路由地址的菜单（侧边栏静默跳过它）、
    没有权限码的按钮（勾给谁都等于没给）。改规则时两边一起改
    """

    __sa_model__ = Menu

    @model_validator(mode='after')
    def _required_by_type(self) -> Self:
        if not _ROUTE_NAME.match(self.name):
            raise ValueError('菜单名称须为英文、字母开头（作路由 name 用）')
        if self.type == MenuType.button:
            if not (self.perms or '').strip():
                raise ValueError('按钮必须填写权限标识')
            return self
        if self.type in {MenuType.embedded, MenuType.link} and not (self.link or '').strip():
            raise ValueError('外链 / 内嵌必须填写地址')
        if not (self.path or '').strip():
            raise ValueError('请填写路由地址')
        return self


class CreateMenuParam(MenuWriteParam):
    """创建菜单参数"""


class UpdateMenuParam(MenuWriteParam):
    """更新菜单参数"""


class GetMenuDetail(MenuSchemaBase):
    """菜单详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='菜单 ID')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')


class GetMenuTree(GetMenuDetail):
    """获取菜单树"""

    children: list['GetMenuTree'] | None = Field(None, description='子菜单')

---
title: 从零加一个业务模块
description: 以「客户管理」为例，从模型、迁移、三层接口、菜单权限到列表页和数据权限，走通一个真实业务模块。
sidebar:
  order: 1
---

这个仓库没有代码生成器。新业务模块照着现有模块的写法手写，每一层都有几条规则：漏了不报错，功能照样能跑，但权限、数据范围或迁移会出问题。

这一页用一个**客户管理**模块走完整条链：

```
模型 → Alembic 迁移 → schema / crud / service / api → 注册路由
     → 菜单与按钮权限码 → 前端列表页 → 数据权限 → 测试
```

下面的代码都在一个干净检出上实际跑过：迁移在 PostgreSQL 上生成、升级、回滚过，接口用 curl 打过，`pnpm typecheck --force`、`pnpm arch:check`、`pnpm lint`、`pnpm i18n:check` 都通过，模块测试和仓库自带的守卫测试也都是绿的。没验证过的地方会单独说明。

开始前先把服务跑起来（见[快速开始](/getting-started/quick-start/)），并读一遍根目录 `CLAUDE.md` 的硬纪律 1–6。

## 模块长什么样？

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | 字符串（64） | 客户名称，必填 |
| `phone` | 字符串（20） | 联系电话 |
| `level` | 整数 | 0 普通 · 1 重要 · 2 VIP |
| `status` | 整数 | 0 停用 · 1 正常 |
| `dept_id` | 雪花 ID | 所属部门。数据权限靠这一列落地 |
| `owner_id` | 雪花 ID | 负责人用户 |
| `created_by` | 雪花 ID | 创建人。「仅本人」规则靠这一列落地 |
| `remark` | 长文本 | 备注 |

后端代码放在一个新 app 里：`apps/api/backend/app/crm/`，结构和 `app/task/` 一样。也可以做成插件（参考 `backend/plugin/dict/`），但插件多了 `plugin.toml`、安装和卸载这一套，普通业务模块用不上。

```
apps/api/backend/app/crm/
├─ __init__.py
├─ model/      __init__.py · customer.py
├─ schema/     __init__.py · customer.py
├─ crud/       __init__.py · crud_customer.py
├─ service/    __init__.py · customer_service.py
├─ api/        __init__.py · router.py · v1/__init__.py · v1/customer.py
└─ tests/      __init__.py · test_customer.py
```

## 第 1 步：写模型

`apps/api/backend/app/crm/model/customer.py`：

```python
import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, UniversalStr, UniversalText, id_key


class Customer(Base):
    """客户表"""

    __tablename__ = 'crm_customer'
    __table_args__ = {'comment': '客户表'}

    id: Mapped[id_key] = mapped_column(init=False)
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='客户名称')
    phone: Mapped[str | None] = mapped_column(UniversalStr(20), default=None, comment='联系电话')
    level: Mapped[int] = mapped_column(default=0, comment='客户等级（0：普通、1：重要、2：VIP）')
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    # 数据权限靠这两列落地：规则里的 `__dept_id__` / `__created_by__` 解析成同名列，表上没有，规则就落不下来
    dept_id: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, index=True, comment='所属部门 ID')
    owner_id: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='负责人用户 ID')
    created_by: Mapped[int] = mapped_column(sa.BigInteger, default=0, index=True, comment='创建者用户 ID')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')
```

`apps/api/backend/app/crm/model/__init__.py`：

```python
from backend.app.crm.model.customer import Customer as Customer
```

要点：

- 继承 `Base`，`created_time` / `updated_time` / `deleted` / `deleted_time` 就都有了。`deleted` 存的是「0 或这一行自己的 id」，不是布尔值，手写 SQL 时要带 `deleted = 0`
- 主键写 `Mapped[id_key]`，是雪花 ID
- 会存中文的列用 `UniversalStr` / `UniversalText`，不要用 `sa.String`。SQL Server 上存中文需要 `NVARCHAR`，`UniversalStr` 会自动用它
- 模型必须放在 `backend/app/<app>/model/` 下面。数据权限按这个路径找模型（`utils/dynamic_import.py: get_app_models`）

**验收**：模型还不会自己建表。下一步的迁移能看到 `crm_customer`，就说明它被加载了。

## 第 2 步：生成迁移

改完模型，生成一条迁移：

```bash
pnpm db:revision '客户管理 crm_customer'
```

alembic 会在 `apps/api/backend/alembic/versions/` 下生成一个文件，**提交前把它读一遍**，重点看三处：

```python
op.create_table('crm_customer',
    sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
    sa.Column('name', backend.common.model.UniversalStr(length=64), nullable=False, comment='客户名称'),
    # …
    sa.Column('deleted', sa.BigInteger(), server_default='0', nullable=False, comment='是否已删除（0：否；id：是）'),
    # …
)
op.create_index(op.f('ix_crm_customer_dept_id'), 'crm_customer', ['dept_id'], unique=False)
```

1. **`id` 上有 `autoincrement=False`。** `id_key` 已经声明了它，autogenerate 会照着渲染。手写建表迁移时要自己写上，不然 SQL Server 会把雪花主键建成 IDENTITY，生产环境插入时报 `Cannot insert explicit value for identity column`
2. **只建这一张表。** 如果生成的文件里出现了一串 `drop_table`，说明 `alembic/env.py` 里的 `import backend.main` 被删了。不要提交
3. 你的模型改动之外，不应该出现别的表的变化

然后升级：

```bash
pnpm db:upgrade
pnpm db:current
```

**验收**：`pnpm db:current` 显示新生成的 revision 带着 `(head)`。想确认迁移能回滚，可以跑一次 `cd apps/api/backend && uv run --no-sync alembic downgrade -1`，再 `pnpm db:upgrade` 升回来。

:::caution
改了模型就要生成迁移。`--reload` 只会重新 import 代码，不会改已经建好的表。测试 `test_model_matches_migrations` 会比对模型和数据库，漏了迁移会报红。
:::

## 第 3 步：写 schema

`apps/api/backend/app/crm/schema/customer.py`：

```python
from datetime import datetime

from pydantic import ConfigDict, Field

from backend.app.crm.model import Customer
from backend.common.enums import StatusType
from backend.common.schema import ColumnLengthChecked, SchemaBase


class CustomerSchemaBase(SchemaBase):
    """客户基础模型"""

    name: str = Field(description='客户名称')
    phone: str | None = Field(None, description='联系电话')
    level: int = Field(0, ge=0, le=2, description='客户等级（0：普通、1：重要、2：VIP）')
    status: StatusType = Field(StatusType.enable, description='状态（0：停用、1：正常）')
    remark: str | None = Field(None, description='备注')


class CreateCustomerParam(ColumnLengthChecked, CustomerSchemaBase):
    """创建客户参数"""

    __sa_model__ = Customer

    dept_id: int | None = Field(None, description='所属部门 ID（不传 = 创建人的部门）')
    owner_id: int | None = Field(None, description='负责人用户 ID（不传 = 创建人）')


class UpdateCustomerParam(ColumnLengthChecked, CustomerSchemaBase):
    """更新客户参数"""

    __sa_model__ = Customer

    dept_id: int | None = Field(None, description='所属部门 ID')
    owner_id: int | None = Field(None, description='负责人用户 ID')


class DeleteCustomerParam(SchemaBase):
    """删除客户参数"""

    pks: list[int] = Field(description='客户 ID 列表')


class GetCustomerDetail(CustomerSchemaBase):
    """客户详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='客户 ID')
    dept_id: int | None = Field(None, description='所属部门 ID')
    owner_id: int | None = Field(None, description='负责人用户 ID')
    created_by: int = Field(description='创建者用户 ID')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')
```

写入用的参数类要混入 `ColumnLengthChecked`，并用 `__sa_model__` 绑定模型。它会读模型上的列长度来校验入参，不用逐个字段写 `max_length`。不加的话，超长的值会一路到数据库，接口直接返回 500。

`id` 声明成 `int` 就可以。下发时 `stringify_unsafe_ints` 会把超过 JS 安全整数范围的值统一转成字符串。

**验收**：等接口写好以后，提交一个 70 个字的 `name`，返回 422，提示「name 最长 64 个字符，收到 70 个」。

## 第 4 步：写 crud（DAO）

`apps/api/backend/app/crm/crud/crud_customer.py`：

```python
from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.crm.model import Customer
from backend.common.security.data_scope import DataScopedCRUD
from backend.utils.timezone import timezone


class CRUDCustomer(DataScopedCRUD[Customer]):
    """客户数据库操作类

    继承 `DataScopedCRUD` 且**不**写 `data_scope_enabled = False`：读操作自动套上当前用户的数据范围。
    """

    async def get(self, db: AsyncSession, pk: int) -> Customer | None:
        """获取客户详情（受数据范围约束：范围外的当作不存在）"""
        return await self.select_model(db, pk, deleted=0)

    async def get_visible_ids(self, db: AsyncSession, pks: list[int]) -> list[int]:
        """这批 ID 里当前用户看得见的那些（写操作前用它收窄）"""
        rows = await self.select_models(db, id__in=pks, deleted=0)
        return [row.id for row in rows]

    async def get_select(self, name: str | None, phone: str | None, level: int | None, status: int | None) -> Select:
        """分页查询表达式（`select_order` → `select()`，数据范围已经在里面了）"""
        filters = {'deleted': 0}
        if name is not None:
            filters['name__like'] = f'%{name}%'
        if phone is not None:
            filters['phone__like'] = f'%{phone}%'
        if level is not None:
            filters['level'] = level
        if status is not None:
            filters['status'] = status
        return await self.select_order('id', 'desc', **filters)

    async def create(self, db: AsyncSession, data: dict) -> None:
        """创建客户"""
        db.add(self.model(**data))

    async def update(self, db: AsyncSession, pk: int, data: dict) -> int:
        """更新客户（⚠️ 写操作不过数据范围，调用前必须先 `get` 确认看得见）"""
        return await self.update_model_by_column(db, data, id=pk, deleted=0)

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        """逻辑删除（⚠️ 同上，`pks` 要先经过 `get_visible_ids`）"""
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


customer_dao: CRUDCustomer = CRUDCustomer(Customer)
```

几条规则：

- **基类用 `DataScopedCRUD`，不要用 `CRUDPlus`。** 列表（`select`）和详情（`select_model`）会自动加上当前用户的数据范围条件。如果某张表确实不该按数据范围过滤，就在类里显式写 `data_scope_enabled = False`，并在注释里说明原因。测试 `test_every_crud_class_declares_its_data_scope_stance` 会检查每个 DAO 有没有表态
- **数据范围只管读，不管写。** `update_model_by_column` / `delete_model_by_column` 直接生成 UPDATE / DELETE 语句，不经过 `select()`。实测：在「什么都看不见」的用户上下文里，`get()` 返回 `None`，`update()` 照样改到了 1 行。所以写操作要先用受范围约束的读收窄一遍（见下一步）
- **分页必须带排序**（`select_order`）。SQL Server 的 `OFFSET … FETCH` 要求有 `ORDER BY`
- **交给分页的那个 `Select` 里不能 join 多对多表**，否则 `total` 会按 join 之后的行数算，翻页也会错位。这张表没有多对多关系，不涉及

## 第 5 步：写 service

`apps/api/backend/app/crm/service/customer_service.py`：

```python
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.crm.crud.crud_customer import customer_dao
from backend.app.crm.model import Customer
from backend.app.crm.schema.customer import CreateCustomerParam, DeleteCustomerParam, UpdateCustomerParam
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data


class CustomerService:
    """客户服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Customer:
        customer = await customer_dao.get(db, pk)
        if not customer:
            raise errors.NotFoundError(msg=t('error.customer.not_found'))
        return customer

    @staticmethod
    async def get_list(
        *, db: AsyncSession, name: str | None, phone: str | None, level: int | None, status: int | None
    ) -> dict[str, Any]:
        customer_select = await customer_dao.get_select(name=name, phone=phone, level=level, status=status)
        return await paging_data(db, customer_select)

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateCustomerParam, user: Any) -> None:
        data = obj.model_dump()
        # 不传就归到创建人自己的部门 / 名下 —— 否则 dept_id 是空，「本部门」规则下谁都看不见它
        data['dept_id'] = data['dept_id'] or user.dept_id
        data['owner_id'] = data['owner_id'] or user.id
        data['created_by'] = user.id
        await customer_dao.create(db, data)

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateCustomerParam) -> int:
        # 先过一次受范围约束的读：范围外的客户在这里就是 404，不会被改到
        if not await customer_dao.get(db, pk):
            raise errors.NotFoundError(msg=t('error.customer.not_found'))
        # exclude_unset：没传的字段不写。否则只改名字的请求会把 dept_id / owner_id 冲成 NULL
        return await customer_dao.update(db, pk, obj.model_dump(exclude_unset=True))

    @staticmethod
    async def delete(*, db: AsyncSession, obj: DeleteCustomerParam) -> int:
        visible = await customer_dao.get_visible_ids(db, obj.pks)
        if not visible:
            return 0
        return await customer_dao.delete(db, visible)


customer_service: CustomerService = CustomerService()
```

报错文案走 `t('error.模块.键')`，不要直接写中文字面量。两个语言包里都要加上这个键：

```yaml
# apps/api/backend/locale/zh-CN.yml，放在 error: 下面，按字母序插在 data_rule 前
  customer:
    not_found: 客户不存在
```

```yaml
# apps/api/backend/locale/en-US.yml
  customer:
    not_found: Customer does not exist
```

`backend/tests/test_i18n.py` 会检查两个语言包的键是否一致，以及代码里引用的键是否都存在。

## 第 6 步：写 api 并注册路由

`apps/api/backend/app/crm/api/v1/customer.py`：

```python
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.app.crm.schema.customer import (
    CreateCustomerParam,
    DeleteCustomerParam,
    GetCustomerDetail,
    UpdateCustomerParam,
)
from backend.app.crm.service.customer_service import customer_service
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction

router = APIRouter()


@router.get(
    '/{pk}',
    summary='获取客户详情',
    dependencies=[Depends(RequestPermission('crm:customer:list')), DependsRBAC],
)
async def get_customer(
    db: CurrentSession, pk: Annotated[int, Path(description='客户 ID')]
) -> ResponseSchemaModel[GetCustomerDetail]:
    data = await customer_service.get(db=db, pk=pk)
    return response_base.success(data=data)


@router.get(
    '',
    summary='分页获取客户',
    dependencies=[Depends(RequestPermission('crm:customer:list')), DependsRBAC, DependsPagination],
)
async def get_customers_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='客户名称')] = None,
    phone: Annotated[str | None, Query(description='联系电话')] = None,
    level: Annotated[int | None, Query(description='客户等级')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
) -> ResponseSchemaModel[PageData[GetCustomerDetail]]:
    page_data = await customer_service.get_list(db=db, name=name, phone=phone, level=level, status=status)
    return response_base.success(data=page_data)


@router.post(
    '',
    summary='创建客户',
    dependencies=[Depends(RequestPermission('crm:customer:add')), DependsRBAC],
)
async def create_customer(request: Request, db: CurrentSessionTransaction, obj: CreateCustomerParam) -> ResponseModel:
    await customer_service.create(db=db, obj=obj, user=request.user)
    return response_base.success()


@router.put(
    '/{pk}',
    summary='更新客户',
    dependencies=[Depends(RequestPermission('crm:customer:edit')), DependsRBAC],
)
async def update_customer(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='客户 ID')], obj: UpdateCustomerParam
) -> ResponseModel:
    await customer_service.update(db=db, pk=pk, obj=obj)
    return response_base.success()


@router.delete(
    '',
    summary='批量删除客户',
    dependencies=[Depends(RequestPermission('crm:customer:del')), DependsRBAC],
)
async def delete_customers(db: CurrentSessionTransaction, obj: DeleteCustomerParam) -> ResponseModel:
    await customer_service.delete(db=db, obj=obj)
    return response_base.success()
```

- 每个接口都要挂 `Depends(RequestPermission('…'))` + `DependsRBAC`，**读接口也一样**。没声明权限码的路由，`rbac_verify` 会直接放行，任何登录用户都能调
- `RequestPermission` 要写在 `DependsRBAC` 前面，依赖是按顺序执行的
- 读用 `CurrentSession`，写用 `CurrentSessionTransaction`（请求结束时自动提交）

`apps/api/backend/app/crm/api/v1/__init__.py`：

```python
from fastapi import APIRouter

from backend.app.crm.api.v1.customer import router as customer_router

router = APIRouter(prefix='/crm')

router.include_router(customer_router, prefix='/customers', tags=['客户管理'])
```

`apps/api/backend/app/crm/api/router.py`：

```python
from fastapi import APIRouter

from backend.app.crm.api.v1 import router as v1_router
from backend.core.conf import settings

v1 = APIRouter(prefix=settings.FASTAPI_API_V1_PATH)

v1.include_router(v1_router)
```

最后在 `apps/api/backend/app/router.py` 里挂上：

```python
from backend.app.crm.api.router import v1 as crm_v1
# …
router.include_router(crm_v1)
```

**验收**：用超管的 token 调接口。

```bash
curl -s "http://127.0.0.1:8088/api/v1/crm/customers?page=1&size=20" -H "Authorization: Bearer $TOKEN"
# {"code":200,"msg":"请求成功","data":{"items":[],"total":0,…}}

curl -s -X POST http://127.0.0.1:8088/api/v1/crm/customers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"华东机电","phone":"021-5555","level":2}'
# {"code":200,"msg":"请求成功","data":null}
```

再查一次列表，能看到这条记录。`id`、`dept_id`、`owner_id` 下发的都是字符串，比如 `"id":"2228321080542494720"`。

## 第 7 步：加菜单和按钮权限码

后端用到了 4 个权限码，菜单表里要有对应的按钮行。非超管用户的权限码都来自自己角色挂的菜单，权限码不在任何菜单上，他就会一直收到 403。

有两种加法：

- **只在自己的环境试一下**：去「系统管理 → 菜单管理」手动新建。先建一个目录「客户关系」（路由 `/crm`），再在下面建菜单「客户管理」（路由 `/crm/customer`），最后在菜单下建 4 个按钮，权限码分别填 `crm:customer:list` / `:add` / `:edit` / `:del`。这样建的菜单只存在于当前这个库里
- **要随代码一起交付**：按下面的做法，种子 SQL 和数据迁移两边都要加

### 为什么两边都要加？

| 库是怎么来的 | 菜单从哪来 |
|---|---|
| 全新环境 `fba init`（建表、灌种子、`stamp head`） | **种子 SQL**。数据迁移会被 stamp 标记成已执行，实际不会跑 |
| 已经在跑的库 `alembic upgrade head` | **数据迁移**。种子 SQL 不会重新执行 |

只加一边，总有一类环境缺菜单。

**种子 SQL**：在 `apps/api/backend/sql/{postgresql,mysql,sqlserver}/init_snowflake_test_data.sql` 末尾各追加一段。三个方言用同一套菜单 ID。PostgreSQL / MySQL 写法如下：

```sql
insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2049629108299000001, '客户关系', 'Crm', '/crm', 5, 'mdi:handshake-outline', 0, null, 1, 1, '', null, null, '2026-11-01 00:00:00', null),
(2049629108299000002, '客户管理', 'CrmCustomer', '/crm/customer', 1, 'mdi:account-tie-outline', 1, null, 1, 1, '', null, 2049629108299000001, '2026-11-01 00:00:00', null),
(2049629108299000003, '查询', 'QueryCrmCustomer', null, 0, null, 2, 'crm:customer:list', 1, 0, '', null, 2049629108299000002, '2026-11-01 00:00:00', null),
(2049629108299000004, '新增', 'AddCrmCustomer', null, 1, null, 2, 'crm:customer:add', 1, 0, '', null, 2049629108299000002, '2026-11-01 00:00:00', null),
(2049629108299000005, '修改', 'EditCrmCustomer', null, 2, null, 2, 'crm:customer:edit', 1, 0, '', null, 2049629108299000002, '2026-11-01 00:00:00', null),
(2049629108299000006, '删除', 'DeleteCrmCustomer', null, 3, null, 2, 'crm:customer:del', 1, 0, '', null, 2049629108299000002, '2026-11-01 00:00:00', null);
```

SQL Server 那份内容相同，只是写法不同：中文字面量前加 `N`（`N'客户关系'`），`null` 写成 `NULL`。验证时只有 PostgreSQL 这份真的灌进过库；MySQL 和 SQL Server 两份只过了静态检查 `test_seed_dialects.py`（三份的表、行数、列一致）。`type` 的取值：0 是目录，1 是菜单，2 是按钮。菜单 ID 自己挑一段没被占用的号，三个方言里要一致。

**数据迁移**：接在第 2 步生成的那个迁移文件后面，用 `backend/utils/data_migration.py` 里的辅助函数补菜单行：

```python
from backend.utils.data_migration import add_menu, delete_by_key, seeded_pk_mode

#: 和种子 SQL 里同一套 ID：升级上来的库和 `fba init` 新建的库收敛到同一份数据
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (2049629108299000001, 'Crm', '客户关系', '/crm', 'mdi:handshake-outline', 0, None, 5, 1, None),
    (2049629108299000002, 'CrmCustomer', '客户管理', '/crm/customer', 'mdi:account-tie-outline', 1, None, 1, 1, 'Crm'),
    (2049629108299000003, 'QueryCrmCustomer', '查询', None, None, 2, 'crm:customer:list', 0, 0, 'CrmCustomer'),
    (2049629108299000004, 'AddCrmCustomer', '新增', None, None, 2, 'crm:customer:add', 1, 0, 'CrmCustomer'),
    (2049629108299000005, 'EditCrmCustomer', '修改', None, None, 2, 'crm:customer:edit', 2, 0, 'CrmCustomer'),
    (2049629108299000006, 'DeleteCrmCustomer', '删除', None, None, 2, 'crm:customer:del', 3, 0, 'CrmCustomer'),
]


def upgrade() -> None:
    # …autogenerate 生成的 create_table / create_index 保持不动…

    if not seeded_pk_mode():
        return  # 自增主键模式没有基础种子，也就没有菜单要补
    conn = op.get_bind()
    for menu_id, name, title, path, icon, menu_type, perms, sort, display, parent in _MENUS:
        add_menu(
            conn,
            menu_id=menu_id,
            name=name,
            title=title,
            path=path,
            perms=perms,
            icon=icon,
            menu_type=menu_type,
            sort=sort,
            display=display,
            parent_name=parent,
        )


def downgrade() -> None:
    if seeded_pk_mode():
        conn = op.get_bind()
        # 倒序删：先按钮后目录，否则子项变孤儿被提到侧边栏根上
        for menu in reversed(_MENUS):
            delete_by_key(conn, 'sys_menu', name=menu[1])
    # …autogenerate 生成的 drop_index / drop_table…
```

`add_menu` 按 `name` 判断菜单是否已经存在，也按 `name` 去找父菜单。重复执行不会插入两遍，各个环境的父菜单 ID 不一样也不影响。

改了种子 SQL 之后，要更新种子清单（守卫测试会比对种子文件的哈希）：

```bash
cd apps/api && pnpm seed:manifest --write
```

**验收**：

- `pnpm db:upgrade` 之后，`select name, perms from sys_menu where name like '%Crm%'` 能查到 6 行
- `downgrade -1` 后这 6 行和 `crm_customer` 表都消失，`upgrade` 后又回来
- `app/admin/tests/security/test_permission_codes.py` 通过。它会核对后端 `RequestPermission`、前端 `<Can perm>` 和种子菜单这三边的权限码是否一致

## 第 8 步：写前端列表页

一个页面由三部分组成，缺一个都不行：

| 文件 | 作用 |
|---|---|
| `packages/platform/src/pages/customer/` | 页面组件，只通过 props 接收 search |
| `apps/web/src/routes/_auth/crm/customer.tsx` | 路由：只声明 search schema、守卫和标题，不渲染页面 |
| `apps/web/src/lib/page-registry.tsx` | 路由 ID 和页面组件的对应表，多页签靠它渲染隐藏的页签 |

页面目录的结构照 `pages/notice/` 写：

```
packages/platform/src/pages/customer/
├─ api.ts             类型 · query key · queryOptions · mutation
├─ columns.tsx        列定义 + 行操作（按钮用 <Can> 包住）
├─ form.tsx           新增 / 编辑抽屉（react-hook-form + zod）
├─ index.tsx          页面本体：QueryBar + DataTable + listState
└─ table-features.ts  TanStack Table v9 要注册的特性
```

### api.ts

```ts
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/** 雪花 ID 一律字符串，不要 `Number()`（硬纪律 6） */
export type Customer = {
  id: string
  name: string
  phone: string | null
  /** 0 普通 · 1 重要 · 2 VIP */
  level: number
  /** 0 停用 · 1 正常 */
  status: number
  dept_id: string | null
  owner_id: string | null
  created_by: string
  remark: string | null
  created_time: string
  updated_time: string | null
}

export type CustomerBody = {
  name: string
  phone: string | null
  level: number
  status: number
  remark: string | null
}

export type CustomerListParams = {
  page: number
  size: number
  name?: string
  phone?: string
  level?: number
  status?: number
}

/** 等级的中文即语言包 key，渲染处过 `t()` */
export const CUSTOMER_LEVEL_LABEL: Record<number, string> = { 0: '普通', 1: '重要', 2: 'VIP' }

const BASE = '/api/v1/crm/customers'

export const customerKeys = {
  all: ['crm', 'customer'] as const,
  list: (p: CustomerListParams) => [...customerKeys.all, 'list', p] as const,
}

function qs(p: CustomerListParams): string {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.name) s.set('name', p.name)
  if (p.phone) s.set('phone', p.phone)
  if (p.level !== undefined) s.set('level', String(p.level))
  if (p.status !== undefined) s.set('status', String(p.status))
  return s.toString()
}

export const customersQuery = (p: CustomerListParams) =>
  queryOptions({
    queryKey: customerKeys.list(p),
    queryFn: () => api.GET<PageData<Customer>>(`${BASE}?${qs(p)}`),
    // 翻页时保留上一页，避免表格闪空
    placeholderData: (prev) => prev,
  })

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: customerKeys.all })
}

export function useCreateCustomer() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: CustomerBody) => api.POST(BASE, { body }),
    onSuccess: invalidate,
    // 表单里内联显示后端的报错，全局 toast 再弹一遍只是噪音
    meta: { suppressErrorToast: true },
  })
}

export function useUpdateCustomer() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CustomerBody }) => api.PUT(`${BASE}/${id}`, { body }),
    onSuccess: invalidate,
    meta: { suppressErrorToast: true },
  })
}

export function useDeleteCustomers() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (pks: string[]) => api.DELETE(BASE, { body: { pks } }),
    onSuccess: invalidate,
  })
}
```

### table-features.ts

```ts
import { columnVisibilityFeature, rowPaginationFeature, rowSelectionFeature, tableFeatures } from '@tanstack/react-table'

/** 筛选 / 分页都在服务端；后端固定按 id 倒序、没有排序入参，所以不注册排序特性 */
export const features = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
})
```

### columns.tsx

```tsx
import { createColumnHelper } from '@tanstack/react-table'
import { IconDotsVertical, IconPencil, IconTrash } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'

import { Can } from '../../auth/can'
import { buildSelectColumn } from '../_shared/select-column'
import { StatusBadge, StatusPill } from '../_shared/status'
import { CUSTOMER_LEVEL_LABEL, type Customer } from './api'
import type { features } from './table-features'

const col = createColumnHelper<typeof features, Customer>()

type T = (k: string, vars?: Record<string, unknown>) => string

export function buildColumns(onEdit: (c: Customer) => void, onDelete: (c: Customer) => void, t: T) {
  return [
    buildSelectColumn(col, {}, t),
    col.accessor('name', {
      header: t('客户名称'),
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    col.accessor('phone', {
      header: t('联系电话'),
      cell: ({ getValue }) => <span className="tabular-nums">{getValue() ?? '—'}</span>,
    }),
    col.accessor('level', {
      header: t('等级'),
      cell: ({ getValue }) => (
        <StatusPill tone={getValue() === 2 ? 'warning' : getValue() === 1 ? 'info' : 'muted'}>
          {t(CUSTOMER_LEVEL_LABEL[getValue()] ?? '—')}
        </StatusPill>
      ),
    }),
    col.accessor('status', {
      header: t('状态'),
      cell: ({ getValue }) => <StatusBadge value={getValue()} />,
    }),
    col.accessor('created_time', {
      header: t('创建时间'),
      // 时间一律过 formatDateTime（接口下发的是带偏移的 ISO 串）
      cell: ({ getValue }) => <span className="text-sm tabular-nums text-muted-foreground">{formatDateTime(getValue())}</span>,
    }),
    col.display({
      id: 'actions',
      header: () => <span className="sr-only">{t('操作')}</span>,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: row.original.name })} />}
          >
            <IconDotsVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <Can perm="crm:customer:edit" fallback={null}>
              <DropdownMenuItem onClick={() => onEdit(row.original)}>
                <IconPencil className="size-4" />
                {t('编辑')}
              </DropdownMenuItem>
            </Can>
            <Can perm="crm:customer:del">
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(row.original)}>
                <IconTrash className="size-4" />
                {t('删除')}
              </DropdownMenuItem>
            </Can>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    }),
  ]
}

export const COLUMN_LABELS: Record<string, string> = {
  name: '客户名称',
  phone: '联系电话',
  level: '等级',
  status: '状态',
  created_time: '创建时间',
}
```

### form.tsx

```tsx
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@admin/ui/components/select'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@admin/ui/components/sheet'
import { Textarea } from '@admin/ui/components/textarea'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import { STATUS_FORM_ITEMS } from '../_shared/status'
import { CUSTOMER_LEVEL_LABEL, useCreateCustomer, useUpdateCustomer, type Customer } from './api'

// 长度和后端列一致（name 64 / phone 20）；后端的 ColumnLengthChecked 才是权威，这里只为当场报错
const schema = z.object({
  name: z.string().trim().min(1, '请输入客户名称').max(64),
  phone: z.string().max(20).optional(),
  level: z.number().int().min(0).max(2),
  status: z.number().int(),
  remark: z.string().max(500).optional(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = { name: '', phone: '', level: 0, status: 1, remark: '' }

export function CustomerFormSheet({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: Customer | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const create = useCreateCustomer()
  const update = useUpdateCustomer()
  const [err, setErr] = React.useState<string | null>(null)
  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            phone: editing.phone ?? '',
            level: editing.level,
            status: editing.status,
            remark: editing.remark ?? '',
          }
        : EMPTY
    )
  }, [open, editing, form])

  const levelItems = React.useMemo(
    () => Object.fromEntries(Object.entries(CUSTOMER_LEVEL_LABEL).map(([v, l]) => [v, t(l)])),
    [t]
  )
  const statusItems = React.useMemo(
    () => Object.fromEntries(Object.entries(STATUS_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )
  const errs = form.formState.errors
  const pending = create.isPending || update.isPending

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{editing ? t('编辑客户') : t('新增客户')}</SheetTitle>
          <SheetDescription>{t('新建的客户归属到你所在的部门，负责人默认是你。')}</SheetDescription>
        </SheetHeader>
        <form
          onSubmit={form.handleSubmit(async (v) => {
            setErr(null)
            const body = {
              name: v.name,
              phone: v.phone?.trim() || null,
              level: v.level,
              status: v.status,
              remark: v.remark?.trim() || null,
            }
            try {
              if (editing) await update.mutateAsync({ id: editing.id, body })
              else await create.mutateAsync(body)
              onOpenChange(false)
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : t('保存失败'))
            }
          })}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField label={t('客户名称')} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} autoComplete="off" />
            </FormField>
            <FormField label={t('联系电话')} error={fe(errs.phone?.message)}>
              <Input {...form.register('phone')} autoComplete="off" />
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('等级')} required>
                <Select
                  value={String(form.watch('level'))}
                  items={levelItems}
                  onValueChange={(v) => form.setValue('level', Number(v), { shouldValidate: true })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(levelItems).map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={t('状态')} required>
                <Select
                  value={String(form.watch('status'))}
                  items={statusItems}
                  onValueChange={(v) => form.setValue('status', Number(v), { shouldValidate: true })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(statusItems).map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField label={t('备注')} error={fe(errs.remark?.message)}>
              <Textarea rows={3} {...form.register('remark')} />
            </FormField>
            {err && <p className="text-sm text-destructive">{err}</p>}
          </div>
          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {editing ? t('保存修改') : t('创建客户')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
```

`level` 和 `status` 在这里用 `Number(v)` 转换没问题，它们是 0/1/2 这样的小枚举。ID 不能这样转。

### index.tsx

```tsx
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTable, type ColumnVisibilityState, type RowSelectionState } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { IconPlus } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { PageShell } from '../_shared/page-shell'
import { BulkBar, RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { useQuerySearch } from '../_shared/use-query-search'
import { customerKeys, customersQuery, useDeleteCustomers, type Customer, type CustomerListParams } from './api'
import { COLUMN_LABELS, buildColumns } from './columns'
import { CustomerFormSheet } from './form'
import { features } from './table-features'

/** 可筛字段。`key` 和接口入参同名，不用 `param` 映射 */
const FIELDS: FilterField[] = [
  { key: 'name', label: '客户名称', type: 'text', group: '基本信息', defaultVisible: true, placeholder: '模糊匹配' },
  { key: 'phone', label: '联系电话', type: 'text', group: '基本信息', defaultVisible: true, placeholder: '模糊匹配' },
  {
    key: 'level',
    label: '等级',
    type: 'select',
    group: '基本信息',
    defaultVisible: true,
    options: [
      { value: 0, label: '普通' },
      { value: 1, label: '重要' },
      { value: 2, label: 'VIP' },
    ],
  },
  {
    key: 'status',
    label: '状态',
    type: 'select',
    group: '状态',
    defaultVisible: true,
    options: [
      { value: 1, label: '正常' },
      { value: 0, label: '停用' },
    ],
  },
]

export type CustomerPageSearch = {
  page?: number
  size?: number
  /** 摆开但还没填值的格子（见 `_shared/use-query-search`） */
  f?: string
  name?: string
  phone?: string
  level?: number
  status?: number
}

/**
 * 客户管理。router-独立（硬纪律 1）：search 只从 props 进、改动经 `onSearchChange` 出，
 * 筛选与分页全进 URL（硬纪律 2）。
 */
export function CustomerPage({
  search = {},
  onSearchChange,
}: {
  search?: CustomerPageSearch
  onSearchChange?: (next: CustomerPageSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE

  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})

  // 换页 / 换筛选清掉选中：分页在服务端，留着的选中项已不在可见行里
  const patch = React.useCallback(
    (next: Partial<CustomerPageSearch>) => {
      setRowSelection({})
      onSearchChange?.({ ...search, ...next })
    },
    [onSearchChange, search]
  )

  const q = useQuerySearch({ fields: FIELDS, search, onSearchChange, refreshKey: customerKeys.all })
  const submitQuery = React.useCallback(
    (v: Parameters<typeof q.submit>[0]) => {
      setRowSelection({})
      q.submit(v)
    },
    [q]
  )
  const clearFilters = React.useCallback(() => {
    setRowSelection({})
    q.reset()
  }, [q])

  const listQuery = useQuery(customersQuery({ page, size, ...q.params } as CustomerListParams))
  const { data, isFetching } = listQuery
  // loading / busy / error / onRetry 一次摊开 —— 接口挂了显示错误块，不是「暂无数据」（硬纪律 9）
  const list = listState(listQuery, { onBeforeRefetch: () => setRowSelection({}) })
  const rows = data?.items ?? []
  const total = data?.total ?? 0

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Customer | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Customer | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const del = useDeleteCustomers()

  const columns = React.useMemo(
    () =>
      buildColumns(
        (c) => {
          setEditing(c)
          setSheetOpen(true)
        },
        setPendingDelete,
        t
      ),
    [t]
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility, rowSelection },
    getRowId: (row) => row.id,
    manualPagination: true,
    rowCount: total,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
  })

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])
  const hasFilter = countActive(q.applied, FIELDS) > 0

  return (
    <PageShell fill="always">
      <PageHeader title={t('客户管理')} description={t('维护客户档案；能看到哪些客户由数据权限决定。')} />

      <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
        <QueryBar
          fields={FIELDS}
          value={q.value}
          onChange={q.setValue}
          onSearch={submitQuery}
          onReset={clearFilters}
          applied={q.applied}
          loading={isFetching}
          viewsStorageKey="qb:customer"
          actions={
            <>
              <Can perm="crm:customer:add">
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null)
                    setSheetOpen(true)
                  }}
                >
                  <IconPlus className="size-4" />
                  {t('新增客户')}
                </Button>
              </Can>
              <RefreshButton busy={isFetching} onClick={list.onRetry} />
              <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
              <Can perm="crm:customer:del">
                <BulkBar count={selectedIds.length} pending={del.isPending} onDelete={() => setBulkOpen(true)} />
              </Can>
            </>
          }
        />

        <div className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col">
          <DataTable
            table={table}
            showColumnVisibility={false}
            rows={table.getRowModel().rows}
            columnCount={columns.length}
            columnLabels={COLUMN_LABELS}
            emptyMessage={t('还没有客户')}
            emptyAction={
              hasFilter ? (
                <ResetButton variant="outline" label={t('清除筛选')} onClick={clearFilters} />
              ) : undefined
            }
            {...list}
            pagination={{
              pageIndex: page - 1,
              pageCount: data?.total_pages ?? 1,
              pageSize: size,
              selectedCount: selectedIds.length,
              totalCount: total,
              onPageChange: (i) => patch({ page: i === 0 ? undefined : i + 1 }),
              onPageSizeChange: (s) => patch({ size: s, page: undefined }),
            }}
          />
        </div>
      </div>

      <CustomerFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除客户')}
        description={pendingDelete ? t('确定删除「{{name}}」吗？', { name: pendingDelete.name }) : ''}
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          try {
            await del.mutateAsync([pendingDelete.id])
          } finally {
            setPendingDelete(null)
          }
        }}
      />
      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => !o && setBulkOpen(false)}
        title={t('批量删除客户')}
        description={t('确定删除选中的 {{n}} 个客户吗？', { n: selectedIds.length })}
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          try {
            await del.mutateAsync(selectedIds)
            setRowSelection({})
          } finally {
            setBulkOpen(false)
          }
        }}
      />
    </PageShell>
  )
}
```

页面里有三处不能改：

- 页面组件**只能**通过 props 拿 `search` / `onSearchChange`，不能调 `Route.useSearch()` / `useNavigate()`。多页签会同时挂载所有打开的页签，隐藏页签拿不到路由的匹配上下文
- 取数状态用 `listState()` 一次拿全。如果自己只解构 `isPending` / `isFetching`，漏掉 `error`，接口失败时页面会显示「暂无数据」，和真的没数据分不出来
- 查询、重置、刷新的时候都要清掉 `rowSelection`。不清的话，批量删除会删到用户已经看不见的行

### 路由文件

`apps/web/src/routes/_auth/crm/customer.tsx`：

```tsx
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  /** 摆开但还没填值的格子 */
  f: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  level: z.coerce.number().int().optional(),
  status: z.coerce.number().int().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限（硬纪律 3） */
export const Route = createFileRoute("/_auth/crm/customer")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("crm:customer:list"),
  staticData: { title: "客户管理" },
  component: () => null,
})
```

路由的路径要和菜单里填的 `path`（`/crm/customer`）一致，否则菜单管理会把这条菜单标成死链，侧边栏也不会显示它。

如果以后要往 search 里放雪花 ID（比如 `?owner=…`），schema 里写成 `z.coerce.string()`，不要写 `z.coerce.number()`。

`apps/web/src/routeTree.gen.ts` 是 TanStack Router 插件生成的。新增路由文件后启动一次前端开发服务器（`pnpm --filter web dev`），它会自动更新。不更新的话，`createFileRoute("/_auth/crm/customer")` 会报类型错误。

### 注册页面

`apps/web/src/lib/page-registry.tsx`：

```tsx
import { CustomerPage } from "@admin/platform/pages/customer"

export const pageRegistry: PageRegistry = {
  // …
  "/_auth/crm/customer": CustomerPage,
}
```

`@admin/platform/pages/*` 已经在 `packages/platform/package.json` 的 `exports` 里声明过，`apps/web` 也已经依赖了 `@admin/platform`，所以这里不用改 `package.json`。

### 文案

页面里所有 `t('…')` 的 key 都要在 `packages/i18n/src/locales/zh-CN.json` 和 `en-US.json` 里有对应条目。中文语言包的 key 和值相同，英文语言包写译文。菜单标题也要加一条：`"menu:/crm/customer": "客户管理"`（英文写 `"Customers"`）。加完之后：

```bash
pnpm i18n:fix     # 排序
pnpm i18n:check   # 不能有 missing-keys
pnpm i18n:jsx     # 不能有裸露的 JSX 中文
```

**验收**：

```bash
pnpm typecheck --force   # 用 --force，turbo 的缓存会打印上一次的结果
pnpm arch:check          # 依赖方向、多页签纪律、registry
pnpm lint
```

以上全部通过后，用超管登录，侧边栏会出现「客户关系 → 客户管理」，列表里能看到第 6 步建的那条客户。

:::note
上面这几条命令都实际跑过并通过了。浏览器里的效果（侧边栏、表单交互）没有在验证时截图确认，第一次跑的时候请自己点一遍。
:::

## 第 9 步：让数据权限生效

数据权限本身不用写代码，第 4 步继承 `DataScopedCRUD` 时就已经接上了。这一步是用页面把它配出来，确认它真的在起作用。机制见[数据权限](/features/data-permissions/)。

1. **系统管理 → 角色管理**：新建一个角色（比如「销售」），在「功能权限」里勾上「客户管理」和下面的 4 个按钮。在「数据范围」里选种子数据自带的「本部门数据权限」，它的规则是 `__ALL__` 模型上的 `__dept_id__ == ${dept_id}`
2. **系统管理 → 用户管理**：新建一个用户，部门选「财务人事中心」，角色选「销售」。然后在这个用户的「权限与安全」里打开「后台登录」，不然他所有写操作都会被拒（见常见卡点）
3. 用这个用户登录

**验收**（实测结果）：

| 操作 | 超管 | 「销售」（财务人事中心） |
|---|---|---|
| `GET /crm/customers` | 两条都看得到 | 只看得到 `dept_id` 是财务人事中心的那条 |
| `GET /crm/customers/{总部那条的 id}` | 200 | **404** |
| `PUT` 总部那条 | 200 | **404**，数据没被改 |
| `DELETE` 总部那条 | — | 200，但**没有删掉任何行**（`get_visible_ids` 把它过滤掉了） |
| `POST` 不带 `dept_id` | — | 新客户归到财务人事中心，`owner_id` 和 `created_by` 都是这个用户自己 |

再看一下种子里另外几个演示角色：

- `VIEWER` 的「仅本人数据权限」规则是 `__created_by__ == ${user_id}`。表上有 `created_by` 列，所以这条规则能落到客户表上
- `MANAGER` 的两条规则都写在 `Dept` 模型上，查客户表时用不上，所以 `MANAGER` 能看到全部客户。一条规则只对它所写的模型生效

这两条是按 `filter_data_permission_for_user` 的代码推出来的，验证时没有用这两个角色实际登录测过。

:::caution
`__ALL__` 规则落到一张没有对应列的表上时，这条规则会被跳过。如果角色的规则全都被跳过了，结果就是**放行全部**。所以如果你希望客户表按部门过滤，表上就一定要有 `dept_id` 列，并且新建的数据要把它填上。
:::

## 第 10 步：写测试

新 app 的测试要先加到 `apps/api/pyproject.toml` 的 `testpaths` 里，否则 `pnpm test` 收集不到这些测试，而且不会给出任何提示：

```toml
testpaths = [
  "backend/app/admin/tests",
  "backend/app/task/tests",
  "backend/app/crm/tests",
  "backend/plugin",
  "backend/tests"
]
```

`apps/api/backend/app/crm/tests/test_customer.py`（同目录要有一个空的 `__init__.py`）：

```python
"""客户管理：接口走一遍 CRUD，再验受限用户碰不到范围外的客户"""

import asyncio

from types import SimpleNamespace

import pytest

from starlette.testclient import TestClient

from backend.app.crm.schema.customer import DeleteCustomerParam, UpdateCustomerParam
from backend.app.crm.service.customer_service import customer_service
from backend.common.exception import errors
from backend.common.security.data_scope import set_current_user
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

BASE = '/crm/customers'


def _restricted() -> SimpleNamespace:
    """开了范围过滤、一条规则都没有 —— fail-closed，什么都看不见"""
    scope = SimpleNamespace(status=1, rules=[])
    return SimpleNamespace(
        is_superuser=False, id=1, dept_id=1, roles=[SimpleNamespace(status=1, is_filter_scopes=True, scopes=[scope])]
    )


def _as_restricted(fn):  # noqa: ANN001, ANN202
    async def go():  # noqa: ANN202
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as db:
                set_current_user(_restricted())
                try:
                    return await fn(db)
                finally:
                    set_current_user(None)
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def customer(client: TestClient, token_headers: dict[str, str]):  # noqa: ANN201
    name = 'pytest-客户'
    res = client.post(BASE, headers=token_headers, json={'name': name, 'level': 1})
    assert res.json()['code'] == 200, res.text
    items = client.get(BASE, headers=token_headers, params={'name': name}).json()['data']['items']
    assert len(items) == 1
    yield items[0]
    client.request('DELETE', BASE, headers=token_headers, json={'pks': [int(items[0]['id'])]})


def test_crud(client: TestClient, token_headers: dict[str, str], customer: dict) -> None:
    pk = customer['id']
    assert isinstance(pk, str)  # 雪花 ID 下发成字符串（硬纪律 6）
    assert customer['created_by'] == customer['owner_id']  # 不传负责人 = 创建人

    res = client.put(f'{BASE}/{pk}', headers=token_headers, json={'name': 'pytest-客户-改', 'level': 2})
    assert res.json()['code'] == 200, res.text
    detail = client.get(f'{BASE}/{pk}', headers=token_headers).json()['data']
    assert detail['level'] == 2
    assert detail['dept_id'] == customer['dept_id']  # 没传的字段不能被冲成 NULL

    res = client.request('DELETE', BASE, headers=token_headers, json={'pks': [int(pk)]})
    assert res.json()['code'] == 200
    assert client.get(f'{BASE}/{pk}', headers=token_headers).status_code == 404


def test_restricted_user_cannot_touch_rows_outside_scope(
    client: TestClient, token_headers: dict[str, str], customer: dict
) -> None:
    pk = int(customer['id'])

    with pytest.raises(errors.NotFoundError):
        _as_restricted(lambda db: customer_service.update(db=db, pk=pk, obj=UpdateCustomerParam(name='越权')))
    assert _as_restricted(lambda db: customer_service.delete(db=db, obj=DeleteCustomerParam(pks=[pk]))) == 0

    # 超管视角：那一行还在、名字没被改
    assert client.get(f'{BASE}/{pk}', headers=token_headers).json()['data']['name'] == 'pytest-客户'
```

测试跑在单独的测试库 `<DATABASE_SCHEMA>_test` 上（`conftest.py` 替换了 `get_db`）。测试库要先重建，它会按当前模型建表、灌入种子并 stamp 到 head：

```bash
pnpm --filter api test:db
cd apps/api && uv run --no-sync pytest backend/app/crm/tests -rA
```

**验收**：`2 passed`。这两条测试都做过反向验证：把 service 里的 `get_visible_ids` 去掉，第二条测试会报 `assert 1 == 0`；把 `exclude_unset=True` 去掉，第一条测试会报 `dept_id` 变成了 `None`。

最后跑一遍和这次改动相关的守卫测试：

```bash
cd apps/api && uv run --no-sync pytest \
  backend/app/task/tests/test_migrations.py \
  backend/app/admin/tests/security/test_permission_codes.py \
  backend/app/admin/tests/security/test_data_scope_coverage.py \
  backend/app/admin/tests/api_v1/test_column_length_gate.py \
  backend/tests/test_seed_dialects.py backend/tests/test_i18n.py
```

## 常见卡点

| 现象 | 原因和修法 |
|---|---|
| 非超管用户访问列表、详情都正常，新增、修改、删除一律 403，提示「用户已被禁止后台管理操作」 | 除 `GET` / `OPTIONS` 之外的请求还要求用户的 `is_staff` 为真。在「用户管理 → 权限与安全」里打开「后台登录」。这个开关的说明文字写的是「登录后台」，但关掉后用户其实还能登录、能读，只是不能写 |
| 非超管用户点了按钮没反应，接口返回 403 | 权限码不在他任何一个角色的菜单上。给菜单加上按钮行，并在角色的「功能权限」里勾上。`test_permission_codes.py` 能查出「后端有这个码、种子菜单里没有」的情况 |
| 用户看不到某条数据，却能按 ID 改掉或删掉它 | 数据范围只作用在读操作上，`update_model_by_column` / `delete_model_by_column` 不过滤。写之前先用 `get()` / `get_visible_ids()` 收窄 |
| 配了「本部门」，用户还是能看到所有客户 | 表上没有 `dept_id` 列，`__ALL__` 规则被跳过，结果是放行全部。或者规则写在别的模型上（比如 `Dept`），对这张表不生效 |
| 新建的客户谁都看不见（超管除外） | 新建时没填 `dept_id`，`dept_id = ${dept_id}` 匹配不到 NULL。在 service 里给它默认值 |
| 只改了名字，客户的部门变成了空 | `PUT` 时用 `model_dump()` 把没传的字段也按默认值 `None` 写了进去。改成 `model_dump(exclude_unset=True)` |
| 接口返回 500，日志里是字符串被截断之类的数据库错误 | 写入参数没有混入 `ColumnLengthChecked`，超长的值直接到了数据库。加上 mixin 并设置 `__sa_model__` |
| 改了模型，接口报数据库里没有这个表或列 | 没生成迁移，或者生成了没执行 `pnpm db:upgrade`。`--reload` 不会改表 |
| SQL Server 上新表插入时报 `Cannot insert explicit value for identity column` | 迁移里 `id` 列缺了 `autoincrement=False`，被建成了 IDENTITY。手写建表迁移时要自己写上 |
| autogenerate 生成了一堆 `drop_table` | `alembic/env.py` 里的 `import backend.main` 被删了，metadata 是空的。不要提交这份迁移 |
| 新环境（`fba init`）没有「客户管理」菜单，或者老环境升级后没有 | 菜单只加在了数据迁移里，或者只加在了种子 SQL 里。两边都要加，然后跑 `seed:manifest --write` |
| 给已有表加了列以后，全新环境初始化失败 | 那张表的种子 SQL 是带显式列名的 INSERT，三个方言的 `init_snowflake_test_data.sql` 要一起改 |
| 列表里的 ID 和数据库对不上，改 A 却改到了 B | 前端对雪花 ID 用了 `Number()`，精度丢了。ID 一律当字符串处理，search 参数里用 `z.coerce.string()` |
| 页签切走再切回来，筛选条件不见了，或者隐藏页签报错 | 页面组件内部调用了 `Route.useSearch()` / `useNavigate()`。改成通过 props 接收，`pnpm arch:check` 会检查这一条 |
| 接口失败时列表显示「暂无数据」 | 没用 `listState()`，漏了 `error`。把 `{...list}` 传给 `DataTable` |
| 菜单管理把这一行标成死链 | 菜单的 `path` 和前端路由文件的路径不一致。另外路由文件和 `page-registry.tsx` 要成对出现，`pnpm arch:check` 会核对 registry |
| `pnpm i18n:check` 报 `missing-keys` | 新文案没有加到两个语言包里 |
| 写了测试，`pnpm test` 照样全绿，但其实没跑到 | 新 app 的 `tests/` 目录没加进 `pyproject.toml` 的 `testpaths` |
| 把模块拆成新的 workspace 包后，生产镜像构建报 `Cannot find module` | 只配了 alias / tsconfig 路径，没在依赖方的 `package.json` 里声明这个包。`pnpm arch:check` 会核对 |

## 相关源码

- [`backend/common/security/data_scope.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/data_scope.py)：`DataScopedCRUD`，以及它覆盖了哪几个读方法
- [`backend/common/security/permission.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/permission.py)：规则怎么编译成 `WHERE` 条件
- [`backend/common/security/rbac.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/rbac.py)：`rbac_verify`
- [`backend/common/model.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/model.py)：`Base`、`id_key`、`UniversalStr`
- [`backend/common/schema.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/schema.py)：`ColumnLengthChecked`
- [`backend/utils/data_migration.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/utils/data_migration.py)：`add_menu` / `grant_menu`
- [`backend/plugin/dict/`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/dict/)：一个完整的简单三层模块
- [`backend/app/router.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/router.py)：app 路由挂载点
- [`backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md)：迁移和种子数据的规则
- [`packages/platform/src/pages/notice/`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/notice/)：列表页范本
- [`packages/platform/src/pages/_shared/list-query.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/_shared/list-query.ts)：`listState()`
- [`packages/platform/src/pages/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/AGENTS.md)：列表页的写法规则
- [`apps/web/src/lib/page-registry.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/src/lib/page-registry.tsx)：页面注册表

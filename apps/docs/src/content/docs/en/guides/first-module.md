---
title: Add a business module from scratch
description: Build a real Customers module end to end, from model and migration through the three backend layers, menus and permissions, to a list page with data scopes.
sidebar:
  order: 1
---

This repository has no code generator. You write a new business module by hand, following how the existing modules are built. Each layer has a few rules. If you miss one, nothing reports an error and the feature still works, but permissions, data scopes or migrations end up wrong.

This page walks the whole chain with a **Customers** module (客户管理). Code comments are kept in Chinese, as in the repository:

```
model → Alembic migration → schema / crud / service / api → register router
      → menu and button permission codes → frontend list page → data scopes → tests
```

All the code below was actually run on a clean checkout: the migration was generated, upgraded and rolled back on PostgreSQL, the endpoints were called with curl, `pnpm typecheck --force`, `pnpm arch:check`, `pnpm lint` and `pnpm i18n:check` all passed, and the module tests plus the repository's own guard tests were green. Anything that was not verified is called out where it comes up.

Before you start, get the services running (see [Quick start](/en/getting-started/quick-start/)) and read hard rules 1–6 in the root `CLAUDE.md`.

## What does the module look like?

| Field | Type | Notes |
|---|---|---|
| `name` | string (64) | Customer name, required |
| `phone` | string (20) | Contact phone |
| `level` | integer | 0 normal · 1 important · 2 VIP |
| `status` | integer | 0 disabled · 1 active |
| `dept_id` | snowflake ID | Owning department. Data scopes filter on this column |
| `owner_id` | snowflake ID | Responsible user |
| `created_by` | snowflake ID | Creator. The "own data only" rule filters on this column |
| `remark` | long text | Notes |

The backend code goes into a new app, `apps/api/backend/app/crm/`, laid out like `app/task/`. You could make it a plugin instead (see `backend/plugin/dict/`), but plugins add `plugin.toml`, install and uninstall, which an ordinary business module does not need.

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

## Step 1: write the model

`apps/api/backend/app/crm/model/customer.py`:

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

`apps/api/backend/app/crm/model/__init__.py`:

```python
from backend.app.crm.model.customer import Customer as Customer
```

Notes:

- Inheriting `Base` gives you `created_time` / `updated_time` / `deleted` / `deleted_time`. `deleted` holds "0 or this row's own id", not a boolean, so hand-written SQL needs `deleted = 0`
- The primary key is `Mapped[id_key]`, a snowflake ID
- Columns that store Chinese text use `UniversalStr` / `UniversalText`, not `sa.String`. On SQL Server Chinese text needs `NVARCHAR`, and `UniversalStr` uses it automatically
- The model must live under `backend/app/<app>/model/`. Data scopes find models by that path (`utils/dynamic_import.py: get_app_models`)

**Check**: the model does not create its table by itself. If the migration in the next step sees `crm_customer`, the model was loaded.

## Step 2: generate the migration

After changing the model, generate a migration:

```bash
pnpm db:revision '客户管理 crm_customer'
```

alembic writes a file under `apps/api/backend/alembic/versions/`. **Read it before you commit it.** Look at three things:

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

1. **`id` has `autoincrement=False`.** `id_key` declares it, and autogenerate renders it. In a hand-written create-table migration you have to add it yourself, otherwise SQL Server creates the snowflake key as IDENTITY and inserts in production fail with `Cannot insert explicit value for identity column`
2. **Only this one table is created.** If the file contains a list of `drop_table` calls, the `import backend.main` line in `alembic/env.py` has been removed. Do not commit it
3. No other table should change beyond what you changed in the model

Then upgrade:

```bash
pnpm db:upgrade
pnpm db:current
```

**Check**: `pnpm db:current` shows the new revision with `(head)`. To confirm the migration rolls back, run `cd apps/api/backend && uv run --no-sync alembic downgrade -1` once, then `pnpm db:upgrade` again.

:::caution
Every model change needs a migration. `--reload` only re-imports the code; it does not change tables that already exist. The test `test_model_matches_migrations` compares the models with the database and fails if a migration is missing.
:::

## Step 3: write the schemas

`apps/api/backend/app/crm/schema/customer.py`:

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

Write parameter classes mix in `ColumnLengthChecked` and bind the model with `__sa_model__`. It reads the column lengths from the model to validate input, so you do not write `max_length` on each field. Without it, an over-long value goes all the way to the database and the endpoint returns 500.

Declaring `id` as `int` is fine. On the way out, `stringify_unsafe_ints` turns any value beyond JavaScript's safe integer range into a string.

**Check**: once the endpoints exist, submitting a 70-character `name` returns 422 with "name 最长 64 个字符，收到 70 个" (max 64 characters, got 70).

## Step 4: write the crud layer (DAO)

`apps/api/backend/app/crm/crud/crud_customer.py`:

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

Rules:

- **Use `DataScopedCRUD` as the base class, not `CRUDPlus`.** Lists (`select`) and details (`select_model`) automatically get the current user's data-scope condition. If a table really should not be filtered by data scope, write `data_scope_enabled = False` in the class and explain why in a comment. The test `test_every_crud_class_declares_its_data_scope_stance` checks that every DAO makes this choice
- **Data scopes apply to reads, not writes.** `update_model_by_column` / `delete_model_by_column` build UPDATE / DELETE statements directly and never go through `select()`. Measured: in the context of a user who can see nothing, `get()` returned `None` while `update()` still changed 1 row. So write operations must first narrow the targets with a scoped read (see the next step)
- **Paginated queries need an order** (`select_order`). SQL Server's `OFFSET … FETCH` requires `ORDER BY`
- **The `Select` you hand to pagination must not join many-to-many tables**, or `total` counts rows after the join and pages shift. This table has no many-to-many relation, so it does not apply here

## Step 5: write the service

`apps/api/backend/app/crm/service/customer_service.py`:

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

Error messages go through `t('error.<module>.<key>')`, not Chinese string literals. Add the key to both locale files:

```yaml
# apps/api/backend/locale/zh-CN.yml, under error:, alphabetically before data_rule
  customer:
    not_found: 客户不存在
```

```yaml
# apps/api/backend/locale/en-US.yml
  customer:
    not_found: Customer does not exist
```

`backend/tests/test_i18n.py` checks that both locale files have the same keys and that every key referenced in code exists.

## Step 6: write the API and register the router

`apps/api/backend/app/crm/api/v1/customer.py`:

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

- Every endpoint gets `Depends(RequestPermission('…'))` + `DependsRBAC`, **reads included**. For a route that declares no permission code, `rbac_verify` lets the request through, so any signed-in user can call it
- `RequestPermission` goes before `DependsRBAC`, because dependencies run in order
- Reads use `CurrentSession`; writes use `CurrentSessionTransaction` (committed when the request finishes)

`apps/api/backend/app/crm/api/v1/__init__.py`:

```python
from fastapi import APIRouter

from backend.app.crm.api.v1.customer import router as customer_router

router = APIRouter(prefix='/crm')

router.include_router(customer_router, prefix='/customers', tags=['客户管理'])
```

`apps/api/backend/app/crm/api/router.py`:

```python
from fastapi import APIRouter

from backend.app.crm.api.v1 import router as v1_router
from backend.core.conf import settings

v1 = APIRouter(prefix=settings.FASTAPI_API_V1_PATH)

v1.include_router(v1_router)
```

Finally, mount it in `apps/api/backend/app/router.py`:

```python
from backend.app.crm.api.router import v1 as crm_v1
# …
router.include_router(crm_v1)
```

**Check**: call the endpoints with a superuser token.

```bash
curl -s "http://127.0.0.1:8088/api/v1/crm/customers?page=1&size=20" -H "Authorization: Bearer $TOKEN"
# {"code":200,"msg":"请求成功","data":{"items":[],"total":0,…}}

curl -s -X POST http://127.0.0.1:8088/api/v1/crm/customers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"华东机电","phone":"021-5555","level":2}'
# {"code":200,"msg":"请求成功","data":null}
```

List again and the record is there. `id`, `dept_id` and `owner_id` all come back as strings, for example `"id":"2228321080542494720"`.

## Step 7: add the menu and button permission codes

The backend uses 4 permission codes, and the menu table needs a button row for each one. A non-superuser's permission codes come only from the menus attached to their roles. If a code is on no menu, that user always gets 403.

There are two ways to add them:

- **To try it in your own environment**: create them by hand in System → Menus. First a directory "客户关系" (CRM, path `/crm`), then a menu "客户管理" (Customers, path `/crm/customer`) under it, then 4 buttons under the menu with the codes `crm:customer:list` / `:add` / `:edit` / `:del`. Menus created this way exist only in that one database
- **To ship them with the code**: do what follows, adding them to both the seed SQL and a data migration

### Why add them in both places?

| How the database was created | Where its menus come from |
|---|---|
| New environment via `fba init` (create tables, load seed, `stamp head`) | **Seed SQL**. Data migrations are stamped as applied and never actually run |
| Existing database via `alembic upgrade head` | **Data migration**. The seed SQL never runs again |

If you add them in only one place, one kind of environment ends up without the menus.

**Seed SQL**: append a block to the end of each `apps/api/backend/sql/{postgresql,mysql,sqlserver}/init_snowflake_test_data.sql`. All three dialects use the same menu IDs. PostgreSQL / MySQL:

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

The SQL Server file has the same rows with different syntax: Chinese literals get an `N` prefix (`N'客户关系'`) and `null` becomes `NULL`. During verification only the PostgreSQL file was actually loaded into a database; the MySQL and SQL Server files only passed the static check `test_seed_dialects.py` (same tables, row counts and columns across the three). `type` is 0 for a directory, 1 for a menu and 2 for a button. Pick an unused range for the menu IDs and use the same values in all three dialects.

**Data migration**: extend the migration generated in step 2 and add the menu rows with the helpers in `backend/utils/data_migration.py`:

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

`add_menu` uses `name` both to decide whether the menu already exists and to find the parent. Running it twice does not insert twice, and it does not matter that parent IDs differ between environments.

After changing the seed SQL, update the seed manifest (a guard test compares the seed files' hashes):

```bash
cd apps/api && pnpm seed:manifest --write
```

**Check**:

- After `pnpm db:upgrade`, `select name, perms from sys_menu where name like '%Crm%'` returns 6 rows
- After `downgrade -1` those 6 rows and the `crm_customer` table are gone; after `upgrade` they are back
- `app/admin/tests/security/test_permission_codes.py` passes. It checks that the permission codes in backend `RequestPermission`, frontend `<Can perm>` and the seed menus agree

## Step 8: write the frontend list page

A page has three parts, and all three are required:

| File | Role |
|---|---|
| `packages/platform/src/pages/customer/` | The page component; it receives search only through props |
| `apps/web/src/routes/_auth/crm/customer.tsx` | The route: declares only the search schema, guard and title; renders nothing |
| `apps/web/src/lib/page-registry.tsx` | Maps route IDs to page components; multi-tab uses it to render hidden tabs |

Lay out the page folder like `pages/notice/`:

```
packages/platform/src/pages/customer/
├─ api.ts             types · query keys · queryOptions · mutations
├─ columns.tsx        column definitions + row actions (buttons wrapped in <Can>)
├─ form.tsx           create / edit sheet (react-hook-form + zod)
├─ index.tsx          the page: QueryBar + DataTable + listState
└─ table-features.ts  features registered with TanStack Table v9
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

Converting `level` and `status` with `Number(v)` is fine here; they are small enums like 0/1/2. Never convert IDs this way.

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
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
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
    </div>
  )
}
```

Three things in the page must stay as they are:

- The page component gets `search` / `onSearchChange` **only** through props and never calls `Route.useSearch()` / `useNavigate()`. Multi-tab keeps every open tab mounted at once, and hidden tabs have no route match context
- Fetch state comes from `listState()` in one go. If you destructure only `isPending` / `isFetching` and leave out `error`, a failed request shows "no data", which looks exactly like a genuinely empty list
- Clear `rowSelection` on search, reset and refresh. Otherwise bulk delete hits rows the user can no longer see

### The route file

`apps/web/src/routes/_auth/crm/customer.tsx`:

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

The route path must match the `path` on the menu (`/crm/customer`). Otherwise Menus marks the entry as a dead link and the sidebar does not show it.

If you later put a snowflake ID in search (such as `?owner=…`), declare it as `z.coerce.string()`, not `z.coerce.number()`.

`apps/web/src/routeTree.gen.ts` is generated by the TanStack Router plugin. After adding a route file, start the frontend dev server once (`pnpm --filter web dev`) and it updates the file. Until then, `createFileRoute("/_auth/crm/customer")` is a type error.

### Register the page

`apps/web/src/lib/page-registry.tsx`:

```tsx
import { CustomerPage } from "@admin/platform/pages/customer"

export const pageRegistry: PageRegistry = {
  // …
  "/_auth/crm/customer": CustomerPage,
}
```

`@admin/platform/pages/*` is already in the `exports` of `packages/platform/package.json`, and `apps/web` already depends on `@admin/platform`, so no `package.json` change is needed here.

### Strings

Every `t('…')` key in the page needs an entry in both `packages/i18n/src/locales/zh-CN.json` and `en-US.json`. In the Chinese file the key and the value are the same; the English file holds the translation. Add the menu title too: `"menu:/crm/customer": "客户管理"` (`"Customers"` in English). Then:

```bash
pnpm i18n:fix     # sort keys
pnpm i18n:check   # must have no missing-keys
pnpm i18n:jsx     # must have no bare Chinese JSX text
```

**Check**:

```bash
pnpm typecheck --force   # --force: a turbo cache hit prints the previous run's log
pnpm arch:check          # dependency direction, multi-tab rules, registry
pnpm lint
```

Once all of these pass, sign in as the superuser: the sidebar shows 客户关系 → 客户管理 (CRM → Customers), and the list shows the customer created in step 6.

:::note
All the commands above were actually run and passed. What it looks like in the browser (sidebar, form interaction) was not confirmed with screenshots during verification, so click through it yourself the first time.
:::

## Step 9: make data scopes take effect

Data scopes need no code: they were wired in when the DAO inherited `DataScopedCRUD` in step 4. This step configures them in the UI and confirms they actually work. For how they work, see [Data permissions](/en/features/data-permissions/).

1. **System → Roles**: create a role (say "Sales"). Under Permissions, tick 客户管理 (Customers) and its 4 buttons. Under Data scope, choose the seeded scope 本部门数据权限 (own department), whose rule is `__dept_id__ == ${dept_id}` on the `__ALL__` model
2. **System → Users**: create a user in the department 财务人事中心 (Finance & HR) with the role "Sales". Then open that user's Permissions & security and turn on Admin sign-in; otherwise every write they make is rejected (see Common snags)
3. Sign in as that user

**Check** (measured results):

| Action | Superuser | "Sales" (Finance & HR) |
|---|---|---|
| `GET /crm/customers` | Sees both rows | Sees only the row whose `dept_id` is Finance & HR |
| `GET /crm/customers/{id of the HQ row}` | 200 | **404** |
| `PUT` on the HQ row | 200 | **404**; the row is unchanged |
| `DELETE` on the HQ row | — | 200, but **no row is deleted** (`get_visible_ids` filtered it out) |
| `POST` without `dept_id` | — | The new customer belongs to Finance & HR; `owner_id` and `created_by` are this user |

What about the other seeded demo roles?

- `VIEWER`'s "own data only" rule is `__created_by__ == ${user_id}`. The table has a `created_by` column, so this rule applies to customers
- Both of `MANAGER`'s rules are on the `Dept` model, which a customer query does not involve, so `MANAGER` sees every customer. A rule applies only to the model it is written for

These two points are inferred from the code of `filter_data_permission_for_user`; neither role was signed in and tested during verification.

:::caution
When an `__ALL__` rule meets a table without the matching column, that rule is skipped. If every rule of a role is skipped, the result is **allow everything**. So if customers should be filtered by department, the table must have a `dept_id` column and new rows must fill it in.
:::

## Step 10: write tests

First add the new app's tests to `testpaths` in `apps/api/pyproject.toml`. Otherwise `pnpm test` does not collect them, and nothing tells you:

```toml
testpaths = [
  "backend/app/admin/tests",
  "backend/app/task/tests",
  "backend/app/crm/tests",
  "backend/plugin",
  "backend/tests"
]
```

`apps/api/backend/app/crm/tests/test_customer.py` (with an empty `__init__.py` next to it):

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

Tests run against a separate database, `<DATABASE_SCHEMA>_test` (`conftest.py` overrides `get_db`). Rebuild it first; this creates the tables from the current models, loads the seed and stamps it at head:

```bash
pnpm --filter api test:db
cd apps/api && uv run --no-sync pytest backend/app/crm/tests -rA
```

**Check**: `2 passed`. Both tests were checked in reverse: removing `get_visible_ids` from the service makes the second test fail with `assert 1 == 0`, and removing `exclude_unset=True` makes the first one fail because `dept_id` becomes `None`.

Finally, run the guard tests related to this change:

```bash
cd apps/api && uv run --no-sync pytest \
  backend/app/task/tests/test_migrations.py \
  backend/app/admin/tests/security/test_permission_codes.py \
  backend/app/admin/tests/security/test_data_scope_coverage.py \
  backend/app/admin/tests/api_v1/test_column_length_gate.py \
  backend/tests/test_seed_dialects.py backend/tests/test_i18n.py
```

## Common snags

| Symptom | Cause and fix |
|---|---|
| A non-superuser can list and view, but every create, update and delete returns 403 with "用户已被禁止后台管理操作" (admin operations disabled) | Requests other than `GET` / `OPTIONS` also require `is_staff`. Turn on Admin sign-in under Users → Permissions & security. The switch's description says it controls signing in, but with it off the user can still sign in and read; only writes are blocked |
| A non-superuser clicks a button and nothing happens; the endpoint returns 403 | The permission code is not on any menu of the user's roles. Add the button row to the menu and tick it under the role's Permissions. `test_permission_codes.py` catches "the backend uses this code but no seed menu has it" |
| A user cannot see a record but can update or delete it by ID | Data scopes only apply to reads; `update_model_by_column` / `delete_model_by_column` are not filtered. Narrow the targets with `get()` / `get_visible_ids()` before writing |
| The role has "own department", but the user still sees every customer | The table has no `dept_id` column, so the `__ALL__` rule is skipped and everything is allowed. Or the rule is on another model (such as `Dept`) and does not apply to this table |
| New customers are invisible to everyone except the superuser | `dept_id` was not filled in on create, and `dept_id = ${dept_id}` never matches NULL. Give it a default in the service |
| After renaming a customer, its department is empty | The `PUT` used `model_dump()`, which also writes fields that were not sent, as `None`. Use `model_dump(exclude_unset=True)` |
| The endpoint returns 500 and the log shows a database error such as string truncation | The write parameters do not mix in `ColumnLengthChecked`, so an over-long value reached the database. Add the mixin and set `__sa_model__` |
| After a model change, the database says the table or column does not exist | No migration was generated, or it was not applied with `pnpm db:upgrade`. `--reload` does not change tables |
| On SQL Server, inserts into the new table fail with `Cannot insert explicit value for identity column` | The migration's `id` column lacks `autoincrement=False` and was created as IDENTITY. Add it yourself in hand-written create-table migrations |
| autogenerate produced a list of `drop_table` calls | `import backend.main` was removed from `alembic/env.py`, so the metadata is empty. Do not commit that migration |
| New environments (`fba init`) have no Customers menu, or upgraded ones don't | The menus were added only to the data migration, or only to the seed SQL. Add them to both, then run `seed:manifest --write` |
| After adding a column to an existing table, initializing a new environment fails | That table's seed SQL is an INSERT with explicit column names; update `init_snowflake_test_data.sql` for all three dialects |
| IDs in the list do not match the database; editing A changes B | The frontend ran `Number()` on a snowflake ID and lost precision. Treat IDs as strings everywhere and use `z.coerce.string()` in search params |
| Switching away from a tab and back loses the filters, or a hidden tab throws | The page component calls `Route.useSearch()` / `useNavigate()`. Take them through props instead; `pnpm arch:check` checks this |
| The list shows "no data" when the request failed | `listState()` was not used and `error` was dropped. Spread `{...list}` into `DataTable` |
| Menus marks the entry as a dead link | The menu's `path` does not match the frontend route path. The route file and `page-registry.tsx` also have to come in pairs; `pnpm arch:check` checks the registry |
| `pnpm i18n:check` reports `missing-keys` | New strings were not added to both locale files |
| You wrote tests and `pnpm test` is green, but they never ran | The new app's `tests/` directory is not in `testpaths` in `pyproject.toml` |
| After splitting the module into a new workspace package, the production image build fails with `Cannot find module` | Only an alias / tsconfig path was added; the package was not declared in the dependent's `package.json`. `pnpm arch:check` checks this |

## Related source

- [`backend/common/security/data_scope.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/data_scope.py): `DataScopedCRUD` and which read methods it overrides
- [`backend/common/security/permission.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/permission.py): how rules compile into a `WHERE` condition
- [`backend/common/security/rbac.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/rbac.py): `rbac_verify`
- [`backend/common/model.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/model.py): `Base`, `id_key`, `UniversalStr`
- [`backend/common/schema.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/schema.py): `ColumnLengthChecked`
- [`backend/utils/data_migration.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/utils/data_migration.py): `add_menu` / `grant_menu`
- [`backend/plugin/dict/`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/dict/): a complete, simple three-layer module
- [`backend/app/router.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/router.py): where app routers are mounted
- [`backend/alembic/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/alembic/AGENTS.md): rules for migrations and seed data
- [`packages/platform/src/pages/notice/`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/notice/): the reference list page
- [`packages/platform/src/pages/_shared/list-query.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/_shared/list-query.ts): `listState()`
- [`packages/platform/src/pages/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/AGENTS.md): rules for list pages
- [`apps/web/src/lib/page-registry.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/src/lib/page-registry.tsx): the page registry

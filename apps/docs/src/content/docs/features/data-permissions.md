---
title: 数据权限（RBAC + 行级数据范围）
description: 管菜单、按钮、接口的 RBAC，加上行级数据范围：角色的规则编译成一条 SQL WHERE 条件，在 DAO 层自动套到每次读取上。
sidebar:
  order: 1
---

fastapi-react-admin 的权限分两道互相独立的闸。**RBAC** 管「能不能进这个页面、看到这个按钮、调这个接口」，靠 `sys:user:list` 这样的权限码；**数据范围**管「这个接口返回哪些行」：角色上配的规则被编译成一条 SQLAlchemy `WHERE` 条件，DAO 层在每次读取时自动拼上去。于是同一张用户表，部门经理可以只看到本部门的人。

## RBAC 和数据范围有什么区别？

| | RBAC（权限码） | 数据范围（行级） |
|---|---|---|
| 回答的问题 | 这个人能不能调 `GET /sys/users`？ | 调了之后能看到哪些用户？ |
| 在哪配 | **系统管理 → 菜单管理**（按钮上的权限码）+ **系统管理 → 角色管理 → 功能权限** | **系统管理 → 数据权限** + **系统管理 → 角色管理 → 数据范围** |
| 在哪拦 | [`rbac.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/rbac.py) 的 `rbac_verify`，按接口 | [`data_scope.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/data_scope.py) 的 `DataScopedCRUD`，按 DAO |
| 被拒的表现 | HTTP 403 | 行变少（详情接口是 404） |

## 菜单、按钮、接口的 RBAC 是怎么判的？

菜单在 `sys_menu` 里（type 0 目录、1 菜单、2 按钮），按钮行的 `perms` 字段放逗号分隔的权限码，角色绑定菜单。接口自己声明要哪个码：

```python
@router.get(
    '/{pk}',
    summary='获取用户信息',
    dependencies=[Depends(RequestPermission('sys:user:list')), DependsRBAC],
)
```

`rbac_verify` 按顺序判：超管直接放行；用户至少要有一个启用的角色，角色至少挂了一个菜单；`GET` / `OPTIONS` 以外的请求还要求 `is_staff`（后台管理操作权限）；最后，接口的权限码必须出现在某个启用角色、某个启用菜单的 `perms` 里。菜单「启用」指的是**它和每一级上级**都启用 —— 停用一个目录，下面按钮的权限码一起失效。

前端登录后从 `/auth/codes` 拉一次权限码：[`<Can perm="…">`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/auth/can.tsx) 控制按钮显隐，路由 `beforeLoad` 里的 `requirePerm()` 无权限时跳 `/403`。这两处都只管显示，真正的边界在后端。

:::caution
没有声明权限码的路由，`rbac_verify` 直接放行（提前 return）。读接口也必须挂权限码：issue #30 之前，`/sys/users`、`/logs/opera` 等几个 `GET` 接口只校验了登录，一个只绑了「仪表盘」的账号就能拿到全量用户列表。
:::

## 一条数据规则是怎么变成 SQL 条件的？

链路是 **角色 → 数据范围（`sys_data_scope`）→ 数据规则（`sys_data_rule`）→ 一个条件**。数据范围只是一捆规则的名字；规则有五个字段，拿种子数据里的一条举例：

| 字段 | 值 | 含义 |
|---|---|---|
| 模型 | `__ALL__` | 所有带这一列的模型；也可以写具体模型名，如 `Dept`、`User` |
| 字段 | `__dept_id__` | 字段模板，解析成 `dept_id`；另一个字段模板是 `__created_by__` |
| 运算符 | `AND` | `AND` 或 `OR`，见下一节 |
| 表达式 | `==` | 另有 `!=`、`>`、`>=`、`<`、`<=`、`in`、`not in` |
| 值 | `${dept_id}` | 当前用户的部门；另有 `${user_id}`、`${now}` |

落到 `User` 模型上就是 `sys_user.dept_id = <当前用户的 dept_id>`。`Dept` 上没有 `dept_id` 这一列，所以同一条规则对部门列表不起作用。

[`filter_data_permission_for_user()`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/permission.py) 的求值顺序：

1. 超管 → 不过滤。
2. 只要有一个启用的角色关掉了「启用数据权限过滤」→ 不过滤。
3. 把所有启用角色、所有启用数据范围里的规则收进**同一个集合**。开了过滤却一条规则都没有 → **一行都看不到**。
4. 编译出适用于本次查询模型的条件，再组合：

```python
where_list = []
if where_and_list:
    where_list.append(and_(*where_and_list))
if where_or_list:
    where_list.append(or_(*where_or_list))
return or_(*where_list) if where_list else or_(1 == 1)
```

最后那个 `or_(1 == 1)` 只兜「规则都没问题、但没有一条打在这个模型上」的情况 —— 一条打在 `User` 上的规则不会把部门藏起来。

## 为什么一条 OR 规则能抬掉所有 AND 规则？

因为上面的形状是 `or_(and_(全部 AND), or_(全部 OR))`。配了「`parent_id == RA`（AND）」和「`status == 1`（OR）」，结果是并集而不是交集，OR 那条把限制整个抬掉了。规则在这一步之前已经跨数据范围、**跨角色**拍平，所以来自两个不同角色的 AND 规则同样是求交集。数据权限页上，只要一个数据范围里同时有 AND 和 OR 规则，就会挂一条告警。

## 一个人有多个角色时怎么算？

取**最宽**的。只要有一个启用角色关掉了过滤，其它角色配的限制一条都不看 —— 给人加角色是「加能力」，同时也在「减限制」。停用的角色、停用的数据范围不参与。

## 要在每个接口上手动挂过滤吗？

不用。JWT 中间件认证通过后把当前用户放进 `ContextVar`，`DataScopedCRUD` 基类在 `select()`、`select_model()`（按主键取详情）和 `count()` 三处把条件拼上。只覆盖 `select()` 会漏掉详情接口：现在对范围外的部门请求 `GET /sys/depts/{pk}`，返回的是 404，而不是那条数据。

每个 DAO 都必须表态：要么继承默认（过滤），要么显式写 `data_scope_enabled = False` 并注明理由。有一条测试扫描所有 `crud_*.py`，还有类直接继承 `CRUDPlus` 就红；另一条核对豁免清单和代码是否一致。目前受数据范围约束的有：用户、部门、角色、文件、登录 / 操作日志、定时任务及执行记录。豁免的理由都写在 [`test_data_scope_coverage.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/security/test_data_scope_coverage.py) 里，例如：菜单（滤掉会让侧边栏空白）、字典与参数配置（表单下拉依赖它们）、规则表和范围表自身（会把管理员自己锁在外面）、公告（表里没有可过滤的归属字段）。

## 后台任务（Celery）里会怎样？

没有请求就没有「当前用户」，没有当前用户就**不过滤** —— 对清理日志、CLI、启动期代码这是对的。但凡是**代替某个人**读写业务数据的代码，必须显式声明身份：

```python
with scoped_to_user(user):
    async with async_db_session() as db:
        stmt = _restrict_ids(await spec.select(filters, user), spec, ids)
        ...
```

这段来自导出的 worker（[`export_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/service/export_service.py)）：不这么写的话，一个只能看本部门的人发起的大批量导出，在 worker 里会查回全表，而且不报错。`scoped_to_user(None)` 会故意抛 `ValueError`。[AI 助手](/features/ai-assistant/)的每一次工具调用也走同一个 `scoped_to_user`。反方向的 `bypass_data_scope()` 只给请求里「不展示给用户」的系统内部读用，比如登录时查用户、新建时的唯一性检查。

## 规则配错了会怎样？

两道防线：

- **保存时校验**（[`data_rule_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/service/data_rule_service.py)）：模型或字段不存在、用了被排除的字段（`id`、`sort`、`deleted`、`deleted_time`、`created_time`、`updated_time`）、值转不成列的类型（给 bigint 列配 `abc`）、`__ALL__` 配裸字段名 —— 直接拒绝并说明原因。
- **运行时 fail-closed**：只要有一条规则读不懂，整个过滤器收紧成 `false()`，一行都看不到。模板变量取不到值（没有部门的用户遇到 `${dept_id}`）时，这条规则匹配不到任何行，而不是把字面量 `'${dept_id}'` 拼进 SQL（在 SQL Server 上那会直接 500）。

早期版本遇到落不到列上的规则是直接跳过的。种子里的「本部门数据权限」当时配的是 `Dept.__dept_id__`，而 `sys_dept` 没有 `dept_id` 这一列 —— 名字叫「本部门」，实际效果是全部部门可见，界面上没有任何提示。

## 改了权限要重新登录吗？

不用。用户的权限快照（Redis 键 `fba:user:<id>`）会在角色、数据范围、规则变更时被清掉，下一个请求重新生成。后端测试和浏览器端到端测试都验证了「不重新登录就生效」。

## 做不到的事

- 值模板只有 `${user_id}`、`${dept_id}`、`${now}` 三个，没有「本部门及所有下级部门」这种模板。种子里的「部门及以下数据权限」是用写死总部（HQ）编码和 ID 的两条规则拼出来的。
- `DataScopedCRUD` 只管读。它不改写 `UPDATE` / `DELETE` 语句，所以不先经过受控 DAO 读一遍、直接按 ID 改数据的写路径，不在数据范围的保护之内。
- `exists()` 刻意不过滤：它被用来做唯一性校验，过滤之后用户会因为「看不见」而建出一条重复记录。
- 上级部门被过滤掉时，可见的子部门会被提到树的顶层。
- 超管永远不过滤。开放接口（AK/SK 签名）刻意读全量数据，它的边界靠「每个应用被授权调哪些接口」和「对外 schema 只放哪些字段」来守。

## 代码在哪

- [`common/security/permission.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/permission.py) —— `RequestPermission`、规则编译
- [`common/security/data_scope.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/data_scope.py) —— `DataScopedCRUD`、`scoped_to_user`、`bypass_data_scope`
- [`common/security/rbac.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/rbac.py) —— `rbac_verify`、`user_has_perm`
- [`core/conf.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/core/conf.py) —— `DATA_PERMISSION_*` 模板变量与排除清单
- [`pages/data-permission/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/data-permission)、[`pages/role/role-scopes.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/role/role-scopes.tsx) —— 管理界面

## 怎么测的

- [`test_data_permission.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/api_v1/test_data_permission.py) —— 29 条。自己建一整张图（5 个部门、17 条规则、18 个数据范围、20 个角色、23 个用户），每个用户真实登录，断言真实接口到底返回了哪些行。
- [`test_data_permission_failclosed.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/security/test_data_permission_failclosed.py)（8 条）、[`test_data_rule_validation.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/security/test_data_rule_validation.py)（9 条）、`test_data_scope_coverage.py`（10 条）。
- [`data-permission.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/data-permission.spec.ts) —— Playwright 多账号：部门页实际渲染出来的行、AND/OR 告警，以及在界面上新建一条规则后，目标账号刷新一下就受限。

CI 上后端全套在 PostgreSQL 和 SQL Server 各跑一遍（见[数据库](/features/databases/)）。

## 在演示环境里看一眼

用 `admin` / `123456` 登录[在线演示](https://fra.wubunan.com/sign-in)，打开 **系统管理 → 数据权限**。按种子数据，「部门及以下数据权限」这个范围里一条是 OR、一条是 AND，所以会显示上面说的那条告警。**系统管理 → 角色管理 → 数据范围** 能看到每个角色绑了哪些范围。`admin` 是超管，永远不被过滤；想看过滤效果，新建一个用户、给他一个开了过滤的角色，再用这个用户登录。演示环境是公开的，数据可能被别人改动。

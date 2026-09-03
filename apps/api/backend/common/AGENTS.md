# apps/api/backend/common —— 跨模块的公共层

`schema` / `exception` / `response` / `cache` / `i18n` / `pagination` /
`security` 都在这里。鉴权与数据权限单独一册：
[`security/AGENTS.md`](security/AGENTS.md)。

## 写入侧的字符串长度：靠模型列长度校验，不逐个写 `max_length`

⚠️ **前端限了、后端一个字没限。** `dept/form.tsx` 里 `leader` 是 `max(20)`，
后端 schema 是裸 `str | None`，列是 `UniversalStr(32)` —— 三个数字互不相同。
超出列长度的表现是**裸 SQL 错误冒到 500**（实测 33 个字符就触发）：

```
pyodbc.ProgrammingError: ('42000', "... String or binary data would be
truncated in table 'fba_test.dbo.sys_dept', column 'leader' ...")
```

🔴 **这个洞不能靠全局异常处理器兜。** 加了
（`exception_handler.py: dbapi_exception_handler`，把三种方言的「值太长」
翻译成 400），但它**盖不住 INSERT/UPDATE 这条路**：`get_db_transaction` 是在
`begin()` 里 `yield` 的，commit 发生在**依赖收尾**，那时已经出了异常处理器的
覆盖范围 —— 实测加了处理器之后冒出来的变成 `ContextDoesNotExistError`
（连 starlette-context 都拆了）。**写入侧的闸门只能在 schema 那层。**

🔴 **也不逐个字段写 `max_length=32`。** 实测数过：全仓 **88 个**带长度的字符串列，
Create/Update 系列里缺 `max_length` 的可写字符串字段 **327 处**（约 50 个不同
字段）。逐个写就是 327 个会和列定义分叉的数字，而分叉的表现又是那条裸 SQL 错误。

用 `common/schema.py` 的 `ColumnLengthChecked` mixin：从绑定模型的 `__table__`
**现读**列长度，不可能对不上。一个 schema 一行：

```python
class CreateDeptParam(ColumnLengthChecked, DeptSchemaBase):
    __sa_model__ = Dept
```

报错是 422 + **字段名 + 上限**（「leader 最长 32 个字符，收到 40 个」）。

⚠️ 只给「字段确实对应模型列」的 param 类绑。`UpdateRoleMenuParam` 那种
（字段是一串 ID）绑上去无害但误导，第一版误绑了 5 个，已撤。

⚠️ 已绑用户真能在界面上编辑的那批（dept / role / menu / user /
dict-data / dict-type / notice / config），三个插件端点实测都给出干净的
422 + 字段名 + 上限。日志类的 `UpdateOperaLogParam` / `UpdateLoginLogParam`
是中间件自己写的、不经用户输入，暂时没绑 —— 要绑就是加一行 `__sa_model__`。

⚠️ **子类不要再插一遍 mixin。** `UpdateConfigsParam(UpdateConfigParam)` 那种，
父类已经带了，再写成 `(ColumnLengthChecked, UpdateConfigParam)` 直接
`TypeError: Cannot create a consistent method resolution order`，
而且是**插件注入时**才炸（`PluginInjectError`），错误信息里看不出是 MRO 的事。
子类什么都不用写，mixin 和 `__sa_model__` 都继承得到。

两条守卫测试（`test_column_length_gate.py`）：该绑的都绑了 · 绑的模型按命名
约定对得上。第二条的判据**不能写成「至少有一个字段对得上」** —— 第一版就是
那样，而突变（把 menu 的 schema 绑到 `Role`）照旧全绿，因为两个模型都有
`name` / `remark` 这种同名带长度的列。按模型名核对才区分得开。

## 分页的 Select 里不能有 m2m join

🔴 **交给 `paging_data` 的那个 `Select` 只能一行一条记录。** m2m join 会让一条
记录按关联数量重复成多行，而 `total` 和 `LIMIT` 都作用在 join **之后**的行上，
去重（`select_join_serialize`）却发生在**分页之后**。

用户列表就是这么错的（`crud_user.get_select` 里 join 了 `sys_user_role` + `sys_role`，
为了在列表上直接显示角色名）。一个挂两个角色的用户造成三个症状：

| 症状 | 实测 |
|---|---|
| `total` 数的是 join 行数 | 11 个用户报 `total=12` |
| 每页被重复行偷名额 | `size=20` 的第一页只回 **18** 条 |
| 同一个用户出现在两页上 | 逐页翻完 12 条里只有 11 个不同的 |

三个都**不报错**，每条数据本身还都是对的 —— 只表现为「数量对不上」，
界面上就是「共 22 条」而只列得出 20 条，用户以为漏了数据。

⚠️ **种子数据里每个用户恰好挂一个角色，所以这个 bug 在默认数据上永远不显形。**
守卫测试 `tests/api_v1/test_pagination_fanout.py` 显式造一个多角色用户，
并且在 fixture 里前置断言「真的挂上了两个」—— 否则它会因为「没造出扇出」而假绿。

**修法**：分页的 Select 只留 m2o 的 join（部门那种，不增加行数），
m2m 的关联在分页**之后**按本页 ID 批量补一次（`user_service._attach_roles`，
一条查询，不是 N+1）。按关联筛选用 `id.in_(子查询)`，不要 join + `where 中间表.列 == 值`
—— 后者会把 join 出来的关联行一起筛掉，结果每条的关联列表里只剩被筛的那一个。

> ⚠️ `select_join_serialize` 默认返回 **namedtuple**（`return_as_dict=False`），
> namedtuple 不可变，分页后往每条里塞字段要先 `return_as_dict=True`。
> 响应模型是 `from_attributes=True`，两种都能校验，响应形状逐键一致（实测比对过）。

**这个坑只在分页端点上成立。** `crud_role.get_join` / `crud_data_scope` 也 join 了
m2m，但它们是**单条详情**（`id=pk`），不过分页，扇出的多行正是要聚合的数据。
判据是一句话：**这个 Select 会不会被交给 `paging_data`。**

这条判据已经做成静态守卫（同一个测试文件里的
`test_paginated_selects_never_join_m2m_tables`）：本仓库里 `-> Select` 就等于
「要交给 `paging_data`」，所以按**返回类型**就能把两类方法分开，
m2m 表名从 `model/m2m.py` 自动发现。全仓扫了一遍，只有 `crud_user` 一处。

⚠️ 守卫必须区分 **join 和子查询**，不能只搜表名 —— 第一版就是搜表名，
当场把刚修好的 `get_select` 报成违规（它的角色筛选用的正是子查询）。
现在走 AST，只看 `JoinConfig(model=…)` 和 `.join(…)` 的实参。

### 顺带纠正一条假注释

`common/security/data_scope.py` 的 `count()` 覆盖，原来的注释写着「分页总数也要
跟着过滤，否则『共 100 条』但只列得出 10 条」。**那句话是错的**：分页走
`apaginate`，它拿传进去的 `Select` 自己拼 count，而过滤条件早就在那个 Select 里
（`select_order` → `select()` → `_scoped`）。这个 `count` **全后端零调用方**，
把它改成不过滤全套测试一条都不红 —— 不是没测试，是它不在任何路径上。

那条假注释**误导过一次真实的分析**：正是它让「count 没被测到」看起来像个测试缺口，
而真正的缺口在别处（上面那个扇出）。覆盖本身留着（安全原语的兜底，将来真有人
`dao.count()` 就是静默 fail-open），但注释改成了实话。

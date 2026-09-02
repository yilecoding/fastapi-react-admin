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

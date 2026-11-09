# backend/common/data_change —— 数据变更审计（#260）

> 谁、什么时候、从哪来，把哪个对象的哪个字段从什么改成了什么。
>
> 这份文件是 [`backend/common` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

```
registry.py   登记表：哪些表要记、每一列怎么记（普通 / 引用 / 敏感 / 忽略）· 关联表折叠成集合字段 · 来源和动作的中文名
capture.py    拦截层：挂在 Session 类上的五个事件 · 「第一次碰到时拍原样，提交时和现状比」· 同一个事务里写 sys_data_change
```

内置登记在 `app/admin/data_change.py`（用户 / 部门 / 角色 / 菜单 + 三张关联表），插件放自己目录下的
`data_change.py`（参数配置：`plugin/config/data_change.py`）。表是 `app/admin/model/data_change.py`，
接口 `GET /api/v1/logs/changes`（+ `/meta`），权限码 `log:change:list`，**不按数据权限过滤**（#260 拍板，同操作日志）。
前端：「日志管理 → 数据变更」页（`pages/log-change`）· 五个页面的「变更记录」抽屉（`pages/_shared/data-change`）·
操作日志详情的「这次改了什么」（按 `trace_id`）。保留期参数 `DATA_CHANGE_RETENTION_DAYS`（默认 180，参数配置「日志」组），
`maintenance.prune_logs` 每天删。

## 为什么挂在会话上，而不是在 service 里一处处写

五张表的写入有 **34 个 DAO 写方法、5 种写法**（按条件 UPDATE · Core 写关联表 · 按主键批量 UPDATE ·
unit of work INSERT · 逻辑删除）。照 yudao（mzt-biz-log）在 service 里显式写，漏一处就是「这类修改没有记录」，
而且是**静默**的 —— 和 Webhook 那 15 个 `emit` 同一个风险。挂在会话上，以后新加的写路径自动被记。

ORM 的 `before_update` / `after_update` 抓不到：crud-plus 发的是「按条件 UPDATE」，不触发映射器事件
（SQLAlchemy 2.0 文档对这类语句给的拦截点就是 `do_orm_execute`）。

## 🔴 `before_commit` 里必须先 `session.flush()`

**症状**：新建角色 / 菜单 / 参数没有「已新建」记录；而且那条新建会记到**同一个会话下一个事务**的头上。

**根因**：提交时 SQLAlchemy 是**先**触发 `before_commit`、**再**做最后一次 flush。这几个 DAO 的 `create_model`
不 flush（`db.add()` 之后 INSERT 要到提交时才发生），`after_flush` 要等 `before_commit` 跑完才轮到 ——
那时缓冲已经处理过了，新建进了缓冲却没人写。

**修法**：`_on_before_commit` 第一句 `session.flush()`（没东西要 flush 时是空操作）。

**实测证据**（2026-11-09，自建 schema 跑完删掉，PostgreSQL 和 SQL Server 结果一致）：

| 场景 | 事件顺序 | 结果 |
|---|---|---|
| `add()` 不 flush 直接 commit，不先 flush | `before_commit(缓冲 0, 待写新对象 1)` → `after_flush` → `after_commit(缓冲剩 1)` | 审计 0 行，缓冲泄漏 |
| 同上，先 flush | `before_commit` → `after_flush` → 写审计 → `after_commit(缓冲剩 0)` | 和业务同一个事务提交 |
| UPDATE → rollback | `do_orm_execute` → `after_soft_rollback(清缓冲)` | 业务没改、审计 0 行 |

变异：去掉这句 flush → `test_data_change.py::test_creating_a_role_is_recorded_although_create_model_does_not_flush` 红。

## 🔴 每一列都必须归类

`register_audited` 要求表的每一列都写进 `fields` / `refs` / `secret` / `ignore` / `soft_delete` 之一（主键自动忽略），
漏一列、多写一列、一列写两处都当场抛（import 期，启动即失败）。

防的是：**以后加了个 `api_token` 列，默认当普通列记，明文进了审计表** —— 静默，而且是泄密。
给这五张表加列时先想它属于哪一类；字段的中文名同时要进 `packages/i18n` 的两个语言包和 `server-data-keys.json`
（`test_every_label_is_translated_and_whitelisted` 守着 —— 不在语言包里英文界面就是中文，不在白名单里
`pnpm i18n:fix` 会把它们当孤儿删掉）。

## 🔴 拦不到的写法，由静态守卫挡在生产代码外

运行时**不报错**（测试收尾大量用这些写法硬删数据，35 处）：

| 写法 | 为什么拦不到 |
|---|---|
| `text('UPDATE sys_user …')` | 原生 SQL，没有表对象 |
| 语句式 `insert(User)` | 拿不到新行的主键（雪花 ID 是 Python 侧默认值，不在参数里） |
| `session.connection().execute(...)`，包括 crud-plus `bulk_update_models(pk_mode=False)` | 不经过 `Session.execute`，`do_orm_execute` 不触发 |

`test_production_code_has_no_write_the_capture_cannot_see` 扫生产代码（不含 tests / alembic / scripts / cli.py）。
迁移、`fba init`、种子 SQL 走连接，不记，符合预期。

## 关联表记的是提交时的净变化

改用户角色、存权限矩阵都是「全删再全插」。按语句记的话每次保存都是「删了 5 个、又加了同样 5 个」。
现在第一次碰到某个父对象时拍一次成员集合，提交时再查一次，记差集；原样保存不出记录。
变异：每条语句都重拍 → `test_updating_a_user_records_old_and_new_values_with_the_actor` 红。

## 来源：流式响应要显式传操作人

`with data_change_source('ai', ref, actor_id=…)` 包住的修改记成别的来源。来源在**第一次碰到那一行**时就定下来
（`db.add()` 那一刻由 `transient_to_pending` 记），所以提交发生在 `with` 外面也没关系。

🔴 AI 对话是 SSE 流式响应，生成器跑起来时请求上下文（starlette-context）可能已经收尾了，从上下文里取操作人会拿到空 ——
`plugin/ai/core/dispatcher.py: _invoke` 显式传 `ctx.user.id`。批量导入（`import_service`）和第三方登录（建号 / 同步头像）同理。
⚠️ 一期这五个对象**没有定时任务会改**，`task` 来源先留着。

## 顺手修的：`last_login_time` 带 `onupdate`（上游带过来的）

**症状**：管理员改一下某人的资料 / 状态 / 角色，个人中心、角色成员、用户导出、AI 工具里的「上次登录时间」
都成了「被改的时间」，不报错。

**根因**：`app/admin/model/user.py` 的 `last_login_time` 带着 `onupdate=tz_helper.now`（分叉提交 `2dc4e71` 就有，
上游 FBA 现在也是 `onupdate=timezone.now`）—— 对用户表的**任何** UPDATE 都会刷它。登录那条路径本来就显式写这一列。

**修法**：去掉 `onupdate`。**实测证据**：第一次探针只改昵称，比对结果里 `last_login_time` 跟着变了；
`test_updating_a_user_no_longer_touches_last_login_time` 守着（把 `onupdate` 加回去就红）。

## 性能

**实测**（开发库 PostgreSQL / docker / WSL，同一条 `update_model_by_column` 200 次）：拦截关中位 2.045 ms，
拦截开（前查 + 后查 + 比对）中位 4.275 ms —— 每次被审计的 UPDATE 约 +2 ms（不含提交时那一次批量 INSERT）。
**没登记的表**上测不出开销：PostgreSQL 0.752 → 0.723 ms、SQL Server 4.156 → 3.879 ms（300 次，监听器装 / 不装）。

一条语句命中超过 `BULK_LIMIT`（500）行时只记一条「批量修改」汇总（`entity_label` 存命中行数），不先把半张表查出来。

## 实测证据 / 守卫

`app/admin/tests/api_v1/test_data_change.py` 28 条（接口路径的五种写法 + 同步会话造的回滚 / 保存点 / 同一事务改两次 /
没 flush 的新建 / 建了又删 / 批量汇总 + 登记守卫 + 静态守卫 + 接口）· `app/task/tests/test_prune_logs.py` 一条保留期 ·
E2E `data-change.spec.ts`。

变异 10 处各有测试红：不先 flush · 原样每次都覆盖 · 外层回滚不清缓冲 · 关联表每条语句都重拍 · 敏感列照记值 ·
逻辑删除不认 · 来源不看 `add` 那一刻 · 不查引用的名字 · `last_login_time` 带回 `onupdate` · 批量上限失效。

**没验过**：MySQL（本机没有容器）· 五种写法在 SQL Server 上（第二轮的提交时序在 SQL Server 上跑过）·
提交时那一次 INSERT 的耗时 · 改已加载对象（`session.dirty` + 属性历史）这条路径 —— 五个对象现在都不这么改。

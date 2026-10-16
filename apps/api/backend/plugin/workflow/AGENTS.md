# plugin/workflow —— 审批流（运行时 · 表单 · 字段权限）

> 设计全文在 issue #107（选型、数据模型、分阶段、明确不做的事）。这里只记**实测出来的**
> 坑和必须守住的不变式。前端那一半见
> [`pages/workflow` 分册](../../../../../packages/platform/src/pages/workflow/AGENTS.md)。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 地图

| 文件 | 管什么 |
|---|---|
| `engine/schema.py` | 表单 schema / 流程树的**形状**（Pydantic，只校验、不存） |
| `engine/flow.py` | 树导航（`index_nodes` 的「走完去哪」）· 条件求值 · 发布校验 |
| `engine/form.py` | 表单数据校验 · 字段权限（开始节点默认可填、审批节点默认只读） |
| `engine/assignee.py` | 审批人规则解析，结果里永远去掉发起人 |
| `service/runtime_service.py` | `execute()` 统一入口 · 认领 · 推进 · 能力信封 |
| `service/query_service.py` | 审批中心查询 · 详情（按查看人裁字段）· 通讯录 |
| `handler.py` | 业务接入契约；表单审批是内置的 `FormHandler` |

## 🔴 认领实例在前，动待办在后

所有改状态的动作都先 `UPDATE wf_instance SET version=version+1 WHERE id=? AND version=? AND status='running'`，
失败就整个事务重来（最多 3 次，重新读状态）。反过来（先改自己的待办、再数会签还剩几个）
在 SQL Server 默认的 READ COMMITTED 下两个会签人会互相等对方的行锁。

⚠️ **「三条竞争测试全绿」证明不了版本号有用。** 实测：把 `_claim` 里的
`version == inst.version` 删掉，`test_concurrency.py` 原来那三条（会签同时同意 /
或签同时同意 / 同意撞撤回）**照样全绿** —— UPDATE 本身会锁行，加上 `status='running'`
已经把它们串行了。版本号真正挡的是**过期的读**：后到的人在别人提交之前就读出了实例，
不强制重读的话，他 flush 的 `form_data` 是旧的。所以补了第四条
`test_cosign_concurrent_form_edits_both_survive`（会签两人同时改不同字段），
同样的突变下它当场红：`{'g': 'B'} != {'f': 'A', 'g': 'B'}`，先到那个人的修改被静默盖掉。

并发测试是真并发：独立引擎、每个动作一个会话、`asyncio.gather`，socket 推送 monkeypatch 成
空操作（不让共享 Redis 绑到临时事件循环上，见 [tests 分册](../../tests/AGENTS.md)）。
**只在 SQL Server 上实跑过**；PG / MySQL 靠 CI 的对应 job。

## 🔴 被拒绝的动作也要落一条记录 —— 在另一个事务里

`ActionRejected` 让主事务整体回滚，`execute()` 再**另开一个事务**写 `result=rejected`。
所以 `execute()` 收的必须是**不带事务**的会话（接口层用 `CurrentSession`，不是
`CurrentSessionTransaction`）；进来时如果依赖注入已经 autobegin 了一个只读事务，先 rollback。

幂等键（`wf_action_record.idempotency_key` 唯一）：同一个键再来一次直接重放上次的结果；
并发撞了唯一约束就回滚、重读、重放。

## 🔴 `f'{枚举}'` 拼出来的是 `InstanceStatus.approved`，不是 `approved`

`common/enums.py` 的 `StrEnum` 的 `__str__` / `__format__` 带类名。拿它拼 i18n key
（`t(f'workflow.status.{status}')`）会得到一个不存在的 key，`t()` **原样吐回 key 字符串**，
不报错 —— 实测是「已通过」的结果通知标题变成了 `孙强提交的请假：workflow.status.InstanceStatus.approved`，
被 `test_short_leave_runs_to_approved` 抓到。拼 key 一律 `.value`。

反方向也有一个：接口层 `SchemaBase` 会把入参里的枚举还原成 `str`，
`act()` 进来第一件事是 `Action(action)` 统一回枚举，否则 `.value` 直接 AttributeError。

## 🔴 布尔列别写 `.is_(True)` —— SQL Server 上是语法错误

`User.is_superuser.is_(True)` 在 SQL Server 上编译成 `is_superuser IS 1`（`IS` 后面只能跟 `NULL`），
直接 500；PG / MySQL 认这个写法，所以本地跑 PG 的人永远看不到。实测踩到：发起人所在部门没配负责人、
节点配了「转给管理员」时，用户在发起页拿到一整段裸 SQL 报错。写 `== true()`。
`test_on_empty_admin_goes_to_superuser_but_never_back_to_the_initiator` 守着
（把修复打回去，它报的正是那句 `Incorrect syntax near '1'`）。

## 预告和真实推进必须是同一套规则

发起页的「审批流程」和详情页「还没到的步骤」是 `engine/simulate.py` 试算出来的，不写库。
它和 `runtime_service._advance` 用同一个 `pick_branch` / `assignee.resolve` / `onEmpty` ——
**改推进逻辑时两边一起改**，否则用户看到「说好给张三审，结果到了李四那里」。
`test_preview_matches_what_actually_happens` 先试算、再真走一遍，逐步比对办理人。
试算吃的是**没校验过**的表单（填到一半），所以 ID 转换一律过 `_ids()`，非数字丢掉而不是 500。

## 字段权限只在服务端算数

- 详情接口按查看人**裁掉** hidden 字段：schema 里删字段、数据里删值、**轨迹里的改动前后值也删**
  （漏了最后这个，隐藏字段从审批记录里漏出去）。E2E 断言的是 DOM 里**根本没有**那个字段
- 开始节点的 `fieldPerms` 是**发起人**的权限，默认可填；hidden 的字段发起人传了也不收，
  必填校验也不算它（否则「人事备注」必填就没人发得起来）
- 同意时只校验**本节点可编辑**的字段（含必填）—— 不传改动也校验，这个节点上「可编辑 + 必填」
  的没填就不许同意；别的字段不是他填的，不该挡他

## 通知：行在事务里写，推送在提交之后

站内通知的行是 `notification_dao.create` 在审批事务里写的（回滚就一起没了），
socket 推送（`notification_new` / `workflow_todo_changed`）收集在 `_Ctx.effects`、**提交之后**才发。
`notification_service.send()` 是「落库后立刻推」，推的时候事务还没提交 —— 审批这里不用它。
办理人**不**发站内通知，只推 `workflow:todo` 让前端重取待办数（#107 设计 7）。

## 迁移与种子

- `uk_wf_instance_active_key` 按方言分叉：SQL Server 筛选唯一索引，PG / MySQL 普通唯一约束。
  模型和迁移两边都要分叉，autogenerate 只会照当时连的那个库写一种
- 🔴 **跑过 pytest 之后，开发库里已经有这几张表了** —— 测试起 `TestClient` 时应用的 lifespan
  会对**开发库**做一次 `create_all`。这时 `pnpm db:revision` 拿模型和开发库一比，
  报 `No changes in model detected`。实测踩到：要先在开发库里把新表 drop 掉再生成
- 「请假」示例流程只在种子里，数据迁移只补菜单（演示数据不往已有的库里塞）

## 通讯录接口为什么单独开

审批里的选人（转交 / 抄送 / 自选审批人 / 表单人员字段）是**所有登录用户**都要用的，
而 `/sys/users` 挂着 `sys:user:list`。`/workflow/directory/users` 只给 ID / 昵称 / 用户名 / 部门名。
⚠️ 部门页的负责人选择**不**用它：部门页是底座，插件可以卸载。

## 🔴 隐藏字段除了详情，还有五条路能漏出去

「详情接口按查看人裁字段」只堵住了最显眼的那条。独立审查又翻出五条，每条一个回归测试
（`tests/test_review_fixes.py`），表现都是「界面上那个字段确实没了，值还在别处」：

| 漏在哪 | 修法 |
|---|---|
| **摘要**（待办 / 抄送列表、通知正文，还能被关键词搜） | `_summary()` 排除**任何节点**上 hidden 的字段 —— 摘要不按人裁，只能按最严的算 |
| **条件分支记录**（「走了『大额』分支」就等于说出了金额区间） | 条件引用了对查看人隐藏的字段时，分支记录和 `branch:*` 状态一起去掉 |
| **预告**（还没走到的步骤会随金额变） | 有这种条件时预告整个不给 |
| **预告里的人名**（审批人来自隐藏的人员字段） | `_mask_forecast` 去掉名字、标 `masked`，前端显示「由申请内容里的人员决定」 |
| **设计期**就能提醒 | 发布校验给一条 WARN `CONDITION_VAR_HIDDEN` |

同一轮里另外几条，都是静默的：

- **幂等键要带人**：`_replay()` 只认同一个 actor 用过的键。原来别人拿到你的键就能重放出你那次的结果（409 才对）
- **「发起人自选」只问会走到的节点**：按填的内容 `simulate` 一遍，`outcome == 'pick'` 的才必选。
  原来走不到的分支也逼人选，小额请假也提交不了。前端按试算结果只显示路径上的那几个
- **转交不能转给本节点已同意的人**：会签三人，A 同意后 B 转给 A，A 再同意 —— 三人会签两人表态
- **部门负责人停用 / 删除 = 没配**，往上一级找；原来是这一级取人为空、直接走 onEmpty
- **ID 一律过 `is_bigint_id`**：`'²'.isdigit()` 是 True，`int('²')` 是 ValueError → 500；
  超过 2^63-1 的数字到 SQL Server 是溢出 → 500。金额同理封顶 10^15
- **业务审批的条件变量**（`handler.snapshot().variables`）存进 `inst.variables['biz']`，
  推进和预告都合并它 —— 原来另收一个 `variables` 当表单数据，被表单校验整个滤掉，分支永远走兜底。
  ⚠️ 发布校验要求条件变量是表单字段，所以业务流程要在**表单 schema 里声明**这些变量（只声明，发起时不填）。
  `test_biz_condition_uses_handler_variables`（变异：推进时不合并 `biz` → 走到兜底分支，红）

以上「漏在哪」表里的五行都有测试，前三行和 masked 那行做过变异（把修复打回去 → 对应测试红）。

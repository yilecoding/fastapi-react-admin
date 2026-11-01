---
title: 审批流
description: FastAPI + React 的飞书式审批：表单设计器、带条件分支的流程树，或签 / 会签、退回、加签、拿回、超时自动处理。
sidebar:
  order: 3
---

fastapi-react-admin 自带一个审批流插件（`plugin/workflow`）：管理员在浏览器里搭表单、画流程树、发布，之后所有登录用户都能按这个流程发起申请。审批人只在一个**审批中心**里干活（待我审批 / 我已审批 / 我发起的 / 抄送我的）；同意、驳回、转交、抄送、退回、拿回、加签、催办、撤回、终止、改办理人，执行前都由服务端同一个函数（`capabilities()`）判定能不能做 —— 界面上出哪些按钮也是它给的，按钮和接口不会各说各的。

## 一个流程定义里能放什么？

流程定义就是两份 JSON：表单 schema 和流程模型。发布时用 [`engine/schema.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/engine/schema.py) 里的 Pydantic 形状校验一遍，存的是原始 JSON。

- **表单控件 13 种**：单行文本、多行文本、数字、金额、日期、日期区间、单选、多选、人员、部门、附件、说明文字、明细表。明细表只允许一层（不能表套表）。
- **显示条件**（`visibleWhen`）：不显示的字段不校验、值也不保存。典型用法是「请假类型 = 病假」才出现「病假证明」。
- **自动计算**（`calc`）：日期区间的天数（含首尾，11-02 ~ 11-06 = 5 天），或明细表某一列的合计。值由服务端重算，前端传上来的不收。
- **流程节点**：开始、审批、抄送、条件分支。条件是结构化的 `all` / `any` 嵌套，叶子形如 `{"var": "f_days", "op": "gt", "value": 3}` —— 不解析字符串表达式，也就没有注入可言。条件节点必须有且只有一个兜底分支，否则发布不了。

下面摘自种子里的示例流程「请假」（[`sql/postgresql/init_snowflake.sql`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/sql/postgresql/init_snowflake.sql)）：先给直属主管，超过 3 天再加一级上级主管，之后人事备案。

```json
{"type": "approval", "id": "n_leader", "name": "直属主管", "mode": "any",
 "assignee": {"kind": "dept_leader", "level": 1}, "onEmpty": "admin",
 "next": {"type": "condition", "id": "c_days", "branches": [
   {"id": "b_long", "when": {"all": [{"var": "f_days", "op": "gt", "value": 3}]},
    "child": {"type": "approval", "id": "n_upper", "assignee": {"kind": "dept_leader", "level": 2}, "onEmpty": "skip"}},
   {"id": "b_default", "default": true, "child": null}]}}
```

设计器改的永远是草稿（保存草稿不校验）；**发布**时才校验，通过后把草稿原样拷成一个新版本。在途的单子拿的是发起那一刻的快照，改定义、停用定义都不影响它们。已经有审批单的流程不能删，只能停用。

## 每一步由谁审批？

审批节点上配审批人规则（[`engine/assignee.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/engine/assignee.py)）：

| 规则 | 取到的人 |
|---|---|
| `user` | 指定成员 |
| `role` | 角色成员，可以再限定在发起人所在部门 / 部门及下级 |
| `dept_leader` | 从发起人部门往上第 N 级的负责人；没配负责人、负责人已停用、负责人就是发起人的那一级都跳过 |
| `initiator` | 发起人本人（「确认」类节点） |
| `var_user` | 表单里某个人员字段选的人 |
| `select_on_start` | 发起人提交时自己选 —— 只问这张单真会走到的节点 |

除了 `initiator` 规则，结果里**永远去掉发起人**，不会出现自己审自己。规则取不到人时由节点的 `onEmpty` 决定：`reject`（默认，原因写进轨迹）、`skip` 跳过、`admin` 转给超级管理员（同样去掉发起人）。不存在静默放行。

## 或签、会签、依次审批有什么区别？

`mode: any`（或签）一人同意即通过，其余人的待办作废；`mode: all`（会签）要全部同意，任何一人驳回整单结束；`mode: seq`（依次审批）一个一个来，顺序在单子进入这个节点时就定死，之后角色成员变了也不影响在途的单。

## 除了同意和驳回，审批人还能做什么？

| 动作 | 行为 |
|---|---|
| 转交 | 把待办交给别人。对方在这一轮里已经同意过这一步的，拒绝转交 |
| 抄送 | 临时抄送给别人，对方在「抄送我的」里看到 |
| 退回 | 退回给发起人，或按**现在的**表单沿流程树算出来、仍在路上的某个之前的审批节点。可选「处理完直接回到我这一步」—— 跳之前再确认这一步还在路上：发起人改了金额、分支已经不经过这里时照常往下走 |
| 加签 | 在我之前（他们都同意后回到我）或在我之后（我这一票当场算同意，他们都同意后才往下走）。加签进来的人只能同意 / 驳回 / 转交 / 抄送，其中一人驳回即整单驳回 |
| 拿回 | 同意之后、下一步还没人动之前，把单收回自己手上。恢复的是这次同意之前的实例变量，不只是那一条待办 |

发起人可以**撤回**在途的单，也可以**催办**当前审批人，但 5 分钟内只能催一次。有 `workflow:instance:terminate` 的人能终止，有 `workflow:instance:reassign` 的人能改办理人。节点上的 `actions` 用来收窄可选动作：`null` 继承默认的转交 / 抄送 / 退回 / 加签，`[]` 只留同意和驳回。

## 审批人超时了会怎样？

审批节点可配 `timeout: {hours, action}`，`hours` 取 1 ～ 720，`action` 是 `remind`（提醒）、`approve`（自动同意）或 `reject`（自动驳回整单）。从**待办到这个人手上**开始计时，所以转交出来的待办、依次审批轮到的下一个人都重新计时。按自然时间算，不计工作日。

Celery 任务 `workflow.handle_timeouts` 每 5 分钟扫一遍（种子里是 cron `*/5 * * * *`）。提醒最多发 3 次。自动同意遇到这一步还有「可编辑 + 必填」的字段没填时，退回成提醒；自动同意 / 驳回和人点按钮一样先认领实例，正好有人在办就留到下一轮。

:::caution
Celery beat 没起，或者 **任务调度 → 任务管理** 里那条 `workflow.handle_timeouts` 被停用时，超时配置照样能保存，但永远不会触发。
:::

## 草稿、加急和已读

- **草稿**存在服务端（`wf_draft`，一人一个流程一份，上限 200 KB，不校验内容）。发起抽屉停手 1.5 秒自动存；提交成功时在同一个事务里删掉草稿，提交失败草稿还在。
- **加急**只是提示：加急的单在审批人的待办里排前面，不改流程。
- **已读**：当前审批人第一次打开详情时记一笔，发起人能看到「已读」。

## 有人离职，手上的待办怎么交接？

**实例监控 → 离职交接** 把一个人手上所有在办的待办交给另一个人。「从谁那交接」的列表直接列出手上有待办的人，**包括已停用、已删除的账号** —— 普通的选人控件只列在职的人，恰恰选不到最需要交接的那一个。每条待办一个事务，交不过去的逐条给原因；同一个幂等键重复点一次，不会交两遍。

## 字段权限怎么控制谁看得见什么？

每个节点给每个字段设 `hidden` / `readonly` / `editable`（开始节点默认可填，审批节点默认只读），**只在服务端算数**：详情接口按查看人从 schema、数据、轨迹里的改动前后值三处删掉 hidden 字段。待办摘要、条件分支记录（「走了大额分支」就等于说出了金额区间）、流程预告也不会漏出隐藏字段；条件引用了隐藏字段时，发布校验会给一条 `CONDITION_VAR_HIDDEN` 警告。

## 两个人同时点按钮会出问题吗？

所有改状态的动作都先执行 `UPDATE wf_instance SET version = version + 1 WHERE id = ? AND version = ? AND status = 'running'` 认领实例，失败就整个事务重来，最多 3 次。每个动作带幂等键，只对同一个人重放结果。被拒绝的动作也会落一条记录（在另一个事务里写）。

## 接入自己的业务表

表单审批不用写代码。要给业务表加审批，在 [`handler.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/handler.py) 里实现 `WorkflowBizHandler`、`register_handler()` 注册，在自己的事务里调 `runtime_service.start_for_biz()` 发起。`on_finished` 在审批事务内同步执行，只该改业务状态。另有 5 个 Webhook 事件（`workflow.instance.started` / `approved` / `rejected` / `withdrawn` / `terminated`）经[开放接口](/zh-cn/features/open-api/)推出，刻意不带表单内容。审批产生的通知和其他通知走同一套路由，见[消息与通知](/zh-cn/features/notifications/)。

插件还有几项可选的 AI 能力：AI 预审、一句话生成流程、发起时从材料里填单、在对话里审批，以及只在或签节点上、按历史数据放闸的 AI 自动同意，见 [AI 助手](/zh-cn/features/ai-assistant/)。

## 目前不支持的

- 没有并行分支：流程是一棵树，一张单任何时刻只停在一个节点上。
- 设计器的条件编辑器只编辑一层「全部满足」；手写的 `any` 嵌套条件会保留，但界面里改不了。
- 表单字段用上 / 下按钮排序，不能拖拽。
- 超时按自然小时算，没有工作日历。

## 代码在哪

- [`apps/api/backend/plugin/workflow/engine/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/workflow/engine) —— 形状、树导航与发布校验（`flow.py`）、表单联动与字段权限（`form.py`）、审批人规则、流程试算（`simulate.py`）
- [`service/runtime_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/service/runtime_service.py) —— 所有动作、认领、能力信封；[`service/query_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/service/query_service.py) —— 审批中心查询与按人裁字段的详情；[`service/timeout_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/service/timeout_service.py)
- 前端：[`packages/platform/src/pages/workflow/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/workflow)（表单渲染器、流程图、详情抽屉），以及 `workflow-definition/`、`workflow-inbox/`、`workflow-monitor/`
- 设计取舍与踩过的坑：[`plugin/workflow/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/AGENTS.md)、[`pages/workflow/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/workflow/AGENTS.md)

## 怎么测的

[`plugin/workflow/tests/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/workflow/tests) 收集到 167 条 pytest 用例，大部分跑在真实的测试库和 Redis 上（引擎与动作 88 条，AI 相关 79 条，其中 14 条调真模型、没配凭据时跳过）。举几个例子：

- `test_concurrency.py` 是真并发（独立会话 + `asyncio.gather`）：会签同时同意、或签同时同意、同意撞撤回，以及会签两人同时改不同字段 —— 去掉版本号检查，最后这条当场红。
- `test_preview_matches_what_actually_happens` 先试算路径，再真走一遍，逐步比对办理人。
- `test_timeouts.py` 靠传入时间（`handle_timeouts(..., now=...)`）而不是真等。

哪些测试做过变异验证（把修复改回去、测试变红）在分册里逐条记着。浏览器端 [`workflow.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/workflow.spec.ts) 有 14 条 Playwright 用例，覆盖发起 → 同意、退回后重新提交、改办理人、拿回、加签、草稿、加急、已读。CI 在 PostgreSQL 和 SQL Server 上跑后端全套；MySQL 没有 CI job。

## 在演示站里试试

打开 [fra.wubunan.com](https://fra.wubunan.com/sign-in)，用 `admin` / `123456` 登录。**审批 → 流程定义** 里能打开设计器（基础信息 → 表单设计 → 流程设计），种子里有示例流程「请假」；**审批 → 审批中心** 发起和处理申请；**审批 → 实例监控** 里有终止、改办理人和离职交接。

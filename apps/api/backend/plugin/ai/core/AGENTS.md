# plugin/ai/core —— dispatcher 的失败分支

> 这份文件是 [AI 插件分册](../AGENTS.md) 的**子分册**（dispatcher 的四道闸、确认令牌、写工具的预演规则在那一份）。
> 跨模块纪律在根分册；新增结论写进离代码最近的分册。

## 🔴 工具失败要回滚该工具的写入（#315）
**症状**：handler 写入后抛业务异常，dispatcher 回报失败但外层仍提交了它的部分数据；flush 异常则让后续提交报 `PendingRollbackError`。
**根因 / 修法**：只捕获异常不等于事务回滚。`core/dispatcher.py` 在 handler + flush 外包 savepoint，失败移除该 handler 新增的后台任务，审计在回滚后写；整轮之前成功的写入保留。确认入口 `service/chat_service.py` 对执行 / commit 异常 rollback、落失败卡片并结束 SSE；提交后的后台任务失败只记日志，避免把已提交操作说成失败诱发重做。
**实测证据**（2026-11-12，SQL Server）：`../tests/test_ai_tool_atomicity.py` 修前业务异常留下行 `[1, 2]`、flush 异常无法提交，修后两种失败都只保留此前的行 `[1]`，成功保留两行和后台任务；`../tests/test_ai_confirm.py` 覆盖 dispatch / commit 异常的 rollback、失败卡片和流结束。
⚠️ 审批 `execute()` 自己回滚 / 提交事务：共用保存点会报 `Can't operate on closed transaction inside context manager`，同意 / 驳回 / 转交都失败。
`../../workflow/ai_tools.py` 的 `_act` 从调用方 bind 建独立会话，保留审批事务、重试与提交后推送。实测 SQL Server 相关 29 条通过；
`../../workflow/tests/test_ai_workflow_tools.py` 新增成功 / 写后失败两条，验证审批写入回滚且外层已有审计保留。

## 🔴 失败原因不能是 `str(e)`：数据库异常带 SQL 和参数（#372）

**症状**：写工具撞唯一约束时，给模型的工具结果、确认卡片的 `detail`、`ai_tool_invocation.error` 三处都是
`(IntegrityError) … [SQL: INSERT INTO ai_atomicity_probe …] [parameters: …]` —— 表结构和用户填的值（手机号之类）发给了模型供应商，
也摊在了界面上。和 #317「不把 `str(e)` 给人」反着走。
**根因**：`_error_text` 兜底是 `getattr(e, 'msg') or str(e)`；#315 把 flush 挪进 handler 的 `try` 之后，flush 的数据库异常也走到这里。
**修法**：`SQLAlchemyError` 只回一句通用话（`IntegrityError` 说「违反唯一或关联约束」），全文进服务端日志（执行路径本来就 `log.exception`，
预演路径补了一条）。flush 里抛的业务异常（如雪花发号失败）会被包成 `StatementError`，取里面那层的 `.msg`。
**实测证据**（2026-11-18，PostgreSQL 私有库）：`test_ai_tool_atomicity.py[flush]` 用真实的主键冲突，修前 `outcome.payload` 里有 `INSERT`；
`test_ai_turn_persistence.py` 两条断言 SQL / 参数不出现、包着的业务消息照常出现。去掉新分支，三条都红。

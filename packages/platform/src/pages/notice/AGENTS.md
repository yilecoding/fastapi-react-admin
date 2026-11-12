# platform/pages/notice —— 通知公告管理表单

> 通用页面规则见 [pages 分册](../AGENTS.md)。读者侧与广播约定见
> [notification 分册](../notification/AGENTS.md)。
> 这份文件是 [pages 分册](../AGENTS.md) 的**子分册**。新增结论写到离代码最近的分册。

## 🔴 提交状态要覆盖保存后的异步步骤（公告 #330）

**症状**：公告保存返回后、抽屉关闭前，发布按钮提前恢复，再点会重复创建并广播。
**根因**：`create.isPending || update.isPending` 只覆盖 mutation（包括缓存失效），
后面等待的 `syncImages()` 仍在读取 / 挂载 / 卸载正文图片；没图也会读一次关联。
**修法**：`form.tsx` 用 `form.formState.isSubmitting` 覆盖整个异步提交，
并在进入 `form.handleSubmit` 校验前用 ref 单飞，`finally` 解锁。只禁按钮挡不住
原生 submit 事件；把锁放在 `onSubmit` 内还会让重入的 `handleSubmit` 提前复位提交状态。
**实测**：`apps/web/e2e/tests/notice-submit.spec.ts` 挂起图片关联读取，旧代码新建 / 编辑
均显示按钮可点；只保留按钮修复、撤掉单飞后，两次原生重提让 POST / PUT 各从 1 次变 3 次。
完整修复后三条浏览器回归通过：等待同步时禁用并转圈、重提只写一次；校验失败或保存失败能重试，
成功关闭后同页再新建也能提交。API 在浏览器拦截，未写数据库或发送广播。

# plugin/notice —— 通知公告（读者那一侧 · 附件 · 收件箱联动）

> 扩展级插件（`[app] extend = "admin"`），接口在 `/api/v1/sys/notices/*`。上游 FBA 的插件，#186 加了读者那一侧。
> 前端在 `packages/platform/src/pages/notice/`，收件箱那一半见 [`plugin/notification` 分册](../notification/AGENTS.md)。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 🔴 「读」和「管」是两个口

| | 接口 | 门槛 | 给谁 |
|---|---|---|---|
| 读者 | `GET /sys/notices/feed` · `/feed/{pk}` | 只要登录 | 工作台 · 铃铛 / 消息中心的详情 · 移动端 |
| 管理 | `GET /sys/notices` · `/{pk}` · 增删改 | `sys:notice:add`（和管理页的路由守卫同一个码） | 管理页 |

**症状**（#186 之前）：两者共用 `GET /sys/notices`（只挂 `DependsJwtAuth`）—— 任何登录用户都拿得到**隐藏的**公告和正文；
而前端能读到正文的地方只有管理页，普通用户在铃铛里点公告跳过去是 403，点这一下还已经标了已读。

`feed` 要声明在 `/{pk}` **前面**，不然 `feed` 被当成 pk、422。

## 🔴 「谁看得见」只有一份：`crud_notice.readable_clause()`

没删 · 显示 · 没过期。读者列表、读者详情、**附件下载权限**（`notice_service._notice_file_access`）、收件箱回形针的附件数都用它。
另写一份的后果是两边对不上：#186 之前附件权限只看「没删」，于是隐藏公告的附件照样下得到（实测 200、字节一致），而列表上已经看不见了。

- 管理端的人（`sys:notice:add` / `sys:notice:edit`）对没删的都放行附件 —— 编辑表单里要预览隐藏草稿的附件
- 隐藏 / 过期 / 删了的详情一律 **404**，不区分（403 等于告诉对方「这条存在」）
- ⚠️ 入参里的 `expire_time` 可能不带时区，和 `timezone.now()` 比会 TypeError：`_is_live()` 先按应用时区补标记（同 `TimeZone.process_bind_param`）

## 🔴 附件跟着公告一起提交

`CreateNoticeParam` / `UpdateNoticeParam` 带 `attachment_ids`（`None` = 不动，`[]` = 清空，顺序 = 显示顺序，最多 20）。
顺序是「建公告 → 挂附件 → 发广播」，同一个事务：读者收到通知时附件已经在了；任何一个附件不合格整条回滚，不会发出「附件挂一半」的公告。
#186 之前附件只能保存后去「查看」抽屉里传，而状态默认「显示」—— 一保存就广播了。

三道校验（`_sync_attachments`）：文件存在且没进回收站 · **操作人自己读得了**（不校验的话，有发公告权限的人拿到别人私有文件的 ID 就能借公告公开给所有人）·
**不能是公开文件**（公开文件不登录也能下，「看得见公告才打得开附件」对它不成立）。

⚠️ crud 的 `create` 不走 `create_model`：它把整个入参 `model_dump()` 塞进模型，`attachment_ids` 不是列，当场 TypeError。

🔴 **`update` 按 `exclude_unset` 写**：置顶 / 级别 / 过期时间在入参上有默认值，整份写回的话，只传老四样（标题 / 类型 / 状态 / 正文）
的调用方会把一条置顶 + 紧急 + 有期限的公告悄悄改回默认值；清掉过期时间还可能让它重新「看得见」、再广播一次。
service 判「看不看得见」时，没传的 `expire_time` 要按库里原值算（`model_fields_set`），不能拿入参的默认 `None`。显式传 `null` 才是清掉。

⚠️ 附件文件进回收站时它的关联已经一起解开了（同一个删除时间），还原时挂回来 —— 所以编辑公告时表单看不到它、
`attachment_ids` 里没有它，也不会把它解掉。这条是代码评审怀疑过的，测试证明不成立（`test_editing_does_not_lose_an_attachment_sitting_in_the_recycle_bin`）。

🔴 通用的 `POST/DELETE /sys/files/relations` 往 `NOTICE` / `NOTICE_CONTENT` 上挂 / 卸，还要公告自己的权限（`file_service.register_relation_guard`）：
挂到公告上就等于对所有登录用户可读，原来只要 `sys:file:upload` 就能往任意公告上挂任意文件。
⚠️ casbin 模式（`RBAC_ROLE_MENU_MODE=False`）下权限码模型不适用、`user_has_perm` 对非超管恒 False，这道闸在那里让开（退回只看上传权限），
否则公告管理员连正文图都挂不上 —— 前端 `useSyncNoticeImages` 吞掉了那个错误，图就成了孤儿。

⚠️ **正文里的内联图（`NOTICE_CONTENT`）是公开文件**（`/uploads/{key}`，`<img src>` 带不上 Authorization 头），不受上面的可见性约束 ——
公告隐藏了图照样能看。有保密要求的内容要放附件，管理表单里有一句提示。

## 收件箱那一行认得出是哪条公告

广播行带 `source = 'notice:<id>'`（`notification/sources.py`），`link = /notification?notice=<id>`（消息中心就地打开，任何登录用户都进得去；群机器人卡片里也是它）。

| 公告的变化 | 收件箱那一行 |
|---|---|
| 读者看不见 → 看得见（新建即显示、隐藏改显示、过期时间往后挪） | 新写一行（先撤掉旧的） |
| 看得见 → 看不见（隐藏 / 删除） | 撤回（逻辑删除 + 清已读标记） |
| 一直看得见、只改了标题 | 改那一行的标题 / 摘要，不重新发 |
| 建出来就已经过期 | 不发 |

撤回和改标题都要**提交之后推一次** `notification:new`（`push_broadcast_after_commit`）：不推的话在线的人红点里还数着撤回的那一行，点进去是「已撤回」。
前端收到这个事件也要连公告读者列表一起失效（`invalidateInbox`），不然工作台公告卡要等手动刷新。

读者列表的「读没读」就是那一行的已读状态（`sys_notification_read`），不另建已读表 —— 工作台、铃铛看到的是同一份。
没有收件箱行的（#186 之前发的、对不上的）算已读。迁移 `af000000noticereach` 按**标题恰好对上一条**认领旧行，对不上的不动（猜错等于把 A 的已读挂到 B 上）。

⚠️ 自然过期不撤回收件箱行（没有事件可挂），点进去是「已撤回或已过期」。

## 实测证据

`app/admin/tests/api_v1/test_notice_reach.py` 17 条 + `test_notice_visibility.py` 2 条，PostgreSQL 私有测试库 + 真实 Redis（2026-10-30）。
变异 12 处各打红对应那条：PUT 整份写回 · `get_max_sort` 的 `or -1`（真实最大值 0 被当成「没有」，追加的附件和第一个撞号）· 撤回不推 · casbin 模式也收紧 ·附件权限只看没删 · 广播当场推不等提交 · 挂附件不看业务权限 · 隐藏不撤回 · 允许公开文件当附件 · 读者列表不看过期 · 收件箱链接指回管理页 ·
挂附件不看操作人读不读得了（这条要用**真实的**用户快照：别的模块登记的读权限判断会读快照上的字段，`SimpleNamespace` 造的假用户在那里就 AttributeError 了）。
迁移在 PostgreSQL 私有测试库上 `upgrade → downgrade -1 → upgrade`：存量公告 `pinned=false / level=0`；造一条标题对得上的公告之后，那一行的 `source` / `link` 被认领，
降级时链接改回 `/plugins/notice`。
SQL Server 2022（本机容器的私有库）：上面两个文件 + `plugin/notification/tests/` 全部 + `test_file_access.py` / `test_notice_file_cleanup.py` / `test_migrations.py` / `backend/tests/` 共 327 条全过；
迁移 `downgrade -1`（四列消失、种子那行收件箱链接回到 `/plugins/notice`）→ `upgrade`（存量公告 `pinned` / `level` 回填 0，那一行按标题被认领，
`pinned` / `level` 上**没有残留的默认值约束** —— SQL Server 的默认值是具名约束，`alter_column(server_default=None)` 要真删得掉）。
**没测的**：MySQL。

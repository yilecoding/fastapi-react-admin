# plugin/notice —— 通知公告（读者那一侧 · 附件 · 收件箱联动 · 发布范围 · 定时发布）

> 扩展级插件（`[app] extend = "admin"`），接口在 `/api/v1/sys/notices/*`。上游 FBA 的插件，#186 加了读者那一侧，#190 加了二期。
> 前端在 `packages/platform/src/pages/notice/`，收件箱那一半见 [`plugin/notification` 分册](../notification/AGENTS.md)。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 🔴 「读」和「管」是两个口

| | 接口 | 门槛 | 给谁 |
|---|---|---|---|
| 读者 | `GET /sys/notices/feed` · `/feed/{pk}` · `/feed/popups` · `/feed/banner` | 只要登录 | 工作台 · 铃铛 / 消息中心的详情 · 弹窗 / 横幅 · 移动端 |
| 登录页 | `GET /sys/notices/public` | **不用登录**（`TOKEN_REQUEST_PATH_EXCLUDE` 精确匹配）+ 每 IP 每分钟 30 次 | web / 移动端登录页 |
| 管理 | `GET /sys/notices` · `/{pk}` · `/{pk}/reads` · 增删改 | `sys:notice:add`（和管理页的路由守卫同一个码） | 管理页 |

**症状**（#186 之前）：两者共用 `GET /sys/notices`（只挂 `DependsJwtAuth`）—— 任何登录用户都拿得到**隐藏的**公告和正文；
而前端能读到正文的地方只有管理页，普通用户在铃铛里点公告跳过去是 403，点这一下还已经标了已读。

`feed` / `public` 要声明在 `/{pk}` **前面**，`feed/popups` / `feed/banner` 要在 `/feed/{pk}` 前面，不然被当成 pk、422。
「我已阅读」/ 关横幅 / 看过弹窗都走收件箱的 `PUT /sys/notifications/{notification_id}/read`（`notification_id` 在 feed 系列接口里），不另开接口。

## 🔴 「谁看得见」只有一份：`crud_notice.readable_clause(viewer)`

`live_clause()`（没删 · 显示 · 到了发布时间 · 没过期）**加上**发布范围里有这个人（#190，见下一节）。
读者列表、读者详情、弹窗、横幅、**附件下载权限**（`notice_service._notice_file_access`）、收件箱回形针的附件数都用它。
只有两处直接用 `live_clause()`：登录页（没有「看的人」，所以那里另外要求**没有受众行**）和定时任务（判该发 / 该撤）。
另写一份的后果是两边对不上：#186 之前附件权限只看「没删」，于是隐藏公告的附件照样下得到（实测 200、字节一致），而列表上已经看不见了。

- 管理端的人（`sys:notice:add` / `sys:notice:edit`）对没删的都放行附件 —— 编辑表单里要预览隐藏草稿的附件
- 隐藏 / 过期 / 没到发布时间 / 不在范围里 / 删了的详情一律 **404**，不区分（403 等于告诉对方「这条存在」）
- ⚠️ 入参里的 `expire_time` / `publish_time` 可能不带时区，和 `timezone.now()` 比会 TypeError：`_is_live()` 先按应用时区补标记（同 `TimeZone.process_bind_param`）
- ⚠️ 布尔列当条件直接写（`.where(Notice.popup)`），**不写 `.is_(True)`**：后者在 SQL Server 上渲染成 `IS 1`，语法错
  （SQLAlchemy 编译三个方言的实测：PostgreSQL / MySQL 是 `IS true`，SQL Server 是 `IS 1`；裸列在 SQL Server 上是 `= 1`）

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

#190 起判据是「**现在该不该被看见**」对「**有没有挂着的那一行**」（`notice_service._align_inbox`），不再比改之前的字段：

| 公告的变化 | 收件箱那一行 |
|---|---|
| 该看见、没有行（新建即显示、隐藏改显示、过期时间往后挪、发布时间改到现在之前） | 新写一行 |
| 不该看见、有行（隐藏 / 删除 / 改成已过期 / **已发布的改成未来时间**） | 撤回（逻辑删除 + 清已读标记） |
| 一直看得见、只改了标题 | 改那一行的标题 / 摘要，不重新发 |
| 一直看得见、改了发布范围 | 不重发（受众表是现查的），推一次让在线的人重拉；从「指定」放宽成全员时补推群机器人（下一节） |
| 建出来就已经过期 / 定了未来的发布时间 | 不发（后者交给定时任务） |
| 定时发布到点 · 自然过期 | 定时任务 `notice.sync_inbox` 发 / 撤（下面一节） |

撤回和改标题都要**提交之后推一次** `notification:new`（`push_broadcast_after_commit`）：不推的话在线的人红点里还数着撤回的那一行，点进去是「已撤回」。
前端收到这个事件也要连公告读者列表一起失效（`invalidateInbox`），不然工作台公告卡要等手动刷新。

读者列表的「读没读」就是那一行的已读状态（`sys_notification_read`），不另建已读表 —— 工作台、铃铛看到的是同一份。
没有收件箱行的（#186 之前发的、对不上的、没到发布时间的）算已读。迁移 `af000000noticereach` 按**标题恰好对上一条**认领旧行，对不上的不动（猜错等于把 A 的已读挂到 B 上）。
「读没读」的判定只有一份（`crud_notice.unread_by(viewer)`）：工作台的 `read`、弹窗、横幅都用它，含下面的新账号规则。

#186 时「自然过期不撤回收件箱行（没有事件可挂）」，#190 起由定时任务撤。

## 🔴 发布范围：受众表 + 「看的人」（#190）

受众不存在公告表上，在通知插件的通用表 `sys_notification_audience`（`source = 'notice:<id>'` · `kind` = dept / role / user · `target_id`）。
**同一个来源一行都没有 = 全员**。收件箱行的可见性（`crud_notification.visible_to`）和公告的可见性（`readable_clause`）读的是**同一张表、同一个判定**
（`notification/audience.py: audience_admits`），所以「铃铛里有这条」和「点进去看得到」「附件下得到」不会各说各的。

- 「看的人」`Viewer(id, join_time, dept_ids, role_ids)` 在接口层由 `request.user` 构造一次（`audience.viewer_of`）：
  `dept_ids` = 本部门 + **所有上级部门**（发给「技术中心」，后端组的人也要看得到），`role_ids` = 启用的角色
- 判定在看的人这一侧做，所以受众表里只存被点名的部门，不展开子树 —— 之后在它下面新建的组自动在范围内。
  阅读统计要反过来「发给了哪些人」，`audience_user_clause` 往下展开子树，两边都只走没删的部门
- 入参 `audience: [{kind, target_id}] | None`：`None` = 不改（PUT 按 `exclude_unset`），`[]` = 全员。点的部门 / 角色 / 用户要存在，
  否则 400 —— 一个不存在的 ID 进了受众表谁也匹配不上，这条公告就对所有人**静默消失**了
- 🔴 **有发布范围的不推群机器人**（`broadcast(to_bots=False)`）：机器人发进的是一整个群，管不了「只给技术中心看」。spec 没写这条，
  不加的话限定范围的公告原文会出现在全公司的群里。🔴 **之后放宽成全员要补推**（`_align_inbox` 的 `widened` → `notification_service.broadcast_to_bots`），
  挂在挂着的那一行上（站内不重写），那一行推过群就不再推（全员 → 限定 → 全员 不在群里出现两次）。#190 评审之前不补：这条公告永远进不了群
- 🔴 **登录页可见 + 有发布范围 → 422**（不登录的人都看得到，和「只给技术中心」自相矛盾）；**必须确认 + 不弹窗 → 422**（没有出口）。
  按**生效后**的值判：PUT 没传的字段按库里原值，库里已经「登录页可见」时只传一个受众照样 422
- 登录页的查询里**再要求一次没有受众行**：直接改库、或者以后哪条写入路径漏了校验，也不会把限定范围的公告摆到登录页上
- ⚠️ 降级迁移会丢掉「发给谁」和「什么时候发」，旧代码里它们就是**全员立刻可见**：`ag000000noticephase2` 的 downgrade 先把有范围的、
  没到发布时间的公告改成隐藏、收件箱行撤掉

## 🔴 定时发布 + 过期撤回：`notice.sync_inbox`（每 60 秒）

`publish_time` 为空 = 立即；在未来 = 到点之前读者看不到、不进收件箱（新建 / 编辑时不广播，交给任务）。任务在 `app/task/tasks/notice/tasks.py`，
调度在 `task_scheduler`（种子 + 迁移 `ag000000noticephase2`，同 `u0000000health`），高频任务的两条纪律（`ignore_result` / `notify=False`）都带着。

- **到点**：发出去了（`live_clause`）· **定过**发布时间 · 没有挂着的收件箱行 → 广播 + 提交后推送
- **过期**（及兜底：隐藏 / 删除 / 改成未来）：读者已经看不见、收件箱行还挂着 → 撤回 + 提交后推送
- 🔴 **只认定过发布时间的**。#186 之前发的、认领不上的老公告也是「显示中 · 没有收件箱行」，不加这一条的话任务第一次跑就把它们全员重发一遍
  （`publish_scheduled` 锁住之后重判时也要求定过发布时间 —— 两处都在，单去掉一处测试照旧绿）
- 🔴 **每条一个事务，先锁住公告再重新判一遍**（`notice_dao.lock`）：列表是锁之前取的，取完到这里之间可能被改成隐藏、也可能另一个 worker
  刚发完。⚠️ SQL Server 不认 `FOR UPDATE`（SQLAlchemy 在 mssql 上什么都不渲染），要 `with_hint(…, 'WITH (UPDLOCK, ROWLOCK)', 'mssql')`。
  🔴 **管理员编辑（`update`）第一句拿的也是这把锁**（#190 评审补的，见「实测证据」）；删除不拿 —— 它先 UPDATE 公告行（同一行上的锁），之后才撤收件箱行。
  ⚠️ 锁要是事务里的**第一条**语句：MySQL 的可重复读在第一次普通读时定快照，锁之前读过一次，锁到手之后也看不见对方刚提交的那一行
- 任务自己开会话，模块登记在 conftest 的 `_PATCHED_SESSION_MODULES`

## 🔴 新账号的「未读」（规则在通知插件）

**建号之前**写的广播行对他算已读：不计红点，收件箱列表里 `read_time` 回填成 `join_time`，feed 的 `read` 为真（`crud_notification.implicitly_read`）。
不这样的话新来的人一登录就是几十条历史公告的红点。
🔴 **例外：还发着的必须确认公告（`require_ack`）只认显式的已读行** —— 必须点「我已阅读」的东西，新来的人也要点。
公告那一侧是 `unread_clause(explicit_only=Notice.require_ack)`（只问看得见的公告），收件箱那一侧是登记的 `must_ack_inbox_rows`
（`require_ack` + `live_clause()`），**两边同一个口径**：新人的铃铛里那条是未读、标「需确认」、算进 `requires_ack_count`，弹窗照弹、工作台上是未读，
阅读统计里他在「未读」。#190 评审之前收件箱那一侧照样吃新账号规则 —— 铃铛说他读过了、弹窗却要他点「我已阅读」（见「实测证据」）。
公告过期 / 看不见之后，那一行就是普通的一行：新账号规则照常，阅读统计同一个口径（`get_reads` 判 `require_ack` 时也看 `_is_live`）。

🔴 **必须确认的只有单条确认一个出口，「全部已读」跳过它**：`notice_service` 把 `crud_notice.must_ack_inbox_rows` 登记给通知插件
（`sources.register_explicit_ack`，和 `unread_by` 的 `explicit_only=Notice.require_ack` 同一列）。
**症状**（修之前）：铃铛 / 消息中心 / 移动端点一下「全部已读」，必须确认的公告一起被标掉 —— 弹窗不再弹、工作台成了已读、阅读统计里他在「已读」，
而他从没点过「我已阅读」；消息中心那一行的「标记已读」同样。**根因**：`read-all` 只按未读取 ID；行上的 PUT 和「我已阅读」是同一个口。
**修法**：`read-all` 排除登记的行；列表行带 `requires_ack`、`unread-count` 带 `requires_ack_count`，前端据此不摆行按钮、按「能标的条数」判「全部已读」
（前端那一半见 [`pages/notification` 分册](../../../../../packages/platform/src/pages/notification/AGENTS.md)）。
**实测证据**：`test_notice_phase2.py::test_read_all_does_not_acknowledge_for_the_reader`（read-all 之后普通的已读、必须确认的仍未读 + 照弹、
`total == requires_ack_count`、单条 PUT 照常确认、同时在的一条**没有来源**的点名消息照样被标掉），PostgreSQL / SQL Server 都过。
变异各打红（两个方言都验了）：`get_unread_ids` 不排除 · 公告不登记 · 列表行不填 `requires_ack` · 计数恒 0 ·
排除条件去掉 `source IS NOT NULL`（NULL 取反还是 NULL，系统消息被一起跳过 —— 这是第一版真实的 bug，见通知插件分册）。

## 弹窗 · 横幅 · 登录页 · 阅读统计（#190）

| 接口 | 条件 | 条数 · 内容 |
|---|---|---|
| `GET /feed/popups` | 看得见 · `popup` · 我没读 | 置顶 → 级别 → 新到旧，最多 10 条，**带正文** |
| `GET /feed/banner` | 看得见 · 置顶 · 紧急 · 我没读 | 最多 3 条，不带正文；关掉 = 标已读 |
| `GET /public` | `live_clause` · `public` · 没有受众行 | 最多 5 条；`{id, title, level, pinned, publish_time, created_time, summary}`，摘要是正文去标签后的纯文本、200 字 |
| `GET /{pk}/reads?read=` | `sys:notice:add` | 分页 + `read_count` / `unread_count`；行 `{user_id, username, nickname, dept_name, read_time}` |

- 读者列表按 `coalesce(publish_time, created_time)` 排：一条一周前建好、今天才到点的公告不该沉在一周前的位置
- 🔴 **`feed` 列表不读正文列**（`crud_notice.FEED_COLUMNS`）：正文是富文本、可以很长，列表一行都用不上
- 登录页也给 `publish_time`，显示 `publish_time ?? created_time`（同读者那边）：原来只给 `created_time`，定时发布的公告在登录页上写的是建的那天，
  登录进去读者看到的是发布那天（`test_public_carries_the_publish_time_of_a_scheduled_notice`，变异：不给 → 红）
- 登录页的摘要只给纯文本（`plain_summary`）：正文里的图、链接一样都不出去，`<script>` / `<style>` 的内容整段丢掉
- 阅读统计的「已读」= 挂着的那一行上有已读标记的人；「未读」= 发布范围内、启用的、没删的账号里没读过的（新账号规则同上）；
  **还没有收件箱行**（没到发布时间 / 隐藏 / 过期撤回了）两边都是空的 —— 还没发到任何人手里，不是「全员未读」。
  分页的 `total` 是当前页签的条数，所以两个页签的人数另给 `read_count` / `unread_count`（spec 写的是 `{read_count, total}`，`total` 和分页撞名）

## 决定不做的（#190）

- **正文内联图改私有**：`<img src>` 带不上鉴权头，要改就得把渲染链路换成短时效签名地址（web / 移动端 / 富文本组件三处），
  代价远大于收益。管理表单里「有保密要求的内容放附件」那句提示保留（附件受发布范围约束，内联图不受）
- **读者下载附件记日志**：阅读统计已经回答「谁看了」；每次下载多一次写入换来的信息量很小

## 实测证据

### #186

`app/admin/tests/api_v1/test_notice_reach.py` 17 条 + `test_notice_visibility.py` 2 条，PostgreSQL 私有测试库 + 真实 Redis（2026-10-30）。
变异 12 处各打红对应那条：PUT 整份写回 · `get_max_sort` 的 `or -1`（真实最大值 0 被当成「没有」，追加的附件和第一个撞号）· 撤回不推 · casbin 模式也收紧 ·附件权限只看没删 · 广播当场推不等提交 · 挂附件不看业务权限 · 隐藏不撤回 · 允许公开文件当附件 · 读者列表不看过期 · 收件箱链接指回管理页 ·
挂附件不看操作人读不读得了（这条要用**真实的**用户快照：别的模块登记的读权限判断会读快照上的字段，`SimpleNamespace` 造的假用户在那里就 AttributeError 了）。
迁移在 PostgreSQL 私有测试库上 `upgrade → downgrade -1 → upgrade`：存量公告 `pinned=false / level=0`；造一条标题对得上的公告之后，那一行的 `source` / `link` 被认领，
降级时链接改回 `/plugins/notice`。
SQL Server 2022（本机容器的私有库）：上面两个文件 + `plugin/notification/tests/` 全部 + `test_file_access.py` / `test_notice_file_cleanup.py` / `test_migrations.py` / `backend/tests/` 共 327 条全过；
迁移 `downgrade -1`（四列消失、种子那行收件箱链接回到 `/plugins/notice`）→ `upgrade`（存量公告 `pinned` / `level` 回填 0，那一行按标题被认领，
`pinned` / `level` 上**没有残留的默认值约束** —— SQL Server 的默认值是具名约束，`alter_column(server_default=None)` 要真删得掉）。
MySQL 当时没测；#190 那次在 MySQL 8.4 上补跑了这两个文件（下面一段）。

### #190（2026-10-31）

`app/admin/tests/api_v1/test_notice_phase2.py` 22 条，用种子里的真实账号（liuyang 后端组 / zhangwei 技术中心 / sunqiang 市场 / zhoumin 总部 VIEWER）
和现建的新账号。三个方言各跑同一组：这个文件 + 一期两个文件 + `test_file_access.py` / `test_notice_file_cleanup.py` +
`plugin/notification/tests/` + `plugin/open/tests/test_webhooks.py` + `test_migrations.py` / `test_scheduler_api.py` + `security/` + `backend/tests/`，
**PostgreSQL 16 / SQL Server 2022 / MySQL 8.4 各 544 条全过**（私有库 + 一次性 Redis）；PostgreSQL 全套 1423 过、18 跳过。

变异 24 处各自打红对应那条（都核过红在被测的那句断言上，不是导入错误之类）：
收件箱广播不看受众 · 公告不看受众 · 附件权限不看受众 · 标已读只比 `recipient_id` · 不带上级部门 · 不看发布时间 ·
去掉行锁 · 锁后不重判 · 任务不撤过期 · 去掉新账号规则 · 必须确认也吃新账号规则 · 阅读统计不吃新账号规则 · 列表选正文 ·
必须确认不弹窗放行 · 登录页可见带范围放行 · 登录页查询不看受众行 · 有范围也推机器人 · 阅读统计不看范围 · 改范围不推送 ·
登录页不在 JWT 白名单（带坏 token 401）· 登录页不限流 · 范围对象不校验存在 · 摘要原样给正文 · Webhook 提交后不踢（`kick_after_commit` 迁到公用那份之后）。
⚠️ **单独去掉「任务只认定过发布时间的」那一处仍绿**：`publish_scheduled` 锁住之后重判时也要求定过发布时间，两处一起去掉才红。
⚠️ 并发那条（两个会话抢发同一条，第一个停在广播里）在 PostgreSQL 上去掉锁会红（`[True, True]`）；SQL Server 关着 RCSI 时，
第二个会话读收件箱表会被第一个未提交的插入挡住，**去掉锁可能照样绿**，那条变异只在 PostgreSQL 上验过。

迁移 `ag000000noticephase2` 三个方言都是「先放三条公告（有范围 + 收件箱行 / 明天发布 / 普通）→ `downgrade -1` → `upgrade`」：
降级后前两条变隐藏、有范围那条的收件箱行撤了、普通那条不动，四列 / 受众表 / 调度行消失；升回来存量行三个开关回填 0、`publish_time` 为空，
调度行回来。SQL Server 上四列**没有残留的默认值约束**、`sys_notification_audience` 不在 `sys.identity_columns` 里；
MySQL 上四列的可空性和注释都在（`DROP DEFAULT` 不是 `MODIFY`，不丢属性）；PostgreSQL 的 `column_default` 都是空。

**没测的**：真 worker 里跑 `notice.sync_inbox`（测试直接调 `sync_inbox_once`，没起 celery / beat）；前端 / 移动端；
多副本 beat 同时派发（只用两个会话模拟了两个 worker 抢同一条）。

### #190 评审（2026-10-31）

独立评审找出、落在公告这一侧的三条（收件箱那一侧的见 [通知插件分册](../notification/AGENTS.md)「#190 评审补的」，
web 弹窗「我已阅读」404 那条见 [`pages/notification` 分册](../../../../../packages/platform/src/pages/notification/AGENTS.md)）：

| 症状 | 根因 | 修法 | 测试（`test_notice_phase2.py`） |
|---|---|---|---|
| 管理员编辑和定时任务（或者同一个编辑点了两下）同时对齐同一条公告：挂上两行收件箱行 —— 铃铛里出现两次；必须确认的点了「我已阅读」还在弹（弹窗看「任一行未读」，`notification_id` 给的是新行） | `update` 不锁公告就读「有没有挂着的行」，对方的广播还没提交 | `update` 第一句 `notice_dao.lock`（任务用的那把）；删除靠「先 UPDATE 公告行」排上队 | `test_an_edit_queues_behind_whoever_is_aligning_the_inbox`（`task-edit` / `edit-edit` / `task-delete`） |
| 必须确认的公告过期了、任务还没撤：阅读统计里新账号还算「未读」，收件箱那边已经是普通的一行 | `get_reads` 的新账号例外只看 `require_ack` | 同收件箱：只在还发着时例外 | `test_a_must_ack_row_whose_notice_is_gone_becomes_an_ordinary_row` |
| （性能）阅读统计把当前页签再数一遍 | 分页的 `total` 已经是它 | 只另数另一个页签（`common/pagination.py: count_rows`，审批流查询的分页也换成它） | `test_reads_counts_each_tab_once` |

修之前先写测试跑了一遍，三条都红（编辑那条 `task-edit` / `edit-edit` 都是 `2 == 1`）。修完之后逐处改回去：

- 编辑不锁（换回 `get`）：PostgreSQL / SQL Server / MySQL 都红在 `task-edit`（`2 == 1`）。⚠️ 和上面「并发那条在 SQL Server 上去掉锁可能照样绿」不一样：
  这里任务拿着的是 UPDLOCK，编辑的普通读不被它挡，SQL Server 上照样红
- 锁之前先有一次普通读：**只有 MySQL 红**，PostgreSQL / SQL Server 绿（读已提交，每条语句重新取快照）—— 「锁要是第一条语句」那句就是这么来的
- 删除改成先撤收件箱行、后 UPDATE 公告：三个方言都红在 `task-delete`（`1 == 0`：撤的时候任务那一行还没提交，删完它冒出来挂在一条删了的公告上）
- 阅读统计的例外不看还发不发着：PostgreSQL 红 · 两个页签都重数：PostgreSQL 红 · 复用 `total` 时两个数对调：PostgreSQL / MySQL 红在 `test_reads_statistics_follow_the_audience`

这个文件 32 条三个方言都过。目标测试集（这个文件 + 一期两个 + 附件两个 + `test_export.py` + `plugin/notification/tests/` + `plugin/workflow/tests/` +
Webhook + 迁移 / 调度 + `security/` + `backend/tests/`）：PostgreSQL 16 / SQL Server 2022 / MySQL 8.4 各 729 过、14 跳过。

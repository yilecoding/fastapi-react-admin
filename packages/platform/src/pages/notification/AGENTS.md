# pages/notification —— 消息中心（站内收件箱）

> 顶栏铃铛 + 完整列表页。传输层与数据模型在后端
> [`plugin/notification`](../../../../../apps/api/AGENTS.md)，socket 连接在
> [shell 分册](../../shell/AGENTS.md)。
>
> 这份文件是 [`packages/platform/src/pages` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 三个文件各管一件事

| 文件 | 职责 |
|---|---|
| `api.ts` | query key 工厂 + queryOptions + mutation。**铃铛和页面共用它** —— 任一处标记已读，另一处的红点立刻跟着变，不用互相通知 |
| `bell.tsx` | 顶栏铃铛：红点 + 下拉预览（最近 8 条 / 三个页签 / 全部已读 / 查看全部） |
| `index.tsx` + `columns.tsx` | 完整列表页（翻历史 / 筛已读未读 / 全部已读），标准三件套 |
| `use-open.ts` | 「点开一条通知」的唯一实现（校验 `link` + 未读才标已读），两处共用 |
| `shared.tsx` | 分类的图标/配色/标签 + 相对时间（「2 分钟前」） |

## 🔴 铃铛是外壳家具，但**不要**放进 `shell/`

它只在 `routes/_auth.tsx` 的顶栏挂一次，`page-registry.tsx` 里**没有**它。
放在 `pages/notification/` 而不是 `shell/` 的理由只有一个：它和消息中心页共用
`api.ts`。放进 `shell/` 就是 `shell → pages` 的反向 import ——
那条路只留给 `use-sidebar → dev-sandbox` 那个没有别的办法的特例
（见 [shell 分册](../../shell/AGENTS.md)）。

跳转一律用 `<Link>`，不用 `useNavigate()`：页面组件要 router-独立（硬纪律 1），
而 `<Link>` 走 router context，隐藏 tab 里照样可用。

## 🔴 红点必须能靠 REST 拿到正确值，不能只靠 socket

`unreadCountQuery` 在登录后就会拉一次；socket 的 `notification:new` 只是
**让它早一点更新**。反过来（只靠推送）的失败是永久性的：`use-presence.ts`
的哲学是「连不上不报错、不影响业务」，于是断线期间到达的通知会在红点上
**永远看不见**，而界面上没有任何异常。

同理，事件 payload 是空的，前端也**不要**去信任它 —— 收到就重新拉，
权限判断只有 REST 一处（后端 `common/socketio/actions.py` 的注释写了为什么）。

## 🔴 取数失败要看得见，包括红点本身

`unread.error` 时铃铛角标显示的是一个 `!`（`notification-badge-error`），
不是「什么都不显示」—— 后者和「一条未读都没有」长得一模一样（硬纪律 9）。
下拉里的列表失败走 `QueryError` + 重试。

## 分类的数值是契约

`api.ts` 的 `CATEGORY` 和后端 `plugin/notification/enums.py` 一一对应，
**改数字要两边一起改**，那些值已经落进库了。
`categoryMeta()` 对未知分类有兜底：后端加了新分类而前端还没更新时，
显示一个中性图标，而不是整条渲染不出来。

## 「状态」筛选用数字 1/0，不用布尔

`QueryBar` 的选项值进 URL 之后是字符串，布尔 `false` 会被写成 `'false'`，
再被 zod 的 `coerce.boolean()` 判成 `true`（非空字符串一律真）——
**静默反转**。所以 route schema 里 `unread` 是 `coerce.number()`，
页面里再映射成 `true/false/undefined`；`undefined` 必须保持 `undefined`
（= 不筛），写成 `raw.unread === 1` 会把「不限」变成「只看已读」。

## 🔴 `link` 可以带查询串，要拆成 `to` + `search`

审批通知的 link 是 `/workflow/inbox?id=…`。原来两层都会把它静默弄坏：

- `isValidPath` 拿**整串**比路由表 —— 带 `?` 永远比不中，整条通知变成「不可点」
- 就算比中了，铃铛和列表的 `<Link>` 写着 `search={{}}`，`?id=` 被扔掉，点进去不是那一张单

现在 `useNotificationOpen().linkOf` 返回 `{ to, search }`（`new URL(link)` 拆开，值保持字符串，
硬纪律 6），`apps/web/src/lib/valid-paths.ts` 只比路径部分。
**实测证据**：`workflow.spec.ts` 第一条点「已通过」那条通知应打开对应审批单；
把这两处修复打回去，它报 `element(s) not found`（链接根本没渲染成可点的）。

## 🔴 公告那一行认 `source`、就地打开读者抽屉，不跟 `link`（#186）

**症状**（修之前，#186 正文里用 zhoumin 实测的）：普通用户在铃铛 / 消息中心点「公告《xx》已发布」，落在
`/403?from=/plugins/notice&need=sys:notice:add`，而且这一下已经把它标成已读（未读数 13 → 12）。

**根因**：公告广播那一行的 `link` 是管理页（路由守卫要 `sys:notice:add`），
而 `isValidPath` 只看路由在不在、不看权限 —— 渲染成可点、点进去 403。

**修法**：后端给收件箱行加了 `source`（`notice:<id>`），`api.ts` 的 `noticeIdOf(n)` 认它；
认出来就**不走 `link`**，就地打开 `pages/notice/reader-sheet.tsx`（数据走 `/sys/notices/feed/{pk}`，只要登录）。

- 认 `source` 不认 `link`：`link` 是库里的自由字符串，拿它猜「这是不是公告」迟早猜错。
  `source=null` 的老行（迁移按标题认领不上的）照旧跟 `link`，只有一处兜底：指着 `/plugins/notice`
  而本人没有 `sys:notice:add` 时 `linkOf` 返回 `null`（不可点、正文照样看得到）—— 不可点总比点进 403 强
- 铃铛的抽屉挂在 `Popover` **外面**：点一行要先关下拉再开抽屉，挂在 `PopoverContent` 里会跟着下拉一起卸载
- 消息中心把开着的那条写进 search 的 `notice`（硬纪律 2），关掉时只删这一个键；
  后端新行的 `link` 就是 `/notification?notice=<id>`，群机器人卡片的深链也靠它直接打开那一条
- 铃铛不在任何 tab 里，抽屉的 portal 容器拿到的是 `undefined`（见 [shell 分册](../../shell/AGENTS.md) 最后一节 —— 那条坑就是在这儿踩的）

**实测证据**：`apps/web/e2e/tests/notice-reach.spec.ts` 前两条（`test` / `zhoumin` 两个非管理员账号）。
变异：`noticeIdOf` 恒返回 `null` → 第一条当场红（那一行不再带 `data-notice-id`，退回成跟 `link` 走的链接）。

## 🔴 公告的「标已读」只在读者抽屉里做，点那一行时不标（#190 必须确认）

**症状**（修之前的写法）：一条「必须确认」的公告，读者在铃铛 / 消息中心点那一行 —— 还没看到正文，
它就已经算「确认过了」：弹窗不再弹、阅读统计里他在「已读」，而他从没点过「我已阅读」。

**根因**：点行时先 `readIfUnread(n)`（抽屉再靠 `rowAlreadyMarked` 跳过一次）。那个 `PUT /notifications/{id}/read`
就是后端认的**显式已读**，而收件箱那一行上没有 `require_ack`，行这一层根本不知道这条要不要确认。

**修法**：公告那一行只开抽屉，标不标交给 `notice/reader-sheet.tsx` —— 它拿到详情才知道：普通的照旧自动标，
`require_ack && !read` 的不标，底部给「我已阅读」。`rowAlreadyMarked` 删了（只剩一处会发 PUT，也就没有「两个 PUT 抢着发」）。

**实测证据**：`apps/web/e2e/tests/notice-phase2.spec.ts`「读者抽屉」那条（从铃铛点开必须确认的公告，1.5 秒后接口里 `read` 仍是 `false`）。
变异：铃铛那一行改回「先 `readIfUnread` 再开抽屉」→ 当场红在 `notice-reader-ack` 可见那句；抽屉对必须确认的也自动标 → 同一句红。

## 🔴 「全部已读」和行上的「标记已读」也不能替人确认（#190 补的两个口）

**症状**（修之前）：上一节只堵了「点那一行」。铃铛 / 消息中心 / 移动端点一下「全部已读」，或者消息中心那一行点「标记已读」，
必须确认的公告照样被标掉 —— 弹窗不再弹、阅读统计里成了已读，而他从没看过正文。

**根因**：`PUT /notifications/read-all` 只按未读取 ID；行操作的 `PUT /{id}/read` 就是「我已阅读」走的那个口，而收件箱那一行不知道这条要不要确认。

**修法**：后端在收件箱那一行上给 `requires_ack`（来源方登记的条件现算，见 [`plugin/notification` 分册](../../../../../apps/api/backend/plugin/notification/AGENTS.md)），
「全部已读」跳过这些行，`unread-count` 多给一个 `requires_ack_count`。前端：

- 行操作：`requires_ack` 的那一行不摆「标记已读」，换一个说明原因的标记（`notification-needs-ack-<id>`，tooltip「点标题打开，读完点我已阅读」）；
  `use-open.ts` 的 `readIfUnread` 也跳过它（兜底，公告行本来就不走它）
- 🔴 「全部已读」的按钮 / 确认框按 **`markableUnread()` = `total − requires_ack_count`** 判，不按 `total`：只剩必须确认的时红点照亮（那是对的，它确实没读），
  按 `total` 判的话按钮一直亮着、确认框说「会把 1 条标为已读」、点完什么都不变。确认框里另说一句「另有 m 条必须确认的公告不会被标记」
- 铃铛那一行标一个「需确认」：按钮灰了、红点还在，不标出来就看不出为什么

**实测证据**：`apps/web/e2e/tests/notice-phase2.spec.ts`「消息中心」那条（私有实例 :8003 / :1127，2026-10-31；同文件 + `notification.spec.ts` / `notice-reach.spec.ts` / `login.spec.ts` 共 21 条全过）。
变异：行操作不看 `requires_ack` → 红在 `notification-needs-ack-…` 可见那句；按钮按 `total` 判 → 红在最后的 `toBeDisabled()`。
后端那一半（read-all 跳过、单条 PUT 照常生效）见 `test_notice_phase2.py::test_read_all_does_not_acknowledge_for_the_reader`。

## 公告二期（#190）的几个外壳件：弹窗 / 横幅挂在 `NOTICE_FEED_KEY` 下面

`pages/notice/popup-host.tsx`（登录后弹窗）和 `banner.tsx`（顶栏下的横幅）和铃铛一样是外壳家具，挂在 `routes/_auth.tsx`，不进 `page-registry`。
它们的 query key 是 `noticeKeys.popups()` / `banner()`，**在读者 feed 前缀下面**：铃铛收到 socket `notification:new` 调的 `invalidateInbox`、
任何一处标已读，都会把它们一起重取 —— 在线的人当场弹出新发的必读公告，就靠这一点，没有另外订阅。
**实测证据**：把弹窗的 key 挪出 feed 前缀（`[...noticeKeys.all, 'popups']`）→ `notice-phase2.spec.ts`「必须确认的弹窗」红在「在线时新发的当场弹」那句。

取数失败时弹窗 / 横幅**不画**、只 `console.warn`，是对硬纪律 9 的有意偏离，理由写在 `popup-host.tsx` 头注释（推出来的提醒；同一批公告在铃铛 / 工作台里看得到、那几处的失败是可见的）。

🔴 **必须确认的弹窗，「我已阅读」回 404 = 这条没了，放走、接着弹下一条**（#190 评审）。
**症状**：弹窗开着的时候那条公告被撤回 / 过期了，点「我已阅读」→ 按钮旁边一行「通知不存在」，再点还是 404；这个弹窗没有 ×、Esc 和遮罩都不理 ——
整个外壳被挡住，只能刷新。**根因**：`PopupBody.acknowledge` 把 404 当普通错误留在原地，而 404 是**结论**（后端对撤回 / 过期 / 看不见的行一律 404，重试也不会变）。
移动端（`notice-popups.tsx`）早就按 `isNoticeGone` 放行了，web 漏了。
**修法**：404 → 提示「这条公告已撤回或已过期」、当作处理过、接着弹下一条；`useMarkNoticeRead` 的 `onError` 遇到 404 也 `invalidateInbox`
（手上的弹窗 / 横幅 / 铃铛 / 读者抽屉都是旧的，一起重取）。
**实测证据**：`notice-phase2.spec.ts`「弹着的时候撤回 / 过期了」（`page.route` 只让那一行的标已读回 404 —— 真撤回会推 socket、弹窗那份当场重取，
到不了「点了才 404」）。私有实例 :8003 / :1127，2026-10-31。变异各自当场红：404 照旧当普通错误 → 红在「接着弹下一条」那句（标题还是撤回的那条）；
`onError` 不重取 → 红在等 `feed/popups` 重取的那句。

## 🔴 发布范围：「指定」一个都没选 ≠ 不改；编辑时没动过范围就别发

`audience` 的契约是 `undefined` = 不改、`[]` = **全员**。两个静默放大 / 静默失败的坑，表单（`notice/form.tsx` + `audience-field.tsx`）都拦了：

- 选了「指定」却一个都没勾，发出去就是 `[]` —— 一条想只给技术中心的公告**悄悄发给了所有人**，接口 200。提交前报错拦住
- 范围里点过的人 / 部门后来被删了，编辑时把范围**原样发回去**会整条 400（「发布范围里有不存在的部门、角色或用户」）—— 改个标题都存不上。
  所以编辑时范围没动过就不带 `audience`（`sameAudience`）；删了的对象在下拉里照样列出来（「已删除的…」），能看见、能去掉

**实测证据**（私有实例 :8003，2026-10-31）：建一条只发给某人的公告 → 删掉那个人 → 详情里那一项 `name: null`；
`PUT` 带原样的 `audience` → **400**；不带 → 200；带 `[]` → 200，详情里 `audience` 变成 `[]`（全员）。
变异：去掉「指定一个都没选」的拦截 → `notice-phase2.spec.ts`「管理表单」红在 `n-audience-error` 可见那句；发出去的范围丢了部门 → 红在「库里存的就是那个部门」那句。

⚠️ 选人 / 部门 / 角色的下拉绑的是底座接口（`/sys/users` · `/sys/depts` · `/sys/roles/all`），各要 `sys:user:list` / `sys:dept:list` / `sys:role:list`。
只有发公告权限、没有这三个码的人，下拉下面是一行「没有权限查看这些数据」（不是空列表，硬纪律 9）—— 这是**已知限制**；
E2E 只用 admin 验过表单，「有公告权限、没这三个码」的角色没实测过。

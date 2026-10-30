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

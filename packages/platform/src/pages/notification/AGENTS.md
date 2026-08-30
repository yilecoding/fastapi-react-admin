# pages/notification —— 消息中心（站内收件箱）

> 顶栏铃铛 + 完整列表页。传输层与数据模型在后端
> [`plugin/notification`](../../../../../apps/api/AGENTS.md)，socket 连接在
> [shell 分册](../../shell/AGENTS.md)。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

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

# platform/shell —— 登录后的外壳

> 多页签、偏好设置、侧边栏。页面本身的约定在 `packages/platform/src/pages/`。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

## 偏好设置

界面偏好落在 `shell/preferences.ts`，界面在**个人中心**下（这些是每个人自己的口味，
不是系统配置）。三件套：

| 文件 | 作用 |
|---|---|
| `shell/preferences.ts` | 状态 + 预设表（`THEME_COLORS` / `RADIUS_PRESETS` / `SCROLL_MODE_LABELS` / `TAB_STYLE_LABELS`） |
| `shell/use-apply-preferences.ts` | 把偏好写到 `document.documentElement`（`.dark` class + CSS 变量 + `data-scroll-mode`） |
| `pages/_shared/preferences-panel.tsx` | `usePreferencePanels()` —— 导出**面板描述数组**，不是完整组件（外壳由个人中心统一持有，见下） |

- **改 CSS 变量，不碰组件**：`--primary` / `--radius` 已经是全站 `bg-primary` / `rounded-*`
  的来源（`globals.css` 的 `@theme inline` 引用它们），覆盖根节点上这几个变量即可一次生效
- **挂载点是 `PlatformProvider`** —— 唯一包住整个登录后外壳、又不属于任何页面的组件。
  ⚠️ 登录页不在它下面，所以登录页目前不跟随主题
- **没有「保存」按钮**：偏好改完立刻看得到效果，再点一次保存是多余的一步
- **只放真接通了的开关**。「界面密度」已经通过根节点密度令牌接通；「布局模式」
  （经典侧栏 / 嵌入式 / 浮动式）仍没有侧边栏变体支撑，不摆上去占位。
  「布局」这一节现在只有**滚动方式**一项，将来长出侧边栏变体就往这一节加

### 滚动方式（`scrollMode`：内容区域 / 整页）

两种都有人要，所以做成偏好而不是二选一定死：

| 值 | 行为 | 谁会选 |
|---|---|---|
| `content`（默认） | 外壳锁在视口内，只有内容层滚动；顶栏与标签条钉在原地 | 多页签重度使用者 —— 导航不该被滚走 |
| `page` | 整份文档跟着滚，顶栏和标签条一起滚出视口 | 习惯「一路滚到底」、不想要嵌套滚动条的 |

实现只有**一个开关**：`applyScrollMode()` 往 `<html>` 写 `data-scroll-mode`，
配 `globals.css` 里的 `@custom-variant content-scroll / page-scroll`。
要按模式分叉的地方写 `content-scroll:` 前缀就行，**不要**在组件里读偏好再走 JS 分支
—— `packages/ui` 的 `SidebarInset` 也要分叉，而 ui 永远不能 import platform。

分叉点全在 `apps/web/src/routes/_auth.tsx`，三层缺一不可：

```
wrapper（SidebarProvider）  content-scroll:h-svh + overflow-hidden
inset（SidebarInset）       content-scroll:min-h-0
 └ 内容层（div）             content-scroll:min-h-0 + overflow-y-auto + overflow-x-hidden
```

🔴 **内容层的 `min-h-0` 不是保险，是必需品。** 它是列向 flex 的项，主轴上
`min-height` 默认是 `auto`（= 内容的 min-content 高），少了它这一层拒绝收缩，
`overflow-y-auto` 永远不触发 —— 表现是「设成内容区滚动了，整页还是在滚」，
而 DevTools 里这一层明明挂着 `overflow-y: auto`，极难往 min-height 上想。
横向的同一个坑见下文「`min-width: auto` 是横向溢出的元凶」。

另外两条：

- `overflow-x-hidden` 不能省 —— 一轴非 visible 时另一轴的 visible 会计算成 auto，
  只写 overflow-y 会白得一条横向滚动条
- 标签条要 `shrink-0`（`tab-bar.tsx` 已加）：`h-svh` 的列向 flex 里内容一多，
  它会先被挤扁，看着像「标签行高变了」而不像布局问题

#### 列表页：只滚表格行（筛选栏 / 表头 / 分页条钉住）

内容区滚动模式下，「整块内容一起滚」仍然会把筛选栏和表头滚走。所以列表页再往下走一步：
**表格框自己变成定高视区**，筛选栏、表头、分页条都不动，只有行滚。

这条链**从外壳一直到 `<table>`，每一层都要能收缩**，断一层就整条失效
（表现是「设置生效了，但还是整块在滚」）：

| 层 | 类 | 在哪 |
|---|---|---|
| 内容层 | `min-h-0` + `overflow-y-auto` | `routes/_auth.tsx` |
| TabFrame | `content-scroll:min-h-0` | `shell/tab-outlet.tsx` |
| 页面根 / `@container/main` | `content-scroll:min-h-0` | 各页面（21 处，全量加过了） |
| 页面主块 | `content-scroll:min-h-0 content-scroll:flex-1` | **只有列表页加** —— 这一条就是「我要变成视区」的开关 |
| `data-testid="*-table"` 包装层 | `content-scroll:flex/min-h-0/flex-1/flex-col` | user · notice · log-* · dict |
| 表格外框（带 border 的那层） | `content-scroll:flex/min-h-0/flex-1/flex-col` | `ui/data-table.tsx`、dept / menu 手写的树形表 |
| **`Table` 内部的 table-container** | `content-scroll:min-h-0 content-scroll:flex-1` | `ui/components/table.tsx` |

🔴 **最后一层最容易漏，而且症状会骗人。** `Table` 组件内部还包了一层
`<div data-slot="table-container" class="relative w-full overflow-x-auto">` ——
按 CSS 规则它纵向也算 `auto`，所以 **它** 才是 sticky 表头的滚动祖先，
而不是外面那个带边框的框。只把定高约束加在外框上的结果是：
**行确实滚了、筛选栏确实钉住了，但表头跟着行一起滚走** —— 看着像
「sticky 没写对」，其实是约束停在了上一层。实测踩过。

`min-h-0` / `flex-1` 这些为什么可以无条件写：祖先高度是 auto 时（整页滚动模式、
嵌在卡片和面板里的表格）`flex-1` 在自动高度的列向 flex 里退化成按内容撑开、
`min-h-0` 只是去掉一个下限，两条都是空操作。**所以「谁是视区」只由页面主块那一行决定。**

两个附带的点：

- sticky 表头必须有不透明底色（`bg-muted`）+ `shadow-[inset_0_-1px_0_var(--border)]`。
  Tailwind preflight 给 table 设了 `border-collapse: collapse`，
  这种表里 `thead` 上的 border 会跟着内容滚走，只能用 inset 阴影补那条线
- 卡片流的页面（监控 / 仪表盘 / 个人中心）**刻意不加**页面主块那一行 ——
  把一叠卡片钉成定高视区没有意义，它们照旧整块滚

## 多页签标签条

`shell/tab-bar.tsx` 只做编排，其余各管一件事：

| 文件 | 职责 |
|---|---|
| `tab-bar.tsx` | 横向溢出滚动（两侧箭头 + 滚轮横滚）、活动 tab 自动滚入视区、右侧工具区 |
| `tab-list-menu.tsx` | 总览下拉：全部 tab 一次列全（带数量），点一行跳过去、就地关掉 |
| `tab-item.tsx` | 单个 tab：左键切换 / 中键关闭 / 右键菜单 / × / 固定态；图标取侧边栏菜单树的 |
| `tab-menu.tsx` | 右键菜单：关闭 · 固定 · 重新加载 · 在新窗口打开 · 关闭左侧/右侧/其它/全部 |
| `use-tab-actions.ts` | 动作层：「改 store」和「跳到哪个 tab」成对出现，右键菜单 / 工具区 / 中键三处复用 |
| `tab-store.ts` | zustand + sessionStorage；固定的排最前，`revision` 供重新加载 |
| `preferences.ts` | **外壳偏好**（localStorage）：`showTabs` / `tabStyle` / `tabMiddleClickClose` / `tabShowIcon` / `tabDraggable` |

四条踩过的坑：

- **不能把 tab 做成 `DropdownMenuTrigger`** —— 左键会被菜单吃掉，点 tab 变成开菜单而不是切页。
  菜单必须受控，由 `contextmenu` 事件打开
- 无 trigger 的受控菜单要给 `anchor`，且它必须落在 **Positioner** 上 ——
  透传到 `Popup` 是无效的（`ui/dropdown-menu.tsx` 已补透传）。锚到鼠标坐标用零尺寸虚拟矩形
- **「重新加载」= `revision + 1`**，`TabOutlet` 把它拼进页面组件的 key → 卸载重挂。
  `<Activity>` 保活的页面不换 key 是刷不掉的（state 和已取数据都会留着）
- 🔴 **但光重挂不够，必须同时 `invalidateQueries`。** 全局 `staleTime: 30_000` 让
  react-query 认为数据还新鲜，`refetchOnMount` 于是不发请求 —— 实测「重新加载当前页」
  在 30 秒内是**空操作**（0 次请求），30 秒后才真的重取。一个动作的行为取决于
  「你上次看它是几秒前」，是最反直觉的那种坏（issue #36）。
  用 `refetchType: 'active'`：只有当前可见页面立刻重取，隐藏 tab 的 query 没有观察者
  （`<Activity>` 销毁了 effects），只标记过期、等切回来再取。
  **刻意不改全局 `staleTime`** —— 30 秒是为了「多页签切来切去不打后端」，那条理由仍然成立
- 活动 tab 自动滚入视区时，`querySelector` **必须从标签条自己的 ref 往下找** ——
  隐藏 tab 的页面 DOM 还在文档树里（见硬纪律 5）
- 滚轮横滚要**手动注册非 passive 监听**：React 的 `onWheel` 是 passive 的，
  里面调 `preventDefault()` 无效，控制台还会刷 `Unable to preventDefault` 告警
- **上下留白要放在滚动容器内部**：`overflow-x: auto` 会让 `overflow-y` 也计算成 `auto`，
  贴边的 `shadow-sm` 会被裁掉（表现为「活动 tab 的阴影不完整」）。
  所以 `py-1` 在 `[role=tablist]` 上而不是标签条上，标签条也**不能** `overflow-hidden`
- 两端用 `mask-image` 渐隐（12px），被裁一半的 tab 淡出而不是被生生切断；
  配合 `scroll-mx-5`，活动 tab 滚进来时不会正好压在渐隐带上

### 🔴 换身份必须清空标签页，而且清一次是不够的

**症状**：退出登录、换另一个账号登录 —— 标签条上还是上一个人开过的那些 tab，
包括新账号**没有权限**的页面（点了跳 `/403`，但 tab 不会消失）。issue #29。

**根因两层**：

1. `tab-store` persist 在 **sessionStorage**（`admin:tabs`）。「多页签是会话概念」
   这条设计没问题，但「退出再登录另一个账号」**不换 session** —— 存的东西完整活着。
   而 `logout()` 当时只清了 token 和 query cache
2. 🔴 **只在 `logout()` 里 reset 是不够的**：`useSyncTabs` 的 effect 会在那之后
   再跑一次，把**当前页**原样加回去。链路是 `qc.clear()` → 侧边栏 query 变空 →
   `_auth.tsx` 里的 `resolveTitle`（`useCallback([nav])`）身份变了 → 那个 effect
   的依赖数组变了 → `open()`。
   实测：退出后 sessionStorage 从「仪表盘/参数配置」变成「参数配置」——
   被清掉的只是「不是当前页」的那些，而当前页恰恰是最要紧的那一个：
   它就是下次登录恢复出来的 `activeKey`

**修法是三处一起**：

| 改哪 | 为什么 |
|---|---|
| `tab-store.reset()` | 连固定的一起清 —— 上一个账号固定的页面，下一个账号可能连权限都没有（和 `closeAll` 刻意不同，后者保留固定的） |
| `auth/session.ts` 的 `login()` + `logout()` | 换身份的入口有三个（退出菜单、登录页、401 失效后重新登录），放调用方就是三处都要记得。`login()` 里那次不能省 —— 401 那条链根本不走 `logout()` |
| `useSyncTabs` 里 `if (!isAuthenticated()) return` | 挡住上面第 2 条那次「补加回来」。语义上也对：没有登录态就不该往标签条里加东西 |

⚠️ **偏好设置（`admin:prefs`，localStorage）刻意不清** —— 主题 / 圆角 / 标签条外观
是「这台机器上我想看到什么」，换人登录不该被重置。清它是另一个 bug。

⚠️ 还有一种残留这次**没有**修：同一个账号在线时被管理员撤掉权限，已开的 tab 还在
（点了跳 403）。那要么按权限过滤恢复出来的 tab（要小心「静默删掉一个合法 tab」
比留着更糟），要么在权限变更时把当前页踢走 —— 单独一件事，别混进这条里。

回归测试：`apps/web/e2e/tests/session-tabs.spec.ts`（必须用**两个权限不同的账号**，
同一个账号退出再登录看不出问题）。

### 标签条外观是可配置的（给「偏好设置」页预留）

四种外观：`button`（实心）/ `card`（白底描边，默认）/ `soft`（主色淡底）/ `underline`（底部主色线）。
全部收在 `tab-item.tsx` 的 `STYLES` 表里，容器侧的差异在 `tab-bar.tsx` 的 `LIST_STYLE`
（下划线风格不能有 gap 与上下留白，否则线断开、压不到底边）。

**新增一种外观 = 三处各加一行**：`TabStyle` 字面量 · `TAB_STYLE_LABELS` 中文名 ·
`STYLES` / `LIST_STYLE` 的样式。标签条本体和设置页都不用改。

偏好统一走 `shell/preferences.ts`（zustand + localStorage，`admin:prefs`）——
**任何设置界面都只用 `usePreferences()` + `patch({...})`，不要另起一套状态**。
界面在「个人中心 → 外观」那一组（`pages/_shared/preferences-panel.tsx` 出面板描述，
外壳是 `_shared/settings-shell`）。
它与 `tab-store` 的分工：tab-store 存「开了哪些 tab」（会话级，sessionStorage），
preferences 存「长什么样」（跨会话，localStorage）。
将来要落库（`sys_frontend_config` 字典类型已经在），只在这一层加一次同步即可。

#### 新设置项该放哪：看它描述**设备**还是**人**

| | 存哪 | 界面在哪 | 为什么 |
|---|---|---|---|
| 主题 / 圆角 / 标签条外观 / 滚动方式 | localStorage（`preferences.ts`） | 个人中心 →「外观」那一组 | 「这块屏幕上我想看到什么」——换台机器重新挑一次很正常，公用机器上更不该带过去 |
| **时区** | **服务端**（`sys_user.timezone`） | 个人中心 →「资料」面板里的一个 Block | 「我人在哪个时区」——换台机器还得再选一次是缺陷，不是特性 |

所以时区**不进** `preferences.ts`，走 `PUT /sys/users/me/timezone`。
交互上仍和其他项一致：选完立刻存，没有保存按钮。

⚠️ **它也不在「外观」那一组下自成一节。** 曾经是（`id: 'region'`），
两个理由撤了：

1. 只有一个控件，单独占一条竖导航项，点进去一眼看完就得退出来
2. 🔴 **新增面板必须同步两处 `section` 白名单**，漏了会静默：
   `pages/profile/index.tsx` 的 `ProfileSection` 联合类型（那里是
   `id as ProfileSection` 强转，**编译不报错**）和
   `apps/web/src/routes/_auth/profile.tsx` 的 `z.enum([...])`。
   当时只加了面板、两处都没加 —— 点那个导航项会往 URL 写一个
   `validateSearch` 不认的 `section=region`

现在它和「注册时间 / 上次登录」在同一个面板里，那两行的渲染本来就依赖这个值，
挨着放能当场看到效果（E2E 实测：切到 UTC 后同一面板里的注册时间偏移 8 小时）。

⚠️ 已知限制：`formatDateTime` 读的是模块级变量、**不是响应式的**，
所以换时区后**其他已经渲染好的标签页**（多页签用 `<Activity>` 保活、
不会重新取数）里的时间要等那一页下次取数才更新。换时区是一年一次的动作，
没为它加订阅式重渲染 —— 真要加的话，加在 `datetime.ts` 里
（照 `onLanguageChange` 的形状做个订阅），不要在每个显示时间的组件里加 hook。

已接好的开关：`showTabs`（整条不渲染，页面照常挂载）、`tabShowIcon`、
`tabMiddleClickClose`、`tabDraggable`，以及外壳级的 `scrollMode`（见「滚动方式」）。

拖拽排序用原生 HTML5 DnD（不引第三方）：`tab-item` 负责 `draggable` 与四个
drag 事件、插入位置用 `inset` 阴影画 2px 竖线（不占布局，整排不会抖）；
`tab-store.reorder(from, to)` **拒绝跨固定/非固定分区**的拖拽 ——
否则 `sortPinned` 会把它弹回原位，表现成「拖了没反应」，不如一开始就不接受。
注意 `onDragStart` 里必须往 `dataTransfer` 写点东西，否则 Firefox 不认这次拖拽。

### `min-width: auto` 是横向溢出的元凶（实测两小时）

现象：tab 开到十几个，最右边的 tab 连同工具区被推出视口、整页出现横向滚动、
侧边栏被挤窄 —— 而滚动按钮**永远不出现**（因为 `scrollWidth === clientWidth`，
「是否溢出」永远判 false）。

链路：flex 项的 `min-width` 默认是 `auto`（= 内容的 min-content），
标签条的 min-content = 所有 tab 宽度之和（实测 11 个 tab = 1539px），
一路顶到 `SidebarInset`，它同样是 `min-width:auto`，于是拒绝收缩到 1244 以下。

**修的地方是 `SidebarInset`**（`ui/components/sidebar.tsx` 已补 `min-w-0`）——
只给内层滚动容器加 `min-w-0` 是没用的：`min-width:0` 只是去掉「自动最小尺寸」这个下限，
不会让父级按内容以外的尺寸算。要收缩的**那一层** flex 项自己必须有 `min-w-0`。

同一个坑还会以别的面目出现：宽表格、图表、`whitespace-nowrap` 的长文本。
新增页面时如果发现整页能左右拖动，先查这条链上有没有漏掉 `min-w-0`。

## 侧边栏：100% 服务端驱动，client-only 节点是特例不是常态

`use-sidebar.ts: useSidebar()` 是**唯一**数据源：`GET /sys/menus/sidebar` →
`toNavTree()` → `NavNode[]`。`AppSidebar`（渲染）和 `command-menu.tsx`（⌘K 的
「页面」组）各自调一次这个 hook，但吃的是同一份 `sidebarQuery` 缓存——这意味着
**新增一个 `sys_menu` 行，两处自动一起更新，不用单独接线**。

🔴 **反过来，不挂 `sys_menu` 的页面 = 侧边栏和 ⌘K 都看不见它，没有例外。**
`/sandbox/*` 那几个页面（组件沙箱等）故意不占用业务权限码（路由文件自己写了
"只要登录就能进，不挂业务权限码"），所以它们从来没有 `sys_menu` 行——
`packages/i18n` 的语言包里其实一直留着 `menu:/sandbox`／`menu:/sandbox/components`
这两条翻译（连 en-US 都有），像是当初设计过要接、后来没接上就晾在那——
组件本身能跑、直接敲 URL 能进，但界面上找不到任何入口，是能反复复现的坑，
不是一次性的疏忽。

**修法是给 `useSidebar()` 本身打一个 client-side 合成节点**（`use-sidebar.ts`
的 `buildDevToolsNode()`），跟服务端菜单树拼在一起返回。这样只用改一个地方，
`AppSidebar` 和 `command-menu.tsx` 都自动拿到，不用分别接线。合成节点是否露出
挂在 `dev-sandbox/api.ts` 的 `readSandboxGate()`（参数配置 DEV 组的开关）上，
跟页面内容自己的显隐判断复用同一份开关，两处不会对不上。

⚠️ **这条`shell → pages/dev-sandbox` 的 import 方向不寻常**（`shell` 一般更
底层，不应该反过来认识某个具体页面），是刻意的例外：没有更通用的「client-only
导航节点」注册机制，专门为一个节点造一套框架投入产出不成比例。**只有「不挂
`sys_menu` 又需要导航入口」这一类页面才走这条路**，业务页面该走
`sys_menu` 就老老实实走，别学它。

⚠️ 合成节点的 `path` 复用现成的 `menu:/sandbox` / `menu:/sandbox/components`
i18n key（而不是随手起新字符串），两个语言的翻译已经现成，不用再补。
父节点（目录，带 children）的 `path` 不需要对应一个真实路由——`NavItem`
里点开目录只是展开子项、不会真的导航，`isValidPath` 校验只发生在
`toNavTree()` 里，合成节点整个绕过了那条校验。

## 服务端推送：一条连接，事件走订阅

`use-presence.ts` 建的那条 socket.io 连接**同时**是所有服务端推送的入口。
它做三件事：上报在线状态、把 `task_notification` 弹成 toast、把其余事件
`dispatchSocketEvent()` 给 `socket-events.ts`，由关心的人自己 `useSocketEvent()` 订阅。

🔴 **不要为了收某个事件再 `io()` 一条连接。** 后端 `connect` 每建立一条连接就往
`fba:token_online` 里记一次 —— 第二条会把「在线用户」页的会话数直接翻倍，
而那个数字看起来仍然像真的。

⚠️ 用 `socket.onAny` 而不是逐个 `.on()`：新增一种服务端事件时 `use-presence.ts`
一行都不用改，也就不会再出现「后端一直在发、前端谁也没接」那种死代码 ——
`task_notification` 就这么当了很久的死代码（后端 `TaskBase` 从一开始就在发）。

⚠️ 订阅口把 handler 存进 ref 再调用，所以调用方**不需要** `useCallback`。
不这么写的话每次渲染都会退订再订阅一遍，而 socket 事件恰恰可能在渲染中途到达，
那一瞬间没有任何订阅者，事件被静默丢掉。

事件本身刻意**不带内容**（后端 `common/socketio/actions.py`）：带上就意味着
socket 这条通道也要做一遍「这个人能不能看这条」的权限判断，而它没有请求上下文、
没有 RBAC 依赖链，做出来一定是第二套、且会和 REST 那套慢慢漂移。
前端收到只做一件事：重新拉数据。

顶栏那枚铃铛在 `pages/notification/`（不在这里），理由见
[notification 分册](../pages/notification/AGENTS.md)。

## 命令面板（⌘/Ctrl+K）与快捷键帮助（?）

| 文件 | 职责 |
|---|---|
| `ui/components/command-palette.tsx` | 展示层：输入框 + 分组列表 + 键盘导航，零业务 |
| `shell/command-menu.tsx` | 业务组装：条目从哪来、选中做什么；顶栏那个 `CommandTrigger` 也在这里 |
| `shell/command-store.ts` | 开合状态（zustand，**不持久化**） |
| `shell/shortcuts-dialog.tsx` | `?` 呼出的快捷键清单（**手工维护**） |
| `shell/hotkeys.ts` | `MOD_LABEL`（mac 显示 ⌘，其余 Ctrl）+ `isEditableTarget()` |

条目的三个数据源**全是现成的**，不新增接口：`tab-store`（已打开的标签页）·
`use-sidebar` 的导航树（页面，和侧边栏同一个 query 缓存）· `use-tab-actions`
（操作，和右键菜单同一套动作）。已经开着的页面**不在「页面」组里重复出现** ——
两行点下去行为完全一样。

四条容易踩的：

- 🔴 **单键快捷键（`?`）必须先过 `isEditableTarget()`。** 不过的话在任意输入框里
  打一个问号就弹帮助面板，而那个字符**还被 `preventDefault()` 吞掉了** ——
  表现是「输入框里打不出问号」，没人会往快捷键上想。带修饰键的组合
  （⌘K / ⌘B）不需要这层判断。回归测试：`e2e/tests/command-palette.spec.ts` 第二条
- 🔴 **`⌘K` 要 `preventDefault()`** —— Firefox 把它占给了搜索栏
- 🔴 **加新快捷键要同时写进 `shortcuts-dialog.tsx`。** 快捷键分散在
  `ui/components/sidebar.tsx`（⌘B）、`command-menu.tsx`（⌘K / ?）、
  `tab-item.tsx`（中键关闭）三处，**没有统一注册表**，那一屏是唯一的清单。
  ⌘B 折叠侧边栏在这个仓库里存在很久，界面上从来没写过它 —— 只有作者知道，
  这就是这一屏（和顶栏那个印着 `⌘K` 的按钮）存在的全部理由
- ⚠️ **面板里不用 `Combobox`**（同是 Base UI 底座）：它是「触发器 + 浮层」的选值控件，
  浮层自己管开合与定位，套进 Dialog 会变成两层焦点管理互相抢。也**不要**为它
  重新引 cmdk —— `command.tsx` 已经连着那条依赖链删掉了（见 [ui 分册](../../../ui/AGENTS.md)）

`Kbd` / `KbdGroup`（`ui/components/kbd.tsx`）终于有调用方了：面板底部提示条、
顶栏按钮上的 `⌘K`、快捷键清单三处。

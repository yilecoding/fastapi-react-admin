# packages/ui —— shadcn 原语，零业务

> 通用组件的约定与坑。**`ui` 永远不 import `platform`**。
>
> 这份文件是根 [`CLAUDE.md`](../../CLAUDE.md) 的**模块分册**，Claude Code 读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律只在根
> `CLAUDE.md` 里有一份；**新增结论请追加到离代码最近的那一份**。


## 这个包的定位：**被下游整包拿走自己改**

不是「发一个 npm 包给人 import」，是 shadcn 那个模型 ——
**组件是下游拥有的代码，不是下游消费的包**。用它的人应该能把
`packages/ui` 拷进自己的项目、按自己的产品直接改，而不是等我们发版、
提 issue 求一个 prop。

拿走这件事怎么做，见 [`PORTING.md`](./PORTING.md)（拷哪些目录、
`globals.css` 怎么接、翻译怎么注入、哪些开关需要外部提供）。

这个定位决定了本包的取舍**和普通组件库不一样**：

| | 消费型库（npm 包） | 本包（拿走就改） |
|---|---|---|
| 组件数量 | 越多越好 | **每个都得有人真的用过** —— 没验证过的代码是给下家的坑 |
| 最重要的是 | API 稳定 | **代码可读、约定一致**（下家要改它） |
| 文档 | 写 props | **目录**（能看见有什么）—— 看不见就会重复造 |
| 内部耦合 | 无所谓 | **隐性耦合是致命的** —— 拿走后静默失效 |

三条落在闸门上，不靠自觉：

- 🔴 **每个组件都要有生产调用方或沙箱 demo**，二者皆无就删。
  闸门是 `pnpm arch:check` 的 `orphan-component`。
  实测过一轮：12,646 行里 2,935 行（≈23%）零调用方，其中包括一个
  **文档在教人别用**的图表组件和一个和 platform 那份重复、但不支持 async pending
  的二次确认框 —— 后者纯粹是个陷阱，下一个人按目录直觉 import 它就中招
- 🔴 **沙箱就是这个库的目录。** `/sandbox/components` 按「基础 / 复杂 / 令牌」
  三层列全部组件，每个带「什么时候用 / 什么时候别用」。下面那张「组件约定」表
  已经搬到界面上了 —— 只有读文档的人看得到的表，等于没有
- 🔴 **第三方死声明也有闸门**（`unused-third-party`）：`date-fns` 就误加过一条，
  源码零引用，它其实是 `react-day-picker` 自己的依赖

## ⚠️ `i18n ← ui` 这条箭头**不走 pnpm 依赖图**，是运行时注入

根 `CLAUDE.md` 有一条硬纪律：「箭头必须体现在 `package.json` 的
`dependencies` 里」。**`i18n ← ui` 是那条纪律的唯一例外，而且是刻意的。**

本包的 15 个组件走 `react-i18next` 的 `useTranslation()`，从 **app 层注入的
context** 里取翻译函数，而那个 i18next 实例是 `@admin/i18n` 建的。
耦合是真的，但**不经过 import** —— 所以 `package.json` 里没有
任何 `@admin/*` 依赖，`tsconfig.json` 的 `paths` 里也只有 `@admin/ui/*`。

为什么不把声明加回去：**ui 对 workspace 零依赖正是它能被拿走的原因。**
加回去只为了让依赖图好看，代价是下家拷走之后 `pnpm install` 找不到
`@admin/i18n` —— 用一个真实的障碍换一条纪律的形式一致。

> 📌 这一节以前写的是反的（「声明了 `@admin/i18n`……不要当成死依赖清掉」）。
> 那条声明在 #90 里就删掉了，而为它辩护的文档留了下来，**在教下一个人别删
> 一个已经不存在的东西**。`pnpm ctx:check` 查不到这种漂移 ——
> 它只校验「指向的东西还在不在」，不校验文字对不对。

**没接翻译实例也不会坏。** `lib/i18n.ts` 的 `useT()` 在没有实例时回落到
「key 原样 + **做插值**」：

| | 有实例 | 裸 `react-i18next` | 本包的兜底 |
|---|---|---|---|
| `t('重试')` | 重试 | 重试 | 重试 |
| `t('共 {{total}} 条', {total: 42})` | 共 42 条 | **`共 {{total}} 条`** | 共 42 条 |

中间那一列就是分页条上真的出现过的样子。**组件里不要直接
`useTranslation()`，一律 `useT()`** —— 直接用就绕过了兜底，
而失效方式是「99% 的文案都对，只有带数字的那几条显示成模板源码」。

## 🔴 `src/components/` 下的 `.ts`（无 JSX 的纯逻辑）要走相对路径 import

**症状**：`pnpm typecheck --force`、`pnpm lint`、`pnpm build` **全绿**，
`pnpm dev` 打开页面白屏，控制台一条
`Failed to resolve import "@admin/ui/components/tree-state"`。

**根因是两套解析规则不同步**：

| 谁在解析 | 规则 | 认不认扩展名 |
|---|---|---|
| `tsc`（typecheck） | `tsconfig.json` 的 `paths`：`@admin/ui/*` → `./src/*` | **不认** —— `.ts` / `.tsx` 都能找到 |
| vite dev（浏览器） | `package.json` 的 `exports`：`./components/*` → `./src/components/*.tsx` | **写死 `.tsx`** |

于是 `tree-state.ts`（`tree.tsx` 拆出来的纯逻辑，没有 JSX 所以是 `.ts`）
在类型层面完全正常，运行时解析不到。**`pnpm build` 也不报** ——
生产构建的解析器和 dev 的 import-analysis 行为不同，实测 build 是绿的。
也就是说三道闸门一道都拦不住，只有真的把页面打开才看得见。

两件事都做了：

- `exports` 补了 `.ts` 兜底：`"./components/*": ["./src/components/*.tsx", "./src/components/*.ts"]`
- **本目录内部一律相对路径**（`from "./tree-state"`），和同文件的 `../lib/i18n` 一致

**新增 `src/components/*.ts` 时照这条办。** 判据很简单：
拆纯逻辑出去是好事（能测），但别顺手用包自引用去 import 它。

## 🔴 「demo 里的代码」也会教错人 —— 它是要被抄走的

沙箱的代码块存在的意义就是「抄走就能用」，所以**写错的 demo 比没有 demo 更糟**。

实测：`Breadcrumb` 的第一版 demo 把 `BreadcrumbSeparator` 套进了
`BreadcrumbItem` 里 —— 两个都渲染成 `<li>`，于是 `<li>` 嵌 `<li>`，
非法 HTML。`typecheck` / `lint` 全绿，界面**看着完全正常**，
只有浏览器控制台里一条 React 19 的
`In HTML, <li> cannot be a descendant of <li>`。
而那段错的结构同时出现在**代码块里**，抄走就带走了。

所以补 demo 之后要**真的在浏览器里打开一遍并看控制台**，
`typecheck` 绿不算数。

## 组件约定

| 场景 | 用法 |
|---|---|
| 带图标的输入框 | `InputGroup` + `InputGroupAddon`，**不要**「相对定位 + 手动 padding」——`px-*` 是 `padding-inline` 简写，会覆盖 `pl-*` |
| Select 显示标签 | 必须传 `items={{value: label}}`，否则关闭态显示原始 value |
| **下拉选哪个** | **按选项数量分**：≤ 8 项（状态/类型/是否）用 `Select`，点开一眼看全，多个输入框是噪音；长列表用 `Combobox`（菜单管理的「上级菜单」28 项、「路由地址」23 项都是它）。过滤走 `Intl.Collator`，中文与大小写都对 |
| **选多个** | `ui/components/multi-select`。关闭态刻意**不铺 chips**（筛选栏一行 32px，铺三个就换行）—— 1 项显示 label、多项显示「label +n」，完整清单靠下拉里的勾选态。下拉底部有「全选 / 清空」 |
| 时间筛选 | `ui/components/datetime-picker` 的 `DateTimeValuePicker` / `DateTimeRangePicker`。值是**本地时间串**不是 `Date`（理由见 [查询区分册](./src/components/query-bar/AGENTS.md)），区间自带快捷区间（今天/昨天/近 7 天/近 30 天/本月/上月） |
| 列表页筛选栏 | `ui/components/query-bar` + `_shared/use-query-search`。**不要**在页面里手拼筛选控件和入参映射，详见 [查询区分册](./src/components/query-bar/AGENTS.md) |
| 命令面板 / 全局搜索 | `ui/components/command-palette.tsx`（Dialog + 受控列表 + 子序列打分，手写）。**不要**为它重新引 cmdk，也**不要**用 `Combobox` 套进 Dialog —— 后者是「触发器 + 浮层」的选值控件，两层焦点管理会互相抢。业务组装在 `platform/shell/command-menu.tsx` |
| 快捷键提示 | `Kbd` / `KbdGroup`。图标按钮的 tooltip 里也能放（`in-data-[slot=tooltip-content]` 的配色已经在基础类里） |
| 可搜索下拉 | 走 `Combobox`（Base UI 底座，和其余组件同源）。**不要引 cmdk** —— 曾经有个零调用方的 cmdk 封装，已删除 |
| 滚动条外观 | 已在 `ui/styles/globals.css` 全站统一（`scrollbar-width: thin` + `--scrollbar-thumb`），**不要逐个容器改**，也**不要再引一个 ScrollArea 组件**（原来那个零调用方、已删）。刻意不用 `::-webkit-scrollbar` —— 它会强制 macOS 退回常驻滚动条 |
| 隐藏滚动条 | 一律 `no-scrollbar`（shadcn 上游的 `@utility`），别手写 `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`。用在**操作区**（标签条、侧边栏），内容区不要藏 |
| 抽屉表单的字段 | `_shared/form-fields.tsx` 的 `FormField`（标签在上/控件/错误），**不是** `ui/components/field` 的 `Field` —— 后者是 `ComponentProps<'div'>`，没有 label/error/required。历史上 5 个表单各写了一份包裹件、3 份字节级相同 |
| 长表单分组 | `_shared/form-fields.tsx` 的 `FormSection`（`▌标题 ────`）。渲染成 `fieldset` + `legend`，读屏会念「联系信息 分组」。**只给字段多的表单用** —— 菜单 12 个、用户 7 个值得，4 个字段的公告加了就是装饰 |
| DropdownMenuLabel | 必须包在 `DropdownMenuGroup` 内，否则 Base UI 抛 `MenuGroupContext is missing` |
| 表格容器 | `overflow-x-auto`，**不要** `overflow-hidden`（会把最右侧操作列裁掉，点不到） |
| 二次确认 | `platform/shell/confirm-dialog`（支持 async + pending），渲染成触发器的兄弟节点，不能放进 `DropdownMenuContent`。**ui 下没有同名组件** —— 原来有一个不支持 async pending 的重复实现，按目录直觉 import 它就中招，已删 |
| 树形多选 | `packages/ui/components/tree`（三态 + 级联 + 过滤）。**角色授权不用它**，见 [pages 分册](../platform/src/pages/AGENTS.md) 的「主从页」 |
| 提示条 / 警告条 | `ui/components/alert` 的 `<Alert tone>`。**不要手写「图标 + 彩色边框盒子」** —— 全仓抄过 28 处、四五种形状（`ring-1` vs `border`、`rounded-md` vs `rounded-lg`、内边距四种）。判据是「会不会自己消失」：Alert 是版面的一部分，`toast()` 不是，取数失败是 `QueryError` |
| 只读键值详情 | `ui/components/descriptions` 的 `<Descriptions layout columns>` + `<DescriptionItem label value mono wrap copy>`。三种布局：`inline`（标签在左）/ `stacked`（值很长）/ `divided`（行多要逐行扫）。5 个 `detail-sheet` 原先各写了一份私有 `Row` |
| 复制按钮 | `ui/components/copy-button`。🔴 它自带 `document.execCommand` 兜底 —— `navigator.clipboard` 只在**安全上下文**（https / localhost）下存在，而局域网 http 访问后台是这类系统最常见的部署形态，那时点了没有任何反应 |
| 分页条 | `ui/components/pagination`，全站唯一一份（`DataTable` 和 `data-grid` 都用它）。`pageIndex` 是 **0 起**的，写 URL 时是 1 起、且「回第一页」写 `page: undefined`。每页下拉的 id 走 `useId()` —— 一屏两个分页条（主从页）时写死 id 会废掉 label↔控件的关联，点标签聚焦到别人的下拉，而且不报错 |
| 状态色 | 只在 `pages/_shared/status.tsx` 定义，用 `<StatusBadge>` / `<StatusPill tone>`；页面里手抄那串 emerald/destructive class 是禁止的 |
| 行选中 | 要么配 `buildSelectColumn` + `BulkBar`，要么 `enableRowSelection: false`（只读列表）；开着却没有复选框列，分页条上的「已选 N 项」永远是 0 |
| 半选复选框 | Base UI 是独立的 `indeterminate` prop，**不是** `checked="indeterminate"` |
| 分页 | 有 `page`/`size` 在 search schema 里，界面上就必须有分页条 —— 否则第 2 页不可达。默认每页走 `_shared/pagination.ts` 的 `DEFAULT_PAGE_SIZE`（宫格用 `DEFAULT_GRID_PAGE_SIZE`），**不要各页写 `search.size ?? 20`** —— 原来那个 `?? 10` 散在 8 处，改默认值必漏一处，而漏了只表现为「某一页跟别人不一样」。默认值刻意**不写进 URL**：写了就分不出「用户显式选了 20」和「没选、恰好是默认」 |
| 「回第一页」 | 写 `page: undefined`，**不是 `page: 1`**。改筛选必须跳回第一页（第 5 页改条件、结果只剩 3 条 → 空页，看着像「什么都没查到」），但写字面量 1 会让 `?page=1` 出现在每个列表页的地址栏 —— 全仓踩了 59 处 + 8 处 `page: i + 1`（从第 2 页点回第 1 页）。见 `_shared/pagination.ts` |
| 列显隐 | 用 `_shared/use-column-visibility`，URL 里存**被隐藏**的列 id（`hide=browser,os`）。默认全显示所以通常为空，加列也不会让老链接错位 |
| 空列表 | `DataTable` 的 `emptyAction` 放「清除筛选」—— 空态最常见的成因就是筛选太窄，别逼用户回工具栏找 |
| **取数失败** | 传 `DataTable` 的 `error` + `onRetry`（错误块横跨表体，还有旧行时改挂横幅），**不要**让它落进 `emptyMessage` —— 失败和空数据是两件事（硬纪律 9）。错误块本身是 `components/query-error.tsx` 的 `QueryError`，全站唯一一份；它认 `ApiError.httpStatus`，403 有专门文案。手写 `<TableBody>` 的表用 `DataTableErrorRow`，插在空态分支**之前** |
| 树形展开状态 | 用 `useTreeFold`：65 个 19 位雪花 id 塞进 URL 不现实，所以粗粒度（全展开/全折叠）进 URL，细粒度靠 `<Activity>` 保会话 |
| 后端已支持的筛选要暴露 | 例：`GET /sys/users` 一直支持 `phone`/`dept`/`role`，页面上却只有用户名 + 状态。加筛选前先看一眼接口签名 |
| 覆盖带变体的基础类 | 必须带**同样的变体前缀**，或改用组件自己的 `size` prop。详见下方「为什么有些覆盖有效、有些无声失效」 |
| Select 的高度 | 工具栏里的 Select 要传 `size="sm"`（32px）。className 里写 `h-8` **无效** —— 基础类是 `data-[size=default]:h-9`，默认 size 就是 `default`。写了也还是 36px，和旁边 32px 的 InputGroup / `Button size="sm"` 差 4px，一整行参差不齐 |
| `overflow-y-auto` 的副作用 | CSS 规定：一个轴是 `visible`、另一个轴不是时，`visible` **计算成 `auto`**。所以只写 `overflow-y-auto` 的容器，横向溢出会自己长出滚动条。抽屉/面板主体一律写成 `overflow-y-auto overflow-x-hidden` |
| flex 行里的 `w-full` | `w-full` = `width:100%`**容器全宽**，旁边还有兄弟元素时必然溢出（图标行溢出正好 = 清除按钮 32px + gap 8px）。要占满剩余空间用 `min-w-0 flex-1`，别用 `w-full` |
| 页面块的水平内边距 | **一律不加**。水平内边距由 `_auth.tsx` 的 `<main className="px-4">` 统一给，页面级块再加 `px-1` 就会比别的块内缩 4px（`PageHeader` 曾经带 `px-1`，「刷新」按钮右边缘 1980 而卡片 1984 —— 肉眼就是「边距怪怪的」） |
| 页面纵向节奏 | 页面级块之间统一 `gap-4 md:gap-6`（24px）。嵌套容器**也要用同一个值** —— 监控页内层只写 `gap-4`，于是「页头→第一块」24px、「块与块」16px，同一页两种间距 |
| 说明文字贴住它解释的东西 | 包一层 `flex flex-col gap-2` 做**结构化分组**，不要给说明加 `-mt-2` 往上拽 —— 负 margin 会变成「说明上方 8px、下方 24px」，同一条缝两个数 |
| 禁用态选择器 | Base UI 的 Checkbox/Select 渲染成 `<span role="checkbox">`，禁用是 `data-disabled` / `aria-disabled`，**不是** HTML 的 `disabled` 属性 —— `:not([disabled])` 选不掉它，要写 `:not([data-disabled])` |
| 批量操作条 | `BulkBar` 的文案可以换（`label` / `icon`），别为「批量下线」这种再抄一个组件 |
| 文件预览 | `ui/components/file-viewer` + `pages/file/preview-dialog`。喂 `buffer`（带鉴权取回的字节）不喂 url；只在 Dialog 里挂，别常驻页面。详见 [file 分册](../platform/src/pages/file/AGENTS.md) |
| 业务对象附件 | `pages/file/attachments` 的 `<FileAttachments targetType targetId />`，别另写一套。`targetType` 走常量 |
| 富文本 | `ui/components/rich-text`。图片能力由 `platform` 注入（`useRichTextImages()`），不传 `images` 就整块关掉。详见 [rich-text 分册](./src/components/rich-text/AGENTS.md) |
| 带鉴权的下载 | 不能用 `<a href download>`（带不上 Authorization 头，会把 401 的 JSON 存成文件）。走 `fetchBytes` → Blob → 临时 `<a>` → `revokeObjectURL` |

### 🔴 tooltip 的锚点不能是 `display:contents` 的包装元素

图标按钮一律要配 tooltip（下面「组件约定」表里那条纪律），但**挂法**会静默失效：

```tsx
<TooltipTrigger render={<span className="contents" />}>{trigger}</TooltipTrigger>  // ❌
<TooltipTrigger render={trigger} />                                                // ✅
```

Base UI 拿 `TooltipTrigger` 渲染出来的那个元素当**定位参照**。`display:contents`
不生成布局盒，`getBoundingClientRect()` 返回全 0，于是 Floating UI 把气泡摆到
视口左上角。实测（`@base-ui/react@1.7.0`，1600×900）：

| 挂法 | 按钮 | 气泡 |
|---|---|---|
| `contents` 包装 | `{x:308,y:308}` | `{x:0,y:4}` ← 左上角 |
| 直接 `render` | `{x:430,y:308}` | `{x:438,y:286}` ← 贴着按钮 |

附带影响：`aria-describedby` / `data-popup-open` 挂在那个无盒 span 上，不在按钮上。

**症状为什么骗人**：tooltip 本身是有的、文案也对、hover 也触发 —— 只是出现在
屏幕另一头，看着像「这个按钮没配 tooltip」而不像「配了但定位错了」。
日志页把导出 / 清空 / 列三个按钮改成 `iconOnly` 时一次踩了四处。

`render` 可以**多层嵌套**，`TooltipTrigger → DropdownMenuTrigger → Button`
三层实测也贴合（`data-table.tsx` 的「列」下拉就是这个形状），
所以不需要为了保住 `DropdownMenuTrigger` 而退回包装元素。

⚠️ **图标按钮不要用 `disabled` 挡重复点击。** `buttonVariants` 基础类带
`disabled:pointer-events-none`，一禁用 hover 就打不开 tooltip —— 而它已经没有
可见文字了，结果是「进行中」这个状态在界面上任何地方都读不到。
改成 `aria-busy` + 回调里的重入守卫（`log-login` / `log-opera` 的导出按钮是这么写的）。

### 🔴 没注册的 TanStack 特性，类型检查看不见 —— 渲染时才炸

`DataTable` 内部把行断言成 `Row<any, any>`（`AnyRow`），那个 `any` 让 TS 认为
**所有特性的方法都在**。但 TanStack v9 是 tree-shaken 的：没在 `tableFeatures({...})`
里注册 `rowSelectionFeature` 的表上**根本没有** `getIsSelected` ——
`pnpm typecheck` 一路绿，页面一渲染整张表白屏，报
`TypeError: row.getIsSelected is not a function`。
消息中心（收件箱没有批量动作，故意不注册行选中）第一次跑就踩到。

`data-table.tsx` 里那一处已经改成 `getIsSelected?.()`。**再往 DataTable 里加
「某个特性才有的方法」时，一律写成可选调用**，否则就是给「只注册了自己要用的
特性」的调用方埋一个类型检查抓不到的雷。

### 🔴 `line-clamp-*` 和 `block` 会互相打架，输的那个只剩「齐字切断」

Tailwind 的 `line-clamp-1` 靠 `display:-webkit-box` 实现。表格单元格里想让
`max-w-*` 生效又要写 `block` —— 两个 `display` 打架，谁后写谁赢。
line-clamp 输掉之后只剩它自带的 `overflow:hidden`：正文被**齐字切断、没有省略号**，
看着像数据坏了而不像截断。

单行截断本来就该用 `truncate`（`overflow:hidden` + `text-overflow:ellipsis` +
`white-space:nowrap`），它和 `block` 不冲突。`line-clamp-*` 只留给**多行**截断，
而且那时不要再写 `block`。

### 为什么有些 className 覆盖有效、有些无声失效

`cn()` = `twMerge(clsx(...))`。**tailwind-merge 只在「同一变体作用域」内消解冲突**：

```js
cn('h-9', 'h-8')                                          // → 'h-8'                 ✅ 覆盖成功
cn('data-[size=default]:h-9 data-[size=sm]:h-8', 'h-8')   // → 三条全留下             ❌
cn('data-[side=right]:sm:max-w-sm', 'sm:max-w-lg')        // → 两条全留下             ❌
cn('data-[side=right]:sm:max-w-sm', 'data-[side=right]:sm:max-w-lg')  // → 只留后者   ✅
```

前缀不同就**不算冲突**，两条都会进 class 属性，然后由 CSS 特异性决定 ——
带属性选择器的基础类 `(0,2,0)` 必胜过纯 utility `(0,1,0)`。

所以：

- `InputGroup className="h-8"` **有效**（基础类是纯 `h-9`，同作用域，被 twMerge 顶掉）
- `SelectTrigger className="h-8"` **无效**（基础类 `data-[size=default]:h-9`）→ 传 `size="sm"`
- `SheetContent className="sm:max-w-lg"` **无效**（基础类 `data-[side=right]:sm:max-w-sm`）
  → 写 `data-[side=right]:sm:max-w-lg`

这个坑在本仓库已经踩到**四次**（抽屉宽度 8 处 · Select 高度 2 处 · 表里那条 ·
查询区移除按钮的外边距）。最后那次的现场值得记一下，因为症状完全不像样式冲突：

> 筛选格里的 `×` 看着没居中。`InputGroupAddon` 的 `inline-end` 基础类里有
> `has-[>button]:-me-1`（-4px，它假设塞进来的按钮自带右内边距），于是
> **左 9px、右 4px**。写 `className="me-0"` 覆盖 —— `marginRight` 实测仍是 `-4px`，
> 因为变体前缀不同就不算冲突。改成 `has-[>button]:me-0` 才生效（右 4px → 8px）。
>
> ⚠️ 顺带一条查法：这一处**垂直方向一直是居中的**（`getBoundingClientRect` 偏移
> 0px），只量一个轴会得出「已经居中了」的错误结论。两个轴都量。
改尺寸前先去 `packages/ui/src/components/<组件>.tsx` 看基础类**有没有变体前缀**：

```bash
grep -oE '(data-\[[^]]+\]|has-\[[^]]+\]):(sm:)?(max-w|min-w|h|w|size)-[^ "]+' \
  packages/ui/src/components/select.tsx
```

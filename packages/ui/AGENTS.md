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

⚠️ **上面那条 `exports` 数组兜底，在 vite dev 下实测不起作用 —— 只有相对路径这一半是有效的。**
2026-11-09 拆 `calendar.tsx` 的纯逻辑时又踩了一次：`from "@admin/ui/components/calendar-nav"`
（`.ts` 文件），typecheck 绿，dev 下请求那个模块直接 500，原文
`Failed to resolve import "@admin/ui/components/calendar-nav" from "../../packages/ui/src/components/calendar.tsx"`。
vite 解析 `exports` 时只取数组里的第一项、不会回退。**别指望兜底，相对路径是唯一的修法。**

⚠️ **拆出来的纯逻辑文件必须叫 `<组件名>-state.ts`**（`tree-state.ts` · `calendar-state.ts`）。
`scripts/gen-ui-registry.mjs` 的 `filesOf()` 只认这个名字，把它归进主组件的 `files`；
叫别的名字时，生成器把相对 import 当成**另一个条目**写进 `registryDependencies`，
而那个条目根本不存在 —— 下游 `shadcn add calendar` 才会炸。
实测：叫 `calendar-nav.ts` 时 `pnpm ui:registry` 生成了 `"registryDependencies": ["button", "calendar-nav", …]`，
改名后变成 `files` 里多一项 `src/components/calendar-state.ts`。

⚠️ **也不要直接引别的组件的 `-state.ts`**：生成器只把**自己名下**的 `-state` 归进 `files`，
别人的照样当成一个条目。实测（2026-11-09）：`datetime-picker.tsx` 写
`from "./time-picker-state"` 时生成了 `"registryDependencies": [… "time-picker", "time-picker-state", …]`，
后一个不存在。修法是让主文件转出（`time-picker.tsx` 里 `export { joinTime, … } from "./time-picker-state"`），
别的组件从 `@admin/ui/components/time-picker` 拿。

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
| 列顺序（#11） | 注册 `columnOrderingFeature` + `_shared/use-column-order`，「列」面板里就多出拖拽手柄（键盘也能拖：空格拿起、方向键挪）。URL 里只存可移动列的顺序（`cols=…`），默认顺序不写。🔴 **`cols` 要进 `useQuerySearch` 的 `keep`**，否则每点一次搜索列顺序就被冲掉 —— 实测：删掉路由 schema 里的 `cols` 列顺序照样保留（叶子路由的 search 合并了根上没校验的那一份），删掉 `keep` 里的才红（`e2e/tests/data-io.spec.ts`） |
| 空列表 | `DataTable` 的 `emptyAction` 放「清除筛选」—— 空态最常见的成因就是筛选太窄，别逼用户回工具栏找 |
| **取数失败** | 传 `DataTable` 的 `error` + `onRetry`（错误块横跨表体，还有旧行时改挂横幅），**不要**让它落进 `emptyMessage` —— 失败和空数据是两件事（硬纪律 9）。错误块本身是 `components/query-error.tsx` 的 `QueryError`，全站唯一一份；它认 `ApiError.httpStatus`，403 有专门文案。手写 `<TableBody>` 的表用 `DataTableErrorRow`，插在空态分支**之前** |
| 树形展开状态 | 用 `useTreeFold`：65 个 19 位雪花 id 塞进 URL 不现实，所以粗粒度（全展开/全折叠）进 URL，细粒度靠 `<Activity>` 保会话 |
| 后端已支持的筛选要暴露 | 例：`GET /sys/users` 一直支持 `phone`/`dept`/`role`，页面上却只有用户名 + 状态。加筛选前先看一眼接口签名 |
| 覆盖带变体的基础类 | 必须带**同样的变体前缀**，或改用组件自己的 `size` prop。详见下方「为什么有些覆盖有效、有些无声失效」 |
| Select 的高度 | 工具栏里的 Select 要传 `size="sm"`（32px）。className 里写 `h-8` **无效** —— 基础类是 `data-[size=default]:h-9`，默认 size 就是 `default`。写了也还是 36px，和旁边 32px 的 InputGroup / `Button size="sm"` 差 4px，一整行参差不齐 |
| `overflow-y-auto` 的副作用 | CSS 规定：一个轴是 `visible`、另一个轴不是时，`visible` **计算成 `auto`**。所以只写 `overflow-y-auto` 的容器，横向溢出会自己长出滚动条。抽屉/面板主体一律写成 `overflow-y-auto overflow-x-hidden` |
| flex 行里的 `w-full` | `w-full` = `width:100%`**容器全宽**，旁边还有兄弟元素时必然溢出（图标行溢出正好 = 清除按钮 32px + gap 8px）。要占满剩余空间用 `min-w-0 flex-1`，别用 `w-full` |
| 页面块的内边距 | **一律不加，四个方向都是**。上下左右 16px 由 `_auth.tsx` 内容列（`data-slot="content-scroll"`）的 `p-4` 一次给齐，页面最外层用 `pages/_shared/page-shell.tsx`（#209，`pnpm arch:check` 守着）。页面级块再加 `px-1` 就会比别的块内缩 4px（`PageHeader` 曾经带 `px-1`，「刷新」按钮右边缘 1980 而卡片 1984 —— 肉眼就是「边距怪怪的」） |
| 卡片网格 | 写 `grid grid-cols-1 gap-3 sm:grid-cols-2 …`，不能只写 `sm:grid-cols-2`：`sm` 以下是隐式 auto 列、宽 = 内容最小宽度，短信配置那串不换行的凭据把卡片撑出 390 宽的屏幕、删除按钮被裁一半（#210）。`grid-cols-1` = `minmax(0,1fr)` |
| 表格横向滚动 | `Table` 的容器带 `scroll-fade-x`（globals.css）：能横向滚时，还有内容的那一侧边缘渐隐。没有它时 390 宽下通知策略 586px 的表在 356px 里其实能滑，但截图审查读成「被裁掉了」（#210）。🔴 用 mask + 滚动驱动动画，**别换回「背景模拟阴影」**：那个要遮罩色等于底色（深色抽屉里是两条暗带）、被选中行的底色盖住、还让大表格失去合成层滚动（#216 评审）|
| 页面纵向节奏 | 页面级块之间统一 `gap-4 md:gap-6`（24px）。嵌套容器**也要用同一个值** —— 监控页内层只写 `gap-4`，于是「页头→第一块」24px、「块与块」16px，同一页两种间距 |
| 说明文字贴住它解释的东西 | 包一层 `flex flex-col gap-2` 做**结构化分组**，不要给说明加 `-mt-2` 往上拽 —— 负 margin 会变成「说明上方 8px、下方 24px」，同一条缝两个数 |
| 禁用态选择器 | Base UI 的 Checkbox/Select 渲染成 `<span role="checkbox">`，禁用是 `data-disabled` / `aria-disabled`，**不是** HTML 的 `disabled` 属性 —— `:not([disabled])` 选不掉它，要写 `:not([data-disabled])` |
| 批量操作条 | `BulkBar` 的文案可以换（`label` / `icon`），别为「批量下线」这种再抄一个组件 |
| 文件预览 | `ui/components/file-viewer` + `pages/file/preview-dialog`。喂 `buffer`（带鉴权取回的字节）不喂 url；只在 Dialog 里挂，别常驻页面。详见 [file 分册](../platform/src/pages/file/AGENTS.md) |
| 业务对象附件 | `pages/file/attachments` 的 `<FileAttachments targetType targetId />`，别另写一套。`targetType` 走常量 |
| 富文本 | `ui/components/rich-text`。图片能力由 `platform` 注入（`useRichTextImages()`），不传 `images` 就整块关掉。详见 [rich-text 分册](./src/components/rich-text/AGENTS.md) |
| 选文件 / 拖拽投放 / 上传浮窗 | `ui/components/uploader/` 的 `useFilePicker`（隐藏 input + `open()`，change 后自动清 `value`）· `Dropzone`（包住任意内容，拖进来盖一层提示；不给 children 就是空态格子）· `UploadTray`（右下角浮窗：标题 / 剩余时间 / 取消全部 / 每行状态环，折叠态只剩标题栏）。它们只认一个 `UploadTrayItem` 形状，不发请求 —— 引擎在 `../platform/src/upload/`，队列和接线在 `../platform/src/shell/upload-store.ts`，页面只调 `pages/file/uploader.ts` |
| 带鉴权的下载 | 不能用 `<a href download>`（带不上 Authorization 头，会把 401 的 JSON 存成文件）。走 `fetchBytes` → Blob → 临时 `<a>` → `revokeObjectURL` |

### 🔴 错误块的原文会落进 `whitespace-nowrap` 的单元格（#210）

**症状**：执行记录 / 消息中心 / 通知公告取数失败时，报错原文一整行横着冲出表格右边，**桌面端看不到「重试」**
（390 宽反而看得到）；仪表盘卡片里则是几十行 SQL 竖着铺开，把卡片撑出屏幕。
**根因**：后端把 SQL / pydantic 报错原样放进 `message`，一条几百字符；`DataTableErrorRow` 把 `QueryError` 放进
`TableCell`，而 shadcn 的 `TableCell` 自带 `whitespace-nowrap`，祖先的这一条一路继承下来。原来「重试」排在最右边，跟着一起被裁。
**修法**（`components/query-error.tsx`）：根上显式 `whitespace-normal` + `overflow-wrap:anywhere`，不信任祖先；
「重试」挪到标题旁边；原文先 `line-clamp-2`，**量出来真的被截了**才给「展开详情」（展开后限高内滚），
换了一条报错自动收回。不按字符数判 —— 宽表里 150 个字符两行放得下，300px 的卡片里 130 个汉字要铺六七行（#212 评审）。
**实测证据**：本地库少一个迁移时截执行记录页，修前报错一行冲出右边界、重试不可见；修后两行 + 重试在标题旁 + 「展开详情」。

### 主按钮的禁用态、深色下的主色（#210）

- 默认变体禁用时**不走基础类的 `opacity-50`**：主色降半透明在浅色下是浅紫底白字、深色下是深靛蓝底暗紫字，
  截图审查里两种都被读成「样式没加载 / 坏了」。现在是 `disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100`
  （同一变体前缀，`twMerge` 能顶掉基础类那条）
- 🔴 **`.dark` 里写的 `--primary` 从来不生效**：主题色偏好（`platform/src/shell/use-apply-preferences.ts`）把 `--primary`
  写在根节点**行内样式**上，压过 `.dark`。于是深色下用的还是 L≈0.46 的深靛蓝，当文字压在 L 0.145 的底上几乎读不出来
  （日志时间列、卡片的「全部 →」、左栏选中项）。再写一条 `.dark { --primary }` 照样被盖掉 ——
  `globals.css` 里改成经一层 `--primary-ink`：亮色 = `--primary`，深色从**当前的** `--primary` 用相对颜色派生
  （亮度抬到 ≥ 0.7，前景换成同色相的深墨色），七种主题色都跟着走；`@supports` 兜住不认的浏览器。⚠️ 条件要写成**实际用到的表达式**
（`oklch(from red max(l, 0.7) calc(c * 0.5) h)`）：早期实现认基本的相对颜色语法、不认通道参与 `max()` / `calc()`，
只测基本语法会判定通过、变量在使用时失效，`bg-primary` 整个变透明（评审指出，未在 Safari 上实测）
- **深色下卡片要有自己的底色**：内容卡片写 `bg-card`，别只画一圈 `border`（#210）。浅色下 `--card` 和 `--background` 都是白，看不出差别；深色下只有边框的卡片和页面融成一片，截图审查读成「卡片和背景分不开」。表格外框不算卡片，保持透明。深色 `--border` 13% / `--input` 20%（原来 10% / 15%，未勾选的复选框几乎看不见）
- **颜色只给异常**：监控数字标琥珀 / 红之前先问「这个值在正常环境里会不会常年触发」—— Redis 的阻塞客户端（Celery 一直挂着 BRPOP）、会话剩余 < 2 小时（有效期本身就是这个量级）原来都常年是橙的，颜色就不再说明任何事。**累计计数器不能拿来标当前状态**：Redis 的 `rejected_connections` 是启动以来的累计，拒过一次就永远 > 0（#217 评审）
- 直接写 `var(--primary)` 的地方（导览的 css、个人中心的横幅）**不经过**这层，深色下还是原色 —— 要跟着提亮就改用 `--primary-ink`

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

### 🔴 日历：react-day-picker 的年份下拉会静默把导航锁到「今年 12 月」（#264）

**症状**：单值日期选择器（公告的「定时发布 / 过期时间」、开放应用的「失效时间」…）
翻到当年 12 月，「下一月」就灰了；年份下拉只有 100 年前到今年；字段里已经存着
明年的值时，打开面板停在今年 12 月，选中的那天看不到。

**根因**：`captionLayout="dropdown"` 且调用方没传 `endMonth` 时，react-day-picker
自己补默认值（`dist/esm/helpers/getNavMonth.js`）：`startMonth = 100 年前 1 月`、
`endMonth = endOfYear(today)`。这对选生日合理，对选到期时间是错的；`label` 模式不加锁，
所以只有用了下拉的那个组件中招，区间选择器没事 —— 更不容易被发现。

**修法**：`calendar.tsx` 去掉了 `captionLayout`（类型上也删了，传了就报错），
年 / 月跳转换成自己画的年面板、月面板，**默认不设上下限**；要限制就显式传
`startMonth` / `endMonth`。导航算术在 `calendar-state.ts`，有单测守着「没有范围时翻到明年永远可以」。
❌ 不要为了「能直接跳年」再把 `captionLayout="dropdown"` 加回来。

**实测**（2026-11-09，`react-day-picker@10.0.1`）：改之前从 2026-11 点一次下一月到 2026-12，
按钮 `aria-disabled="true"`，年份 `<select>` 101 项、`1926`…`2026`；`value="2027-06-15 10:00:00"`
打开面板，标题「12月 2026」、没有选中格。改之后同一个值打开定位到 2027 年 6 月，
年面板 → 选年 → 选月三次点击到达任意月份。

### 🔴 日历：`locale` 不传就是英文，界面是中文也一样（#265）

**症状**：中文界面里日历标题是 `November 2026`、星期是 `Su Mo Tu`、翻页按钮读屏念英文；
用下拉标题时月份反倒是「11月」—— 那是**浏览器**语言，不是界面语言。

**根因**：react-day-picker 不传 `locale` 默认 `enUS`，而原来没有任何调用方传；
下拉的月份是 `toLocaleString(undefined, …)`，退回浏览器语言。两个来源，哪个都不跟界面。

**修法**：`Calendar` 内部用 `useLang()`（`lib/i18n.ts`，和 `useT()` 一样没接实例时回落 `zh-CN`）
映射到 `react-day-picker/locale`，表头和年 / 月面板用 `Intl.DateTimeFormat(locale.code)` 格式化。
**`packages/i18n` 的 `LANGUAGES` 加一种语言时，`calendar.tsx` 的 `LOCALES` 也要加一项**，
否则那种语言回落成英文，不报错。
⚠️ `zhCN` 的一周从**周一**开始（date-fns 的 `weekStartsOn: 1`，Element Plus / antdv 中文版也是），
`enUS` 从周日开始 —— 切语言时星期列会整体挪一格，这是对的。

**实测**（2026-11-09）：中文下表头「2026年 11月」、星期「一 二 三 四 五 六 日」、今天那格读屏
「今天，2026年11月9日 星期一」；`changeLanguage('en-US')` 后不用刷新变成「Mar 2032」·「Su Mo … Sa」。

### 🔴 区间：别用 react-day-picker 算出来的区间，只用它给的 `triggerDate`（#266）

**症状**：区间已经选好 `10-01 ~ 10-10`，再点 `10-20` 得到 `10-01 ~ 10-20`（把原区间拉长了），
而不是从 `10-20` 重新开始；只点了第一下，值就已经是 `11-03 ~ 11-03`，这时关掉浮层，
半截选择就留下来了。

**根因**：这是 react-day-picker `mode="range"` 自己的规则 —— 第一下就给出 `from === to` 的完整区间，
选好之后再点是在原区间上调整端点。Element Plus / antdv 的规则是「两下一组，选好再点就重新开始」。
（它的 `resetOnSelect` 开关这里没用，没实测过它管到哪一步 —— 草稿自己维护之后用不上。）

**修法**：`onSelect` 的第一个参数不要，只取第二个参数 `triggerDate`，自己维护
`{from, to, pending}` 草稿（`datetime-picker-state.ts` 的 `pickRangeDay`，有单测）；
悬停预览用 `onDayMouseEnter` 算一个排好前后的区间塞回 `selected`。值只在两端都有了才提交，
关浮层（点外面 / Esc）丢掉草稿。

**实测**：改之前的两个现象是 #266 里记的（2026-11-09 本地 dev）；改之后
`apps/web/e2e/tests/date-picker.spec.ts` 的「第一下不提交；选好再点是重新开始」那条：
第一下后值仍是 `null`，选好再点 20 之后开始框是 `…-20`、结束框为空，Esc 后值还是原来那段。

### 🔴 「此刻」也属于草稿，确定不能绕过当前输入校验（#266）

**症状**：带时间的日期 / 时间选择器点「此刻」就改了表单值；先敲合法值再敲不存在的日期，
「确定」仍会提交旧草稿；区间结束日期清空后，旧端点还在，仍能提交。
**根因**：「此刻」直接调用提交，按钮只看上一次解析成功的草稿，手输非法 / 空端点时没有清掉对应日期。
**修法**：「此刻」只更新草稿（不带时间的「今天 / 本月 / 今年」仍直接选定），确定和回车都校验
当前文本与禁用时间；区间共用一个草稿转值入口，缺端点 / 非法端点 / 同日反向时间均不能提交。
**实测**（2026-11-12）：新增 E2E 在旧实现上三条失败（日期「此刻」、区间清空、时间「此刻」）；
修复后 `apps/web/e2e/tests/date-picker.spec.ts` 15 条全过，含 `2028-02-30` 禁提交、
`2028/3/5 8:15` 规范化、同日 `18:00 ~ 09:00` 禁提交，改为 `20:00` 后成功。

### ⚠️ 面板里的时间列必须绝对定位，悬停预览不能用 `bg-muted/50`

两条都是做 #266 P2/P3 时在浏览器里看出来的，代码层面都「没错」：

- **时间三列按内容撑开会把浮层顶出视口。** 小时 24 行、分秒各 60 行，放在日历旁边的
  flex 列里（第一版给的是 `flex-1`），实测浮层翻到了页面最上面、时间列的下半截看不到。修法：时间那一栏 `relative`，
  三列 `absolute inset-x-0 top-14 bottom-0`，高度只跟日历走（`datetime-picker.tsx` 单值那段）
- **`--muted` 的亮度是 0.97**，区间中段本来就是 `bg-muted`；预览想「淡一档」写成 `bg-muted/50`，
  实测计算值 `oklab(0.97 0 0 / 0.5)`，在白底上完全看不出来。预览改用 `bg-primary/10`

### 🔴 可以直接敲的触发器（`picker-field.tsx`）：点输入框本身会被当成「点在浮层外面」

**症状**：面板开着时再点一下输入框（比如想把光标挪到年份上改字），面板先关再开，闪一下；
草稿也跟着被重置。

**根因**：输入框不能是 `PopoverTrigger`（那是个按钮，点它是切换开关，没法边敲边看面板），
所以 `PickerField` 不用 Trigger，靠 `PopoverContent` 的 `anchor` 定位到整个输入框上。
没有 Trigger 时，Base UI 只认浮层自己的 DOM 是「里面」，输入框算外面，按下鼠标就发
`onOpenChange(false, {reason: 'outside-press'})`，抬起时 `onClick` 又把它打开。

**修法**：`onOpenChange` 里看 `details.event.target`，落在输入框那个盒子里就不关。
另外两件同源的事：面板打开时焦点要留在输入框里（`initialFocus={false}`，按 ↓ 才进面板），
Tab 离开时自己关面板（焦点从来不在面板里，Base UI 的「焦点离开就关」管不到）。

**实测**（2026-11-09，`@base-ui/react@1.7.0`，真实鼠标点两下输入框，MutationObserver 记面板的
`data-open`）：去掉那行判断时记到「closing → open」两次变化；加回去后零次变化，面板一直开着。

### 浮层里可以再套一个浮层（区间里的时间选择）

带时间的区间面板底部，开始 / 结束时间各是一个 `TimePicker`（它自己也是 Popover）。
Base UI 的嵌套浮层是对的：点里面那层不会被外面那层当成「点外面」，里面那层「确定」后
只关自己。实测（`@base-ui/react@1.7.0`，真实鼠标点击）：点开始时间 → 选 05 时 → 里层「确定」，
里层关闭、外层 `data-open` 还在、开始时间变成 `05:00:00`；E2E 里有同一条用例。

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

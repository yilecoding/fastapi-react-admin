# platform/pages —— 业务页面

> 页面模板三件套、主从页与监控页的滚动骨架。设置屏这一页型拆到了两份更聚焦的
> 分册：骨架本身见 [`_shared` 分册](_shared/AGENTS.md)，参数配置那种具体样板见
> [`config` 分册](config/AGENTS.md)；死链判定见 [`menu` 分册](menu/AGENTS.md)。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

## 页面模板（三件套 + 特性）

新增资源页时照 `packages/platform/src/pages/user/` 抄：

```
pages/xxx/
├─ api.ts             query key 工厂 + queryOptions + mutation（onSuccess 里 invalidate）
├─ columns.tsx        列定义 + 行操作（<Can> 包权限），首列用 buildSelectColumn
├─ form.tsx           react-hook-form + zod + Sheet
├─ index.tsx          服务端分页筛选 + ConfirmDialog + 批量删除
└─ table-features.ts  TanStack Table v9 特性（tree-shaken）
```

工具栏与状态展示**不要在页面里手写**，一律取 `pages/_shared/`：

| 文件 | 提供 |
|---|---|
| `_shared/status.tsx` | `TONE_CLASS` 色板 · `StatusPill` · `StatusBadge`（正常/停用）· `STATUS_FILTER_ITEMS` / `STATUS_FORM_ITEMS` · `YesNoBadge` |
| `_shared/filters.tsx` | `TextFilter`（回车/失焦才写 URL）· `SelectFilter` · `StatusFilter` · `ResetButton` · `BulkBar` · `RefreshButton`（见下「刷新」一节） |
| `_shared/select-column.tsx` | `buildSelectColumn(col, { canSelect })` —— 表格首列的复选框（含半选态） |
| `_shared/log-features.ts` | 除用户页外共用的 `tableFeatures()` |
| `_shared/use-tree-fold.ts` | 树形表格的展开/折叠：URL 只放粗粒度 `fold=all`，逐个节点的展开留组件 state |
| `_shared/monitor.tsx` | 监控页公共件：`MetricCard` · `InfoCard`/`InfoRow` · `UsageBar` · `Sparkline` · `BarList` · `RefreshBar` · `useSamples` · `usageTone`（阈值 75/90）· `MonitorError` · `MonitorSkeleton` |
| `_shared/settings-shell.tsx` | 设置屏骨架：左侧竖导航 + 右侧切换面板（见 [`_shared` 分册](_shared/AGENTS.md)） |
| `_shared/settings-rows.tsx` | `SettingRow`（`inline` / `stacked`）· `SwitchRow` · `SegmentedControl` · `ColorSwatches` |
| `_shared/login-log.ts` | `LoginLog` 类型 + `formatLocation`（内网 IP 后端返 `Reserved`）。两个调用方：登录日志页、个人中心的「最近登录」 |
| `_shared/use-query-search.ts` | `QueryBar` ↔ URL 的胶水：从地址栏恢复条件 · 本地编辑 · 搜索时写回 URL + 拼接口入参 + **跳回第一页**。两个日志页 + 用户管理页在用，见 [查询区分册](../../../ui/src/components/query-bar/AGENTS.md) |

`pages/_shared/list-page.tsx` 是只读列表的工厂，**目前没有调用方**
（两个日志页长出了统计条/导出/详情抽屉后已搬出去手写）。

`DataTable` 自己管加载态：传 `loading`（表体骨架行，工具栏与表头留在原位）和
`busy`（后台取数时整表降透明 + `aria-busy`）。**不要**再在页面里写
「`isPending ? <Skeleton…> : <DataTable/>`」—— 那会让筛选栏在加载完成时凭空出现。

### 🔴 取数状态一律走 `_shared/list-query.ts` 的 `listState()`，别手写那两行

**症状**：`GET /sys/users` 挂了（500 / 网络抖动 / 鉴权过期），页面显示的是
**「暂无数据」**—— 和「筛选条件太窄、真的没查到」一模一样。用户会反复调筛选，
不知道接口挂了。违反硬纪律 9，而且是全站最高频的那批页面。

**根因**是这段样板抄了 12 遍，每一遍都只解构了两个状态位：

```ts
const { data, isPending, isFetching } = useQuery(usersQuery(params))   // ❌ error 没人接
const rows = data?.items ?? []                                        // 失败 → [] → 空态
<DataTable loading={isPending} busy={isFetching && !isPending} />
```

`error` 不解构不会有任何警告，`?? []` 又把失败和空数据抹平成同一个渲染结果 ——
**静默**得很彻底。`DataTable` 当时也确实没有 `error` 这个口子。

**修法**：状态位从 `listState(query)` 一次性摊开，页面只管 rows：

```ts
const listQuery = useQuery(usersQuery(params))
const { data, isFetching } = listQuery          // isFetching 给 QueryBar 的 loading
const list = listState(listQuery)               // loading / busy / error / onRetry
<DataTable {...list} … />                        // ✅ 少写一个就是类型错误
```

- 分页 / 树 / 无限滚动三种查询都能进 `listState` —— 它只认 `isPending` /
  `isFetching` / `error` / `refetch`，`useInfiniteQuery` 的结果也满足
  （有 `isFetchingNextPage` 时自动不算 busy）
- `enabled: false` 的 query 状态一直停在 `pending`，要传 `listState(q, { enabled })`，
  否则骨架屏一直转（字典页没选类型时踩过，那个判断原来手写在页面里）
- **手写 `<TableBody>` 的树形表**（部门 / 菜单）`DataTable` 管不到，要自己插一行
  `DataTableErrorRow`，位置在空态分支**之前** —— 顺序反了就又回到「失败长成空态」
- 判 `tree` 不判过滤后的 `shown`（菜单页）：前端筛没了不是失败
- 已经有上一次成功的行时（`placeholderData` 保着的），错误挂成**横幅**、行留着 ——
  别把用户正在看的数据抽走

错误块本身是 `ui/components/query-error.tsx` 的 `QueryError`（全站唯一一份，
`MonitorError` 只是给它换了套文案）。它认 `ApiError.httpStatus`：403 显示
「没有权限查看这些数据」而不是把后端那句原文糊上去。

**实测证据**：`apps/web/e2e/tests/list-error.spec.ts` 用 `page.route` 把
`/sys/users`、`/sys/depts` 打成 502 —— 修之前两页显示的分别是「暂无数据」和
「没有匹配的部门」；修之后是错误块 + 重试，点重试当场取回数据。
这类问题**只能这样验**：接口正常时对错两种写法看不出任何区别。

⚠️ 卡片式页面（仪表盘）同一个坑换个样子：六个查询各自失败，数字卡全退化成
`—`，「今日登录 —」和「今天真的零次登录」分不出来 —— 也要把 `QueryError` 顶到
页头下面。开关型页面（`dev-sandbox` 读 DEV 组配置）更隐蔽：读配置失败会落进
「沙箱是关闭的」那个分支，理由写着「参数配置里还没有 DEV 组」，而那是**接口挂了**。
硬纪律 9 那句「`off` 只留给服务端明确关闭的情况」说的就是这个。

**页面里不要有可见的大标题。** 页名已经写在 tab 上（`staticData.title`），
`PageHeader` 现在只把 `<h1>` + 描述渲染成 `sr-only`（读屏与 `page-title` testid 都还在），
可见部分只剩动作区，没有动作时整块不渲染。
列表页的主动作（新增 / 导出）放 `DataTable` 的 `actions` 槽 —— 与「列」下拉同一行，
连动作那一行都省掉；树形页放到筛选行右端；主从页放到它归属的那一栏（见字典页的「+」）。

⚠️ **页面同时有 `QueryBar` 时改放查询区的 `actions` 槽**，并给 `DataTable` 传
`showColumnVisibility={false}`（把「列」下拉也搬过去），它那一行就整行消失。
不搬的话是**两条右对齐、左半边全空的按钮行叠在一起**，白占 40px：

```
[登录账号][登录 IP][结果][登录时间][+ 添加条件]
                        [筛选视图][搜索][重置]     ← QueryBar 的
                     [导出 CSV][清空][列]          ← DataTable 的
```

合并后一行装得下，而且不用多点任何一次 —— 这也是为什么**没有**给查询区加
「收起」：条件只有一行时，收起省 40px 却要每次多点一下，而日志页的筛选是高频动作。
条件真的多到铺三四行时由 `collapseAfter`（默认 8）收多余的**格子**，不是收整块。

并进去的那一组**只留图标**（`ClearLogsButton` / `DataTableColumnVisibility` 都有
`iconOnly`，导出按钮页面里直接写）：一行里六个控件，「导出 / 清空 / 列」是次要的
工具动作，留着文字会把主动作（搜索）挤到边上。分工是

| | 形态 |
|---|---|
| 次要工具动作（导出 / 清空 / 列） | 图标 + tooltip |
| 主动作（搜索 / 重置 / 筛选视图） | 带文字 |

### 🔴 「刷新」有三种语义，列表页要暴露的是最轻的那个

| 语义 | 怎么做 | 界面上是谁 |
|---|---|---|
| **重取**：只重新请求，筛选 / 分页 / 展开 / 滚动 / 草稿全留着 | `refetch()` / `invalidateQueries` | 工具行的 `RefreshButton`（`_shared/filters.tsx`），接 `listState().onRetry` |
| **重挂**：组件卸载重建，页面内状态全丢 | tab `revision + 1` **且**让缓存失效 | 标签条 / 右键菜单 / 命令面板的「重新加载当前页」 |
| **整页**：F5 | 浏览器 | —— |

以前列表页**一个都没有**（只有 plugin 页自己写了一个、主从页左栏有、监控页有），
想看最新数据只能去标签条上按那个更重的动作，而它在 30 秒内还是空操作。issue #36。

**摆放位置固定**：主动作（新增 / 导出，带文字的）在前，次要图标工具聚在最右 ——
`… [新增] [刷新] [列]`。刷新**贴着「列」**，两个都是纯图标的一天点不了一次的工具，
分开摆会让人以为它们是两类东西。没有「列」的页面（树形页 / 文件页）就放在那一行最右端
（文件页贴着视图切换那组图标）。

四条实测出来的纪律：

- 🔴 **「搜索」必须是幂等的「照这些条件再查一次」。** `useQuerySearch` 的 `submit`
  只写 URL —— 条件一个字都没改时 URL 不变、queryKey 不变，全局
  `staleTime: 30_000` 让 react-query 直接给缓存：**实测 0 次请求**，连 spinner 都不闪，
  和「刷新过了、数据恰好没变」完全无法区分。所以每个用 `QueryBar` 的页面都要给
  `useQuerySearch` 传 `refreshKey`（这一页列表 query 的 key 前缀，如 `userKeys.all`），
  submit / reset 时会顺手把它失效掉
- 🔴 **刷新要清掉行选中**：`listState(query, { onBeforeRefetch: () => setRowSelection({}) })`。
  重取回来的行可能已经不在了（别人删了），而选中态是按 `getRowId` 存的一组 id ——
  留着它，接下来的批量删除会打到**用户看不见的记录**上。这和「改筛选要清 rowSelection」
  是同一个坑，只是触发方式从「换条件」变成了「点刷新」
- ⚠️ **E2E 定位刷新按钮要按 routeId 收窄**（`[data-tab="/_auth/system/user"] [data-testid="list-refresh"]`）：
  隐藏 tab 的 DOM 也在文档树里，多开一个列表页就有第二个同名 testid，
  strict mode 当场撞两个（硬纪律 5）
- ⚠️ **刷新按钮不要用 `disabled` 挡重复点击。** `buttonVariants` 带
  `disabled:pointer-events-none`，一禁用 hover 就打不开 tooltip，而它是个纯图标按钮 ——
  「进行中」这个状态就没有任何地方读得到了。转圈 + `aria-busy` 表达在途

「最后更新 hh:mm:ss」这一条**还没做**（监控页的 `RefreshBar` 已经有这个口径，
列表页照抄即可）。自动刷新也没做，也不打算全站开 —— 中后台大多是编辑场景，
表格自己跳会打断操作；真要给日志/任务记录开，复用监控页「间隔进 URL、0 = 手动」那套。

### 🔴 时间字段一律过 `formatDateTime`，不许裸渲染

接口下发的是**带偏移的 ISO 8601**（`2026-08-22T11:59:47+08:00`），
`cell: ({ getValue }) => getValue()` 就是把这一串糊进单元格。
一律 `formatDateTime(getValue())`（`@admin/i18n`）。空值不用自己判 ——
它对 `null` 返回 `'—'`，`{getValue() || <span>—</span>}` 那层包装可以删掉。

三个容易漏的地方：

- **CSV 导出那一列**（两个日志页踩过）：导出是另一条代码路径，改了表格忘了导出，
  文件里就是裸 ISO 串
- **排序/比较用 `toEpochMs()`**，不要 `localeCompare`。ISO 串字典序恰好等于
  时间序，所以现在侥幸对 —— 那是巧合，混进别的格式就错
- 🔴 **按天分组不许切字符串**：`.slice(0, 10)` 拿到的是 **UTC 的**年月日，
  东八区早上 8 点前的记录算进前一天。仪表盘登录趋势踩过，柱子少一天多一天，
  不报错不空白，只是数字悄悄不对。用 `dateKey()`

为什么固定格式而不跟 locale，见 [i18n 分册](../../../i18n/AGENTS.md)。

### 🔴 有行选中的页面，`onSearch` / `onReset` 里必须清掉 `rowSelection`

**症状**：在用户管理页勾几行 → 改筛选条件 → 点批量删除 →
**删掉的是当前看不见的用户**。界面上没有任何异常，确认框里的条数还是对的。

**根因**：分页和筛选都在服务端，选中态是按 `getRowId` 存的一组 id。
换了筛选之后这些 id 已经不在返回的行里了，但 `rowSelection` 还留着。

原来这件事是 `patch()` 顺手做的（每个筛选回调都走它）。换成 `QueryBar` 之后
筛选走的是 `q.submit`，**没人再做这件事** —— 得显式包一层：

```tsx
const submitQuery = React.useCallback((v) => { setRowSelection({}); q.submit(v) }, [q])
<QueryBar onSearch={submitQuery} onReset={clearFilters} … />   // clearFilters 里也要清
```

⚠️ **批量条（`BulkBar`）放动作行的左组末尾**，不要放右组。
它随选中行出现/消失，放右组的话每选一次行，「搜索 / 重置」就横向位移一次。
左组是往右长进空白里的，右组不动。

### 迁一个列表页到 `QueryBar`

已迁：`log-login` · `log-opera` · `user`。照用户管理页抄，六步：

1. **声明 `FIELDS`** —— `key` 是**地址栏参数名**，`param` / `rangeParams` 才是接口
   入参名。选项要从接口取的（部门 / 角色）就在组件里 `useMemo`，配 `optionsLoading`
2. `const q = useQuerySearch({ fields, search, onSearchChange, keep: ['hide'] })`
3. 取数入参 `{ page, size, ...q.params }`；`hasFilter` 换成
   `countActive(q.applied, fields) > 0`
4. 🔴 **删掉 `DataTable` 的 `toolbar` / `actions`**，传 `showColumnVisibility={false}`，
   把「新增 / 导出 / 列 / 批量条」搬进 `QueryBar` 的 `actions`（理由见上）
5. 🔴 查询区和表格**包一层** `flex flex-col gap-4 content-scroll:min-h-0
   content-scroll:flex-1` —— 少了 `gap-4` 是 24px 断档（查询区内部才 8px）；
   少了后两个类，「只滚表格行」那条链就断在这一层（表现是「设置生效了，
   但还是整块在滚」）
6. route schema：筛选键换成 `FIELDS` 的 `key`，补 `f`，**不留 `adv`**
   （没开 `advanced` 的话它是个休眠字段）

⚠️ **图标按钮一律 tooltip + `aria-label`**，少了就没人知道那个图标是干什么的。
`清空` 是破坏性动作，敢图标化的前提是后面还有 `ConfirmDialog` 兜着 ——
误点一下只会开确认框。表格自己的工具行还是宽松的，`iconOnly` 默认关，保持带文字。

服务端**没有排序入参**（各 `crud_*.py` 固定 `select_order('id')`），
所以表格一律不注册 `rowSortingFeature`。要做排序得先改后端。

## 主从页（左列表 / 右详情）

角色管理是这一类的样板（`pages/role/`）：左边是**选择器**不是表格，
右边按 Tab 分面板。配一份权限不该是「开抽屉 → 存 → 关抽屉 → 换角色再来一遍」。
另外两个同构：数据权限（`pages/data-permission/`，左范围 / 右规则）、
数据字典（`pages/dict/`，左类型 / 右字典项）。**三个页的滚动骨架必须一致**——
它们长得一样，行为不一样的话就是「同一个东西有三种脾气」。

### 左栏是 `_shared/master-list.tsx`，**唯一实现**

角色 / 数据范围 / 字典类型三个左栏共用它。原先各写一份，于是长出三种脾气：
标题行有的有有的没有、搜索框有的带状态筛选有的不带、底部有的是分页条有的是
「仅加载前 200 个」、列表有的裹在边框里有的没有 —— 同一个东西三种样子。

固定骨架（三页几何完全一致，实测 x=272 w=288，列表区 h=544）：

```
标题 + 刷新 + 新增（addPerm 走 <Can>）   钉住
搜索框（状态筛选收在尾部）               钉住
列表  ← 只有这里滚
共 N 条 · 已加载 n                       钉住
```

- **没有分页条。** 它是**选择器**不是数据表：翻页在 288px 宽的栏里意味着
  「滚到底 → 点下一页 → 再滚回顶部找」。给 `hasMore` / `onLoadMore` 就滚到底自动取下一页
  （角色 / 数据范围），不给就是「就这些了」（字典类型一次取全）
- **`page` / `size` 已从角色页和数据权限页的 search schema 里删掉。**
  加回来就必须同时把分页条加回界面 —— schema 里有 `page` 而界面上没有入口，
  等于第 2 页永远不可达
- **状态筛选收在搜索框尾部**（`_shared/filters.tsx: SearchWithStatus`）：
  没筛时是个漏斗图标，筛了就显示带色的「正常 / 停用」+ 一个清除按钮。
  单独占一行 = 用 40px 的高度换一个三选一，而行里本来就有状态点
- 数据策略由调用方定，组件只认结果。字典类型的搜索是**前端过滤**（能同时命中
  名称和编码、即时生效），角色 / 数据范围是**服务端按名称搜**（它们的量会长，取不全）

两个实测坑：

- **`DropdownMenuRadioItem` 要显式写 `closeOnClick`。** Base UI 的默认是
  `closeOnClick = false`，不写的话选完状态菜单还开着，它的 inert 遮罩会把旁边的
  清除按钮挡住 —— 表现是「点清除没反应」，而 DOM 里那个按钮明明是 visible + enabled
- **`Object.entries(STATUS_FILTER_ITEMS)` 的顺序不是源码顺序。** JS 对象里
  **整数样 key**（`'0'` / `'1'`）永远排在字符串 key（`'all'`）前面，所以
  「全部状态」会掉到最后一项。`filters.tsx` 的 `orderedEntries()` 把 `all` 提前，
  `SelectFilter` 也走它（全站的状态/类型下拉一起修好了）

### 其他约定

- 选中项、当前 Tab、子表页码**全进 URL** —— 主从页的 search schema 比列表页长
- 面板用 `TabsContent keepMounted`：切走再切回来，没保存的草稿还在
- 草稿写成 `draft ?? baseline` 两层。直接 `useEffect` 把服务端数据 setState 进去，
  后台 refetch 一回来就会冲掉用户手上没存的改动
- 有草稿时切主项要 `ConfirmDialog` 拦一下，否则改了半天一点就没

### 主从页的滚动骨架（三种情形，三套行为）

两栏页比列表页多一个维度：**横排还是堆叠**。三条路都要显式给，缺一条就出事：

| 情形 | 行为 | 类 |
|---|---|---|
| `lg` 以下 | 两栏**上下堆叠**，整块滚 | `flex-col lg:flex-row` |
| `lg+` 内容区滚动 | 两栏各自定高，左栏只滚选择器、右栏只滚表格行 | `content-scroll:lg:min-h-0 / flex-1` |
| `lg+` 整页滚动 | 整块跟着页面滚，左栏**吸顶** | `page-scroll:lg:sticky lg:top-4 lg:self-start` |

🔴 **左栏必须有 `flex-col lg:flex-row`。** 左栏是 `w-72` 硬宽 + `shrink-0`，横排时右栏
拿的是剩下的宽度 —— 实测 390px 视口下右栏只剩 **46px**，行的 min-content 是 548，
超出部分被内容区的 `overflow-x-hidden` 直接裁掉：**不是难用，是看不见**。

🔴 **`page-scroll:` 那条不能省，`self-start` 也不能省。** 左栏原来是靠外面包一层
`sticky top-4 self-start` 吸顶的；改成定高骨架时把那层删掉，整页滚动模式下左栏就
跟着滚走了（实测滚 482px 后左栏 top = -485）。补回来时 `self-start` 是必须的 ——
被 `items-stretch` 拉到整行高度的元素本来就够高，`sticky` 对它没有任何效果。

⚠️ **`TabsContent` 上不能无条件写 `flex`。** Base UI 给未选中的面板挂的是 `hidden`
属性，靠 UA 的 `[hidden]{display:none}` 隐藏，而作者样式里的 `.flex` 优先级更高 ——
无条件写会把三个面板**一起显示出来**。要写成
`content-scroll:lg:[&:not([hidden])]:flex`。

三个页的断点都用 **`lg`**（不是 `md`）：`md`（768px）下右栏只剩约 170px，
字典项 / 规则表根本塞不下 —— 断点要按「右栏还够不够用」定，不是按左栏宽度定。

面板内部（`perm-matrix` / `role-scopes` / `role-users` / `rules-panel` / 字典项表）各自再走一遍
「根 `min-h-0 flex-1` → 工具条 `shrink-0` → 表格框变视区」，和列表页同一套
（见 [shell 分册](../shell/AGENTS.md) 的「列表页：只滚表格行」）。工具条原来的 `sticky top-0` **保留**，只在定高情形下
`content-scroll:lg:static` —— 它那时已经在滚动区外面了，留着 sticky 只是白占一个层叠上下文。

同理左栏列表的 `max-h-[calc(100svh-20rem)]` 是**兜底**（堆叠/整页滚动时父级高度是
auto，只能这么算），定高情形下要 `content-scroll:lg:max-h-none` 显式取消 ——
不取消的话 480px 的硬上限会让列表在 900px 高的栏里只用一半，下面空一片还照旧内滚。

权限矩阵（`pages/role/perm-matrix.tsx` + `perm-tree.ts`）不用 `ui/components/tree`：
按钮（`type=2`）不铺成树的叶子行，而是收在所属菜单行右侧的「已授权 n/m」芯片里，
点开**就地展开**成网格（权限码常驻显示，不用 tooltip）。纯逻辑都在 `perm-tree.ts`，不 import React。

> 按钮面板默认收起，所以搜权限码时命中按钮的行必须**自动展开**（`rowsWithMatchingButtons`）——
> 否则「搜到了那一行，但要的按钮还藏着」，等于没搜到。

> 「节点独立」模式勾得出孤儿（子节点授权了、父目录没授权），侧边栏会挂不上去。
> 界面必须提示 —— 后端 `traversal_to_tree` 会把孤儿提到根而不是丢掉，所以它能存能读，
> 只是永远不显示，不提示的话查起来很痛苦。

### 数据权限为什么是一个页而不是两个

`sys_data_scope`（范围）只是一捆 `sys_data_rule`（规则）的名字，**运行时不构成查询边界** ——
`filter_data_permission` 把所有角色、所有范围里的规则拍平成一个 set，
再按每条规则自己的 AND/OR 重组成 `or_( and_(全部 AND), or_(全部 OR) )`。

推论有两个，都必须落在界面上：

- **一条 OR 规则会绕过全局所有 AND 规则。** 范围内混用 AND/OR 要报警
- 规则表虽是 m2m，**实测零复用**。所以主操作是「新建规则」（建完自动挂到当前范围），
  「引用已有规则」是次要入口。原先拆两页时，建了规则忘了挂就留下孤儿规则 —— 库里真出现过一条

表没动，m2m 保留：现在没人复用不代表以后不会，合并 UI 免费且可逆，改表不是。

## 监控页（无历史、只有此刻）

三个监控页照 `pages/monitor-server/` 抄。它们不是列表页：没有分页、没有 CRUD，
公共件全在 `_shared/monitor.tsx`（指标卡 / 键值卡 / 趋势线 / 刷新条），页面里不要重画。

- **刷新间隔进 URL**（`refresh`，秒，0 = 手动）。`refreshMs` **不进 queryKey** ——
  改节奏不该让缓存作废、表格闪空
- 配 `refetchIntervalInBackground: false`。另外隐藏 tab 会被 `<Activity>` 销毁 effect，
  定时器随之停摆 —— 后台挂着 3 个监控 tab 不会同时打后端，这是想要的行为
- **趋势线不用 recharts**：`ResponsiveContainer` 要测容器宽度，而隐藏 tab 是
  `display:none`（宽度 0）。`<Sparkline>` 是固定 viewBox +
  `preserveAspectRatio="none"` 的内联 SVG，纯 CSS 缩放，不测量
- 采样用 `useSamples(value, dataUpdatedAt)`：靠 `dataUpdatedAt` 当 token 而不是 value ——
  值没变也要记点，且 `<Activity>` 切回来时 effect 重跑不会补重复点
- 后端**没有历史存储**（psutil / `INFO` 都是现场采集），所以趋势只是本次会话的采样，
  页面上要写清楚，别让人以为是真的时序数据
- 数据里的 0 要翻译：`max_freq: 0`（WSL2 拿不到主频）显示 `—`，
  `maxmemory_human: '0B'` 显示「未限制」

`/monitors/server` 与 `/monitors/sessions` 是 `DependsSuperUser`，而菜单表里这两条的
`perms` 是**空串** —— 用 `requirePerm()` 检查不到任何东西，等于没设防。
这类路由的守卫要用 `requireSuperUser()`。

在线用户页还有三个坑：

- 🔴 **接口遍历全站所有会话的 token，一个人的过期能炸所有人的请求。**
  `GET /monitors/sessions` 逐个 `jwt_decode()` Redis 里 SCAN 出的每一个 `fba:token:*`，
  过期的 token 解码会抛异常——原来没有 try/except，任意一个**跟当前查看者无关**的
  会话在扫描窗口里到期，整个接口就 401。默认每 10 秒刷新一次、且是唯一会一次性
  解密全站所有会话 token 的接口，所以概率会随在线人数和刷新频率上升。
  现象是「自己的登录明明没过期，这个页面却时不时报 Token 已过期」——因为前端全局
  401 自动刷新用的是**当前用户自己**的 refresh token，刷新会成功，但重放请求撞见的
  还是那把陌生的过期 key，第二次不再重试，后端原始错误文案就直接进了页面的
  `MonitorError` 卡片。修法：`jwt_decode()` 外包 `except errors.TokenError: continue`——
  过期会话本来就不该出现在在线列表里，跳过即可，不该让它拖垮整个请求
- **`id` 是用户 ID，会重复**（同一个人多端登录）。表格 `getRowId` 必须用
  `session_uuid`，用 `id` 会让多行共享同一个选中态
- 排序键用 **`expire_time`** 而不是 `last_login_time`：后者是「用户」的最后登录时间，
  同一个人的多个会话经常一模一样；前者 = 会话创建时间 + 固定 TTL，每个会话都不同
- 接口**不分页**（扫 Redis 的 `fba:token:*` 一次全给），且它的 `username` 入参是
  **全等匹配**。所以筛选/排序/分页全在前端做，但游标照样进 URL。
  这是刻意的取舍不是漏做——在线会话天然有界（≈ 当前活跃用户数 × 多端登录数），
  和会无限增长的日志表不是一类东西，`SCAN` 也没有稳定排序/总数，真做成服务端
  分页反而要先枚举完全部，等于白做。但它**没有任何兜底上限**：本机开发库
  实测跑到过 **211** 条「有效会话」（反复登录测试攒出来的，大部分早就断开、
  只是 token 还没过期），真出现异常登录/token 该过期没过期时，这个数字没有
  任何东西会拦住它涨
- 🔴 **默认值不能直接塞进 `useQuerySearch` 的 `search` 入参，会让 `SelectControl`
  自带的「不限」选项彻底失效。** 「连接」筛选想默认只看在线（`online=1`），
  最初的实现是 `search: { ...search, online: search.online ?? 1 }` 喂给
  `useQuerySearch`——**实测**：切到「不限」点搜索，表格纹丝不动。根因是
  「不限」映射的就是 `undefined`（`query-bar` 的通用约定），而地址栏里
  「用户刚选了不限」和「用户压根没碰过这个筛选」**长得一模一样**（都是没有
  `online` 参数），默认值下一次渲染就把它摁回去了——这是个死循环，「不限」
  这个选项永远选不生效。修法是拿一个 `React.useRef` 记「有没有真的提交过一次
  搜索/重置」：没提交过，`undefined` 按默认值处理；提交过，`undefined` 就是
  用户自己选的「不限」，原样尊重，不再套默认。代价是页面刚加载时选择框视觉上
  显示占位符「请选择」而不是「在线」（数据其实已经按在线过滤了）——这是刻意的
  取舍：要让选择框也显示「在线」得往 `qb.value.basic`（`Condition[]`）里注入
  一条假条件，牵扯 `query-bar` 内部的 id/运算符生成，投入产出不成比例，
  没做。任何页面想给 `QueryBar` 的字段挂"默认值"，都要先想清楚这条

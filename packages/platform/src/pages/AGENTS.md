# platform/pages —— 业务页面

> 页面模板三件套、四种页型（列表 / 设置屏 / 主从页 / 监控页）以及它们的滚动骨架。
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
| `_shared/filters.tsx` | `TextFilter`（回车/失焦才写 URL）· `SelectFilter` · `StatusFilter` · `ResetButton` · `BulkBar` |
| `_shared/select-column.tsx` | `buildSelectColumn(col, { canSelect })` —— 表格首列的复选框（含半选态） |
| `_shared/log-features.ts` | 除用户页外共用的 `tableFeatures()` |
| `_shared/use-tree-fold.ts` | 树形表格的展开/折叠：URL 只放粗粒度 `fold=all`，逐个节点的展开留组件 state |
| `_shared/monitor.tsx` | 监控页公共件：`MetricCard` · `InfoCard`/`InfoRow` · `UsageBar` · `Sparkline` · `BarList` · `RefreshBar` · `useSamples` · `usageTone`（阈值 75/90）· `MonitorError` · `MonitorSkeleton` |
| `_shared/settings-shell.tsx` | 设置屏骨架：左侧竖导航 + 右侧切换面板（见「设置屏骨架」） |
| `_shared/settings-rows.tsx` | `SettingRow`（`inline` / `stacked`）· `SwitchRow` · `SegmentedControl` · `ColorSwatches` |
| `_shared/login-log.ts` | `LoginLog` 类型 + `formatLocation`（内网 IP 后端返 `Reserved`）。两个调用方：登录日志页、个人中心的「最近登录」 |
| `_shared/use-query-search.ts` | `QueryBar` ↔ URL 的胶水：从地址栏恢复条件 · 本地编辑 · 搜索时写回 URL + 拼接口入参 + **跳回第一页**。两个日志页在用，见 [查询区分册](../../../ui/src/components/query-bar/AGENTS.md) |

`pages/_shared/list-page.tsx` 是只读列表的工厂，**目前没有调用方**
（两个日志页长出了统计条/导出/详情抽屉后已搬出去手写）。

`DataTable` 自己管加载态：传 `loading`（表体骨架行，工具栏与表头留在原位）和
`busy`（后台取数时整表降透明 + `aria-busy`）。**不要**再在页面里写
「`isPending ? <Skeleton…> : <DataTable/>`」—— 那会让筛选栏在加载完成时凭空出现。

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

⚠️ **图标按钮一律 tooltip + `aria-label`**，少了就没人知道那个图标是干什么的。
`清空` 是破坏性动作，敢图标化的前提是后面还有 `ConfirmDialog` 兜着 ——
误点一下只会开确认框。表格自己的工具行还是宽松的，`iconOnly` 默认关，保持带文字。

服务端**没有排序入参**（各 `crud_*.py` 固定 `select_order('id')`），
所以表格一律不注册 `rowSortingFeature`。要做排序得先改后端。

## 设置屏骨架（`_shared/settings-shell.tsx`）

「左侧一条竖导航 + 右侧切换面板」，个人中心用它，系统设置那类页面也能直接用。
调用方给 `panels`（`{id, label, group, content}`）+ 受控的 `value` / `onChange`。

它取代了原来的 `settings-layout.tsx`（左侧锚点 + 右侧长滚动）。**三条换掉的理由**，
新写设置屏时别再走回去：

1. **一层导航。** 个人中心原来是「顶部页签 + 页签内左栏」两层管 8 个小节 ——
   想调标签页外观得先点「偏好设置」再点「多标签页」。GitHub / Linear / Zapier
   的账号设置都是一条竖导航到底
2. **当前面板进得了 URL。** 锚点式的「当前小节」是滚动位置的副产品，
   每滚一下改一次 URL 不可接受，于是只能留在组件 state 里 —— 刷新就丢，
   违反硬纪律 2。切换式的 `value` 就是个普通受控值（个人中心走 `search.section`）
3. **不用自己造滚动容器。** 锚点式要求右栏自己滚（`IntersectionObserver` 的 root
   指向它），而右栏高度只能写 `calc(100dvh-14rem)` —— 这个 14rem 和顶栏 + 标签条
   高度硬耦合，关掉多标签页时底部多出约 2rem 空白。切换式让页面按自然高度滚，
   这条耦合整根拿掉了

### 视觉：不套卡片框，靠图标和形状撑起来

- **面板不套 `<Card>`。** 页面底色和 `bg-card` 都是近白，一层
  `ring-1 ring-foreground/10` + `shadow-xs` 只是画了一道没有信息量的边 ——
  内容列已封顶 40rem、左边还有条导航，「这一块到哪为止」本来就看得出来。
  块与块的分隔交给一根 `border-b`
- **左栏每项必给 `icon`。** 一条纯文字竖导航要靠读字定位；选中态用
  **主色淡底 + 主色文字**（`bg-primary/10 text-primary`）而不是灰底 ——
  灰底选中项和 hover 态几乎分不出来，6 项里得盯着看才知道自己在哪
- **块标题的图标装进淡底方块**（`size-7 rounded-md bg-primary/10`）。
  裸图标和标题同色同重会糊成一团；有底之后它是「块的徽标」，一眼看出分了几块
- **块内容要缩进到和标题文字对齐**（图标 28px + gap 10px = `ps-[2.375rem]`）。
  不缩进的话标题比它下面的输入框右移 38px，一屏扫下来每块都有一处错位的左边缘。
  窄屏（`< sm`）不缩进 —— 那时这 38px 是实打实的可用宽度
- **抽象的值要用真实组件预览，不要塞小图标。** 圆角那一档试过给每个选项配一个
  「真实圆角」小方块 —— 14px 的方块上，10px 圆角就已经接近全圆，14px 和 20px
  两档长得一模一样（半径 ≥ 边长一半时视觉到顶），既分不出高档位，那几笔细描边
  挤在文字左边还很脏。改成下面摆**真的** `Button` / `Input` / 卡片：`--radius`
  本来就是它们的圆角来源，看到的就是改完之后界面真正的样子。
  身份区用主色渐变 + CSS 点阵横幅（`radial-gradient` 平铺，不新增静态资源、
  跟着 `--primary` 走）

> ⚠️ 参考实现里的「布局模式（经典侧栏/嵌入式/浮动式）」和「界面密度」有很漂亮的
> 缩略图选择器，**不要照抄** —— 这两项在本仓库没有支撑（要侧边栏变体和密度令牌），
> 摆上去就是点不动的装饰。要好看得从**已经接通**的项里找（圆角、主题色、标签页外观）。

### 头像上传（`profile/api.ts: useUploadAvatar`）

走 `POST /sys/files/upload?public=true` 拿无鉴权直链，再 `PUT /sys/users/me/avatar`。

- **必须 `public=true`**：头像最终进 `<img src>`，而私有文件的 `download_url`
  要 Authorization 头 —— 塞进 `<img>` 只有 401 和一张裂图
- **和 `pages/file` 的 `useUploadFile` 分开命名是刻意的**（同 `uploadInlineImage`）：
  把 `public` 做成通用上传的可选参数，就只剩「谁记得别传 true」一道纪律在守
- 🔴 **存的是绝对地址，里面带 API 主机名。** 后端 `avatar` 是 `HttpUrl` 只收完整地址，
  而 `public_url` 是相对路径（`/uploads/2026/08/22/x.png`）—— 相对路径交给浏览器
  会按**前端** origin 解析（:1125）拿到 404。所以只能拼 `API_BASE`，代价是库里存下
  `http://127.0.0.1:8000/uploads/…`，**换 API 主机名时这些行全部失效**。
  根治要把后端字段改成 `str` + 存相对路径 + 渲染处再拼，那要动接口契约和所有
  渲染头像的地方，**还没做**

### 两个不能省的点

- **内容区刻意不封顶 —— 这是个权衡，不是漏了。** 内容左右铺满可用宽度，
  `SettingRow` 的文字列撑满、控件顶到最右。代价实测过：1600px 视口下开关行
  「标签文字 → 开关」926~954px，1920px 下超过 1200px。
  曾经封顶 40rem 把它压到 448~476px（Primer 把 GitHub 整页封在 1280px 同理），
  但封顶后 1920px 右侧空 808px、2560px 空 1448px，看起来像「右边没排满」。
  **两害取其轻是产品选择，选了铺满。** 要改回封顶只是一行，
  `settings-shell.tsx` 顶部注释写着怎么改 —— 但那是产品决定，不要顺手改掉
- **所有面板同时挂载，用 `<Activity>` 控显隐**，不是「只渲染当前那个」。
  只渲染当前面板的话，切走再切回来，昵称/邮箱/密码里没提交的草稿全丢
  （原来靠的是 `<TabsContent keepMounted>`，换外壳不能把这个能力弄丢）。
  `<Activity mode="hidden">` 保 state、销毁 effect，所以隐藏面板里的 `useQuery`
  不会在后台轮询。⚠️ 隐藏面板的 DOM 仍在文档树里 —— 要锁某个面板按
  **`[data-panel="<id>"]`**，别用 `[data-active="true"]`（切换瞬间会撞两个）

### `SettingRow`：控件放哪一侧按**宽度**决定

| 控件 | 位置 | 理由 |
|---|---|---|
| 开关、单个按钮 | 同行右侧（`layout="inline"`） | 本身窄，右对齐让一列开关纵向对齐，好扫 |
| 分段选择、色板、输入框 | **标签下方**（`stacked`，默认） | 这些宽 200~430px，挤右边就是上面那个 845px |

**不要给设置行加「当前值提示」。** 第一版每行右侧都有个 `hint`（主题模式旁写「浅色」、
圆角旁写「柔和」），而分段控件里选中那一格**已经**显示着同一个词 —— 同一个值一行出现
两次，其中一次还离控件 56px 远，读起来像两个不同的东西。

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

在线用户页还有两个坑：

- **`id` 是用户 ID，会重复**（同一个人多端登录）。表格 `getRowId` 必须用
  `session_uuid`，用 `id` 会让多行共享同一个选中态
- 排序键用 **`expire_time`** 而不是 `last_login_time`：后者是「用户」的最后登录时间，
  同一个人的多个会话经常一模一样；前者 = 会话创建时间 + 固定 TTL，每个会话都不同
- 接口**不分页**（扫 Redis 的 `fba:token:*` 一次全给），且它的 `username` 入参是
  **全等匹配**。所以筛选/排序/分页全在前端做，但游标照样进 URL

## 设置屏（左右结构 · 参数配置那种）

`pages/config/` 是这一类的样板。**不要用 `DataTable` 做设置页** ——
表格是给多行**同构**数据用的，而设置项是一堆异构单值。第一版用了表格，结果是
「分组」列在分组页签里重复 17 遍、「来源」列 17 行全一样、最该读的那句说明
（「0 表示禁用锁定」）被截断在最右侧，而且排序退化成键名字母序把相关项打散了
（`有效期` 和 `到期提醒` 中间隔着 `历史检查次数`/`最大长度`/`最小长度`）。

结构：

```
顶部粘性栏：搜索 · 未保存计数 · 新增键 · 放弃 · 保存
左栏 registry.RAIL 分类  │  右侧按小节分段，每段一行行「标签 + 控件」
```

### 元数据注册表是前提（`registry.ts`）

后端 `sys_config` 只有 `name/type/key/value/is_frontend/remark` 六个字段，
**没有控件类型、没有小节、没有顺序、没有取值范围、没有依赖关系**。
想做成设计过的设置屏，这些只能在前端补：

- `section` / `order` 必须显式给 —— 否则小节顺序跟着 `sys_config` 的行顺序走
  （接口按 id 排 = 种子插入顺序），换一批种子数据顺序就变了
- `label` 覆盖库里的 `name`：三条总开关的 name 都叫「状态」，显示「状态」等于没说
- **注册表只是增强**：命中不了的键回落类型推断并落进「未纳管的键」小节，
  后端加一个键永远不会把页面弄坏
- 左栏分类走 `RAIL` 常量，**不要**从 `type` 直接生成 —— 那样只会得到四个平铺的英文枚举值
- 默认落在**条目最多**的分类，不是左栏第一项（第一项只有 1 条，一进来像没加载出来）

### 🔴 校验不是锦上添花

后端 converter 是裸 `int`，而 `load_user_security_config` 挂在**登录和改密码路径**上。
把某个数字框清空存下去（number 输入框按退格就到），下一次登录就是
`500 invalid literal for int() with base 10: ''` —— 全站登不进来，包括改坏它的人自己。
**实测确认过。** 已经两头都堵：

- 写入侧：`registry.ts` 的 `validateOne` / `validateCross`，有错就禁用保存按钮
- 读取侧：`utils/dynamic_config.py` 的 converter 包了 try/except，
  单条脏数据退化成「这个键回落 .env + 一条 error 日志」，不再拖垮整个请求

两类错误的规则**不一样**，别写成一个 map：

- 单项错只对**动过的**键报，否则库里既有的脏数据一进页面就满屏红
- 跨字段错（`最小长度 99 > 最大长度 32`）**始终**报，而且要报在**双方**行上 ——
  只改了「最小长度」时冲突的另一半在「最大长度」那行，不标出来人找不到
- 合并时**单项错优先**：填 999 该先说「不能大于 128」，而不是「不能大于最大长度（32）」
- 拦保存只算「动过的键上的错」，库里既有的冲突提示但不挡着人存别的改动

### 其他约定

- 草稿写成 `draft[id] ?? item.value` **两层**，不要 `useEffect` 把服务端数据
  setState 进草稿 —— 后台 refetch 一回来就冲掉用户没存的改动
- 草稿**跨分类保留**，左栏对应项打琥珀点；顶栏计数按全量算
- 组总开关提到**分类头**上，关掉时整块降透明 + 横幅说明「后端整组不加载，回落 .env」，
  左栏那一项也打个「不生效」图标 —— 这是最容易踩的坑：改了一整组但那组开关是关的
- 依赖联动写在 `disabledBy`：阈值为 0 时锁定时长置灰并说明原因
- 小节头右侧回显**组合效果**的人话摘要（「连续错 5 次 → 锁定 5 分钟」），
  而不是单个值 —— 单个值输入框里就写着了
- 键定义的增删改是**副入口**，收进行内 kebab（悬停/聚焦才显形）+ 顶栏「新增键」
- danger 标记只用在**保存确认框**里逐条列出旧值 → 新值。
  不要在行上打静态警告三角：安全组里 8 行有 6 行是 danger，满屏三角等于没标
- 打码判断要用**后缀**匹配（`/(PASSWORD|SECRET|TOKEN|API_?KEY)$/`），
  不能 `includes('PASSWORD')` —— `USER_PASSWORD_MIN_LENGTH` 是口令**策略**不是口令，
  被当密码会变成一排小圆点，确认框里还显示「（已隐藏）」，人不知道自己改成了几
- `value` 在库里一律是字符串，**写回必须保持原字面量**：`'true'/'false'`
  （后端 `str_to_bool` 认这个）和 `'1'/'0'`（组总开关用这个）不能混
- 设置屏**不分页**，所以 route schema 里也不能留 `page`/`size`

> 参数配置不是「随便存点键值对」：后端 `utils/dynamic_config.py` 会在登录、
> 验证码、改密码这些路径上把 `sys_config` 的值 `setattr` 到 `settings` 上，
> **覆盖 `.env`**。改 `LOGIN_CAPTCHA_ENABLED` 就是真的关掉登录验证码。

接口有一个坑：前缀是 `/api/v1/sys/configs`（插件 `extend = "admin"`，
落在 admin 的 sys 下），**不是** plugin.toml 里写的 `/configs`。

> 批量更新 `PUT /sys/configs` 的权限码曾经写成 `sys.config.edits`（点号+复数，
> 菜单种子里没这一条，对所有非超管角色恒 403）——**已修复**，改成复用
> `sys:config:edit`（`config.py:69`）。前端**仍然**走并发的单条 `PUT /{pk}`，
> 不是因为权限绕不过去了，是批量接口整批一次校验（一行冲突整批回滚），
> 而这里要的是逐行独立的失败反馈（`useSaveConfigs` 的 `allSettled`），
> 两种失败语义不同，见 `pages/config/api.ts` 里的注释。

### 🔴 开发库会攒下没接线的 `sys_config` 垫子，还可能带真实数据（实测踩过）

这一页的界面文案（左栏分类、`RAIL`、小节标题）全部来自前端 `registry.ts`，
**和数据库里实际存在的行是两件事**——`sys_config.type` 可以是任意字符串，
没有外键约束，谁都能往里插一条 `registry.ts` 完全不认识的 `type`/`key`。
探索这个功能时手动往开发库塞过一批占位数据（`auth_*` / `biz_*` / `file_*` /
`log_*` / `notify_*` / `site_*` / `ui_*`，27 条），**没有一条被任何代码引用**
（`registry.ts` 不认、`RAIL` 没这个分类、前后端 grep 零命中），全部落进
「未纳管的键」或者压根不显示在任何分类里，界面上看着就是一堆莫名其妙的键值对。

更要命的是：这批占位数据里混进了**看起来像真实业务信息**的值
（公司名、域名、ICP 备案号那种格式），虽然只在本机开发库、从没进 git 仓库，
但如果这个库被导出、截图、或连去某个共享的演示环境，就会把不该出现的东西
带出去。**探索/占位数据要么立刻接进 `registry.ts`，要么用完就删，
不要让它们在开发库里长期躺着** —— 判断"这条是不是真的"，就看
`registry.ts` 认不认、前端代码 grep 不 grep 得到，两个都没有就是垫子，删。

`DEV_CONFIG_STATUS` / `DEV_SANDBOX_ENABLED` 属于另一种情况：**确实接了线**
（`dev-sandbox/api.ts` 在读），但种子 SQL 一直没带这两条——五个数据库变体的
`plugin/config/sql/*/init*.sql` 都补上了，跟开发库里已经手插的值对齐
（沿用同一批雪花 ID，重新 `fba init` 不会产生第二条）。

## 死链判定（菜单管理）

`pages/menu/dead-link.ts` 是**唯一实现** —— 计数徽标、行内删除线、「只看死链」筛选、
编辑表单的提示全用它。判定口径是「**这一条会不会从侧边栏消失**」，
所以规则必须跟 `shell/use-sidebar.ts: toNavTree` 一致，**改一边就要改另一边**。

| 类型 | 规则 |
|---|---|
| 按钮 | 本来就不进侧边栏（只提供 perms） → 从不算死链 |
| 外链 / 内嵌 | 走 `link` 字段，不是前端路由 → 从不算死链 |
| **目录** | **有可见子项时它只是个可展开分组，自己的 `path` 根本不会被用到 → 不算死链**；子项全都进不了侧边栏时才降级成链接，那时才要求 path 有效 |
| 菜单 | 需要自己的 path 有效 |

「有可见子项」必须**递归**算，且与 `toNavTree` 同口径：按钮不算、`display=0` 不算、
自己也是死链的不算。`/scheduler` 就是靠这条判成真死链的 —— 它两个子项自己都是死链。

> 曾经把目录和菜单一视同仁（`Boolean(path) && !isValidPath(path)`），
> 于是 `/system` `/log` `/monitor` 三个工作得好好的目录被划了删除线、
> tooltip 写着「侧边栏会跳过」，而侧边栏一直正常显示它们 ——
> 59 项里的「8 个死链」有 3 个是假的（修完是 5 个）。
> **种子数据里目录的 path 前端本来就没有对应路由，那是设计如此：目录不该可导航。**

树形筛选会**连着祖先链一起保留**（否则树断成孤立行），所以「只看死链」的行数
会比徽标数多 —— 写断言时对账的是「被标死链的行数」，不是总行数。

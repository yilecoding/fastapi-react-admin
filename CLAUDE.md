# CLAUDE.md

**fastapi-react-admin** —— 中后台底座。产品标识集中在 `apps/web/src/lib/brand.ts`
（改名字、改版本只动那一处）。

后端 fork 自 fastapi-best-architecture 并适配 SQL Server，
前端基于 React 19 + TanStack Router/Query/Table v9 + shadcn（Base UI 底座）。

架构的承重方式是榫卯：`i18n ← ui ← platform ← web` 严格单向，每层只暴露形状
（组件 / 契约 / 页面），不靠胶水互相粘。登录页那枚咬合标记（`TenonMark`）
表示的就是这个，不是项目名。

**这份文档是踩坑记录与硬纪律的唯一一份。** 全是实测出来的结论，
不是风格偏好 —— 违反了会坏，而且多数是**静默**地坏。

## 按任务导航

1895 行不用读完。按你要改什么，只读对应几节：

| 我要… | 先读 |
|---|---|
| **第一次上手** | 「结构」·「本地起服务」·「硬纪律」（这三节是必读） |
| 加一个列表页 / CRUD 页 | 「页面模板（三件套 + 特性）」·「组件约定」 |
| 动查询区 / 筛选条件 | 「查询区（QueryBar）」+ 硬纪律 2 |
| 加一个设置类页面 | 「设置屏（左右结构）」·「设置屏骨架」 |
| 加一个主从页（左列表右详情） | 「主从页」 |
| 动多页签 / 标签条 | 「多页签标签条」+ 硬纪律 1 / 4 / 5 |
| 动菜单、权限、死链判定 | 「死链判定」+ 硬纪律 6 |
| 动文件上传 / 预览 / 附件 | 「文件管理与附件预览」·「富文本里的图片」 |
| 加文案 / 动多语言 | 「国际化」（**两个校验脚本都要跑**） |
| 动后端模型、接口、SQL | 「后端约定」·「还没发版 —— 可以自由重构」·「已经删掉的东西」 |
| 动部门 / 角色的编码 | 「部门与角色的编码」+ 后端约定里的 `fba:user:*` 那条 |
| 写或跑测试 | 「跑测试」 |
| 动监控页 | 「监控页（无历史、只有此刻）」 |
| 改主题 / 偏好 | 「偏好设置」 |
| 动 URL 参数 / 分页 | 「查询区」的「URL 参数 ≠ 接口入参」+ 硬纪律 2 |
| cherry-pick 上游补丁 | 「fork 管理」 |

> 面向使用者的说明在 [README.md](./README.md)，参与贡献看
> [CONTRIBUTING.md](./CONTRIBUTING.md)，安全问题看 [SECURITY.md](./SECURITY.md)。

## 结构

```
apps/api/          FBA fork（Python，uv 管理）
apps/web/          业务应用；routes/ 只声明 schema/守卫，不渲染页面
packages/i18n/     多语言包：语言文件 · i18next 实例 · 校验脚本（最底层）
packages/ui/       shadcn 原语，零业务
packages/platform/ 平台能力：api-client · auth · shell · pages
```

依赖方向单向：**`i18n` ← `ui` ← `platform` ← `apps/web`**。
**`ui` 永远不 import `platform`；`i18n` 不 import 任何 workspace 包**（连
`react-i18next` 都不依赖 —— 它要保持框架无关，React 绑定在 app 层注入）。

## 本地起服务

```bash
docker start fba_mssql fba_redis          # SQL Server :1433 / Redis :6380
pnpm dev                                  # 前后端一起：api :8000 · web :1125
```

`apps/api` 是 pnpm workspace 成员（`package.json` 里只有一个 `dev` 脚本、零 JS 依赖），
所以 `turbo dev` 会同时起两个进程，TUI 里各一个日志窗格。单起某一边：

```bash
pnpm --filter api dev                     # 等价于 cd apps/api && uv run python -m uvicorn ...
pnpm --filter web dev
```

⚠️ 前端端口固定在 **1125**（`vite.config.ts` 的 `server.port` + `strictPort: true`）。
**换端口要同时改三处**，只改一处的失败方式都不长得像端口问题：

| 改哪里 | 漏了的表现 |
|---|---|
| `apps/web/vite.config.ts` | —— |
| `backend/core/conf.py: CORS_ALLOWED_ORIGINS` | 页面能开，但**所有接口 CORS 失败** |
| `backend/plugin/oauth2/plugin.toml` 的两条 `OAUTH2_FRONTEND_*_REDIRECT_URI` | 第三方授权成功后**回跳到空端口** |

`strictPort: true` 是刻意的：不写它 Vite 会在端口被占时自己 +1 漂到 1126，
而上面两处白名单是写死的 —— 宁可起不来，也不要「起来了但接口全挂」。

账号 `admin` / `123456`。登录要过验证码，验证码答案在 Redis：
`docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"`。

后端契约改动后跑 `cd packages/platform && pnpm gen:api` 重新生成 `schema.d.ts`。

---

## 硬纪律（违反会坏，不是风格问题）

### 1. 平台页面组件必须 router-独立

`params` / `search` **只能走 props**，页面内部不得调用
`Route.useSearch()` / `Route.useParams()` / `useNavigate()`。

> 原因：多页签用 `<Activity>` 同时挂载所有已打开的 tab，
> 但 router 只有一个 location 是「匹配」的 —— 隐藏 tab 拿不到 match 上下文。
> 需要改 search 时用 `TabOutlet` 注入的 `onSearchChange`。

```tsx
// ✅ packages/platform/src/pages/xxx/index.tsx
export function XxxPage({ search = {}, onSearchChange }: {
  search?: XxxSearch
  onSearchChange?: (n: XxxSearch) => void
}) { … }

// ❌ 页面内部读路由
const search = Route.useSearch()
```

### 2. 视图状态必须进 URL

筛选、分页、选中项都写进 `validateSearch` 定义的 search params。

> `<Activity>` 保活只在**会话内**有效，刷新页面全丢；
> search params 才是跨刷新的持久层。两者互补，缺一不可。

### 3. 路由文件不渲染页面

`apps/web/src/routes/**` 只声明 `validateSearch` / `staticData` / `beforeLoad` 守卫，
`component: () => null`。页面由 `TabOutlet` 按 `lib/page-registry.tsx` 挂载。

### 4. TabOutlet 不能与 `<Outlet />` 共存

若活动页走 Outlet、隐藏页走 Activity，切换时活动页仍会卸载丢状态。

### 5. 隐藏 tab 的 DOM 仍在文档树里

任何 `document.querySelector` / 全局 DOM 测量 / 第三方库的全局选择器
都会命中隐藏页 —— 必须限定在 `[data-visible="true"]` 内。

> ⚠️ 但 `[data-visible="true"]` **不是瞬时唯一的**。切 tab 时有一段窗口
> 两个 frame 都是 `true`（实测：应用内切 tab ~18ms，整页加载后 ~300ms，
> 因为 `activeKey` 是从 sessionStorage 恢复的、要等 `useSyncTabs` 的 effect 纠正，
> 而 React 对隐藏的 `<Activity>` 子树是降优先级提交的）。
>
> 结论：要精确锁某个页面就按 **routeId** 锁 —— `[data-tab="/_auth/monitor/server"]`，
> 与调度时序无关。写 E2E 时尤其要注意，`[data-visible="true"] [data-testid="page-title"]`
> 会 strict-mode 撞两个元素。

### 6. 所有 ID 都是 string，永远不要 `Number()` 它

雪花 ID 约 2^61，超出 JS 的 `Number.MAX_SAFE_INTEGER`（2^53-1）。
后端在 `backend/utils/serializers.py: stringify_unsafe_ints` 里统一转成字符串下发。

> 实测：`2049629108245233664` 当数字解析会变成 `2049629108245233700`，
> 且连续 6 个菜单 ID 会塌缩成同一个值 —— 回传做更新/删除会命中错误记录。

**路由层也会犯这个错**：TanStack Router 默认对 search 值跑 `JSON.parse`，
`?role=2202097973238829056` 会变成 `2202097973238829000`，静默指向另一条记录
（实测：权限矩阵保存写到了列表第一个角色上）。已在
`apps/web/src/lib/search-params.ts` 里拦住 —— 超安全整数范围的纯整数保持字符串。
**新增携带雪花 ID 的 search 参数前，先确认这个自定义解析还接在 `router.ts` 上。**

### 7. 新增 workspace 包必须同步 Tailwind `@source`

`packages/ui/src/styles/globals.css` 里的 `@source` 决定哪些文件被扫描。
漏了的包，它独有的类会**静默不生成**（class 在、CSS 规则不在，表现为布局莫名其妙塌掉）。

### 8. 侧边栏同一层级必须用同一套组件

`SidebarMenuButton`（顶层）和 `SidebarMenuSubButton`（子层）内边距不同。
同层里给「有子项的」用前者、「无子项的」用后者，必然缩进错位。
`NavItem` 按 `nested` 参数选组件族，递归时往下传，**不要靠 `ps-*` 手动补齐**。

### 9. 请求失败必须是可见状态，不是缺失状态

`catch {}` 里把 UI 元素隐藏掉，等于把服务端错误伪装成「这个功能不存在」。
登录页验证码就踩过：限流 429 被吞掉 → 验证码字段消失 → 后端仍强制校验
→ 用户拿到一个怎么点都登不进去、还看不出原因的表单。
拉取型 UI 用 `loading | ready | off | error` 状态机：
`off` 只留给服务端明确关闭的情况，失败一律显示错误 + 重试入口。

### 10. 有限流的接口必须做单飞

React StrictMode 开发期把 effect 跑两遍。命中限流的接口（如 `/auth/captcha` 的 5次/30秒）
不去重就是配额腰斩。用 `inFlight` ref 挡住并发调用，配 `alive` ref 防卸载后 setState。

### 11. 不要在仓库根裸跑 `npx tsc -b`

根目录没配 `noEmit`，会往 `src` 里吐编译产物（git 未跟踪，容易漏）。统一 `pnpm typecheck`。

### 12. `pnpm typecheck` 的结论要配 `--force` 才可信

turbo 会缓存 typecheck 的结果，而缓存命中时**打印的是上一次的日志**。
两种翻车方式都实际发生过：

- **报了一个假错**：`icon-registry.tsx` 说 `IconApi` unused，照着删掉之后
  浏览器立刻 `IconApi is not defined` —— 它在第 48 行用着，那条错是旧的
- **漏报真错**：改完 URL 参数之后 `Tasks: 5 successful`，`--force` 一跑
  才冒出来 `dashboard` 里一个未使用的变量

所以**判断「类型过了」一律 `pnpm typecheck --force`**。日常开发跑不带 force
的没问题（快），但凡要据此删代码或收工，必须 force 一遍。

---

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
- **只放真接通了的开关**。界面尺寸和「布局模式」（经典侧栏 / 嵌入式 / 浮动式）
  分别要密度令牌和侧边栏变体做支撑 —— 没做的不摆上去占位。
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
- 活动 tab 自动滚入视区时，`querySelector` **必须从标签条自己的 ref 往下找** ——
  隐藏 tab 的页面 DOM 还在文档树里（见硬纪律 5）
- 滚轮横滚要**手动注册非 passive 监听**：React 的 `onWheel` 是 passive 的，
  里面调 `preventDefault()` 无效，控制台还会刷 `Unable to preventDefault` 告警
- **上下留白要放在滚动容器内部**：`overflow-x: auto` 会让 `overflow-y` 也计算成 `auto`，
  贴边的 `shadow-sm` 会被裁掉（表现为「活动 tab 的阴影不完整」）。
  所以 `py-1` 在 `[role=tablist]` 上而不是标签条上，标签条也**不能** `overflow-hidden`
- 两端用 `mask-image` 渐隐（12px），被裁一半的 tab 淡出而不是被生生切断；
  配合 `scroll-mx-5`，活动 tab 滚进来时不会正好压在渐隐带上

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
| `_shared/use-query-search.ts` | `QueryBar` ↔ URL 的胶水：从地址栏恢复条件 · 本地编辑 · 搜索时写回 URL + 拼接口入参 + **跳回第一页**。两个日志页在用，见「查询区」 |

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

服务端**没有排序入参**（各 `crud_*.py` 固定 `select_order('id')`），
所以表格一律不注册 `rowSortingFeature`。要做排序得先改后端。

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

接口有两个坑：前缀是 `/api/v1/sys/configs`（插件 `extend = "admin"`，
落在 admin 的 sys 下），**不是** plugin.toml 里写的 `/configs`；
批量更新 `PUT /sys/configs` 的权限码在上游写成了 `sys.config.edits`（**点号**，
其余全是冒号），菜单种子里也没有这一条 —— 只有超管能调，
所以批量保存走并发的单条 `PUT /{pk}` 绕开它。

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

## 主从页（左列表 / 右详情）

角色管理是这一类的样板（`pages/role/`）：左边是**选择器**不是表格，
右边按 Tab 分面板。配一份权限不该是「开抽屉 → 存 → 关抽屉 → 换角色再来一遍」。
数据权限（`pages/data-permission/`）是同一套：左范围 / 右规则。

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

面板内部（`perm-matrix` / `role-scopes` / `role-users`）各自再走一遍
「根 `min-h-0 flex-1` → 工具条 `shrink-0` → 表格框变视区」，和列表页同一套
（见「列表页：只滚表格行」）。工具条原来的 `sticky top-0` **保留**，只在定高情形下
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

## 文件管理与附件预览

两张表：`sys_file`（物理文件）+ `sys_file_relation`（挂在谁身上）。
**刻意没做**存储抽象（`sys_storage`，S3/MinIO）和个人云盘（目录树 / 分享 / 配额）——
两者后加都不用改已有代码，所以也没留 `storage_id` 这种休眠字段。

### 🔴 这一页**刻意不用 `DataTable`**

文件管理不是列表页，是**文件管理器**：左栏分类 + 存储统计，右侧宫格卡片（图片出真实
缩略图），可切列表。第一版拿三件套模板做成了表格，结果是七列等宽表头
（分类/格式/大小/上传时间/校验和…）把最该看的文件名挤成一小格、「校验和」这种排障
字段常驻占位，而「这是张什么图」完全看不出来 —— 实际使用时第一反应就是「难看」。

**表格适合多行同构数据的对齐扫描，文件不是那种数据。** 参照的是 ContiNew Admin 的
`views/system/file`（FileAside + FileGrid/FileList + FileRightMenu 那一套）。

```
pages/file/
├─ api.ts             query key · queryOptions · mutation · formatBytes · PREVIEWABLE · canThumbnail
├─ index.tsx          页面编排：左栏 + 工具栏 + 宫格/列表 + 分页
├─ file-rail.tsx      左栏：分类导航（带数量）+ 已用空间 + 分类占比条
├─ file-grid.tsx      宫格卡片（默认视图）
├─ file-list.tsx      列表视图（**手写的行，不是 DataTable**）
├─ file-icon.tsx      扩展名→图标 · 分类配色 · FileThumb（懒加载真实缩略图）
├─ file-menu.tsx      操作菜单，右键与 ⋯ 下拉共用一份条目定义
├─ detail-sheet.tsx   详情抽屉：落盘名 / MIME / 校验和 / 上传人这些排障字段
├─ preview-dialog.tsx 预览弹窗：取字节 → 交 viewer
└─ attachments.tsx    **可复用的附件面板**，任何页面给 targetType + targetId 就能嵌
```

几条定下来的约定：

- **交互按文件管理器的习惯**：单击选中 · **双击打开** · 右键出菜单。
  不是表格的「点行进详情」
- **卡片必须定高**（`h-[136px]`，名字区固定两行）。不定高时文件名换两行的卡会比
  邻居高一截 —— 未选中看不出来（边框透明），一选中边框显形就是参差不齐的一排
- 非图片文件的图标要坐在**浅色底块**上（`bg-muted/40`），否则线框图标夹在一排
  实心缩略图中间显得空。视觉重量对齐比图标本身更重要
- **视图（宫格/列表）进 URL**（`view=grid|list`），选中项**不进** ——
  几十个雪花 ID 塞地址栏不现实，和树形展开状态同一个取舍
- 左栏统计走 `/sys/files/statistics`（库里 GROUP BY），是**全量**的、不随筛选变 ——
  这正是它的用处：先看总体分布再钻进去
- 占比条用**纯 CSS 横向堆叠**，不引图表库：饼图要测容器宽度，而隐藏 tab 是
  `display:none`（宽度 0），监控页的趋势线已经因为同一个原因换掉了 recharts
- **列表视图不要退回 `DataTable`**。文件名要吃掉剩余宽度，其余属性靠右排成一条
  次要信息带；用表格会把它变回等宽列，一屏能看的文件数还少一半

### 缩略图是「把原图当缩略图」，有闸门

后端**没有缩略图列**（ContiNew Admin 有 `thumbnail_name` / `thumbnail_size`），所以
`FileThumb` 是取原图字节转 blob URL。三条约束缺一不可：

- **不能 `<img src={download_url}>`** —— 那地址要 Authorization 头，裸 src 只会拿到 401
- **必须懒加载**（IntersectionObserver，提前 200px）。副作用是隐藏 tab
  永远不进视区、一个请求都不发，正好是想要的
- **blob URL 必须 revoke** —— 不 revoke 整张图的字节会挂在 document 上直到刷新页面

闸门是 `canThumbnail()`：只对 `type === 'image'`、**≤ 1MB**、非 svg 的文件出真图
（svg 走 `<img>` 会把外链/脚本一起解析，当缩略图不值这个风险）。
一屏 30 张 5MB 的图就是 150MB，这条线不能放开。
**真正的解法是后端出缩略图**（Pillow + 一列 `thumbnail_name`），那时把
`canThumbnail` / `fileThumbQuery` 一起删掉。

### 菜单图标要在 `icon-registry.tsx` 里登记

菜单表的 `icon` 是 Iconify 命名，而 UI 包用 Tabler —— 没登记的会**静默回落成
`IconPoint`（一个小圆点）**，只在开发期 console 告警。
`文件管理` 第一版填了 `ant-design:folder-outlined`（表里没有），于是侧边栏里它旁边
全是正经图标、只有它是个 `○`，用户一眼就看出来了。
现在是 `lucide:files` → `IconFiles`，和页面左栏「全部」同一个图标，菜单和页面对得上。

> 顺带一条命名上的取舍：我们**没有目录**，所以不用文件夹图标 —— 那是过度承诺。

### 读文件一律走带鉴权的接口

`GET /api/v1/sys/files/{pk}/download`，地址由 `GetFileDetail.download_url`
（**computed_field**）下发。

- **`download_url` 必须挂在详情模型上，不要只给上传响应加。**
  曾经只有上传/详情带它，列表接口返回不带的版本 →
  前端预览拼出 `http://127.0.0.1:8000undefined` → 弹窗「文件加载失败」。
  每个读取路径都要这个地址，那它就该长在唯一的详情模型上
- **不能做成 `<a href={download_url} download>`** —— 那个地址要 Authorization 头，
  裸链接带不上，结果是把 401 的 JSON 当文件存下来。走 `fetchBytes` → Blob →
  临时 `<a>` 点一下 → **立刻 `revokeObjectURL`**（不 revoke 整个文件的字节会留在内存里）
- `UPLOAD_DIR` 在 `BASE_PATH / 'upload'`，**不在 `STATIC_DIR` 里面**。
  ⚠️ 只删 `/static/upload` 那条 mount 是**没用的**：它原来在 `STATIC_DIR` 下，
  被 `app.mount('/static', …)` 连带公开（实测删了还是 200）。
  改回去之前先想清楚：文件表里有别人的文件

### 落盘按 `YYYY/MM/DD` 分目录

`sys_file.path` 存**相对 UPLOAD_DIR 的路径**（`2026/08/21/报告_a1b2….pdf`），
`sys_file.name` 只是纯文件名。读写磁盘一律用 `path`，`name` 给展示和排障。

分目录不是为了「一个目录放不下」（ext4 有 dir_index，几十万文件也撑得住），
是为了三件事后补不回来的运维能力：按周期备份/归档/过期（`rsync upload/2026/07`）、
`ls`/`tar`/`find` 在几十万文件之后还能用、以及换对象存储后是同一套
（S3 的「目录」就是 key 前缀，日期前缀仍是惯例）。

- 日期目录**只由服务端拼**（`build_date_dir()`），客户端输入进不了这一段
- 用**本地时区**（`timezone.now()`）而不是 UTC —— 运维想的是「昨天」，
  不是「UTC 的昨天」
- 删除时**顺手回收空掉的日期目录**，否则跑几年会剩一堆空的 `YYYY/MM/DD`
- **老数据不用迁移**：`resolve_path` 是 `UPLOAD_DIR / file.path`，
  path 是裸文件名的老记录照样解析得到（实测混存下新旧都能下载、都能删）

### 🔴 `delete_file` 不能用 `strip_path()`

这是加日期目录时踩到的，**而且是静默的**：

```python
name = strip_path(relative_path)   # ← 把全部路径成分剥掉
```

`2026/08/21/x.docx` 会被剥成 `x.docx` → 指向 `UPLOAD_DIR` 根 → 文件不存在 →
`missing_ok=True` 一声不响地什么都没删。表现是「库里删干净了、磁盘越积越多」，
日志里连一条 warning 都没有。

越界防护要换成 `is_relative_to`：它**允许子目录、拦得住 `../../`**，
正是这里要的语义（`strip_path` 仍然用在**客户端文件名**上，那里剥路径是对的）。

`test_file.py` 里 `test_delete_removes_nested_file_and_prunes_dirs` 是这条的回归测试，
做过变异验证 —— 把 `strip_path` 打回去，它和批量删除那条会一起失败。

### 秒传去重的 key 必须带文件名

只按 `sha256` + `created_by` 去重会**丢掉用户起的名字**：把 `a.docx` 改名成
`季度报告.docx` 再传会命中旧记录、列表里仍显示 `a.docx`、按新名字还搜不到（实测）。
同内容不同名 = 两条记录、磁盘各存一份 —— 它们能被独立删除，**不能共享落盘文件**。

`/check` 也要接受 `name` 参数，否则它回答的问题和 `upload` 的去重口径不一致，
「命中」了却还是会重新传一份。

### 上传白名单是分类表，不是 if/else

`utils/file_ops.py: _upload_rules()` 返回 (分类, 扩展名, 大小上限, 人话名字)。
原来只有图片/视频两类且 `else: raise`，于是 pdf/docx/xlsx 一律「此文件格式暂不支持」。
写成函数而不是模块级常量 —— `settings` 会被 `sys_config` 在运行时 `setattr` 覆盖。

`FileType` 的 `other` 是兜底档：白名单放开了但没归类的扩展名落这里，不会因为漏配分类而拒传。

### 附件面板（`sys_file_relation` 的唯一入口）

```tsx
<FileAttachments targetType={NOTICE_ATTACHMENT_TARGET} targetId={notice.id} />
```

- **「移除」只解开关联、不删文件** —— 文件仍在「文件管理」里，可以再挂到别处。
  所以移除**不加二次确认**（误点的代价是重新挂一次）。真要删文件去文件管理页，
  那边会连带清掉所有关联
- `target_type` 后端**不校验**（新业务挂附件不改表不改后端），拼错不会报错、
  只会读到空列表 —— **必须走常量**（如 `NOTICE_ATTACHMENT_TARGET`），别在 JSX 里手敲字面量
- 挂载是**幂等**的（后端跳过已挂的），所以 `attach` 返回 0 是成功不是失败，
  接口层不能照抄别处的 `if count > 0 else fail()`
- 面板放**详情抽屉**而不是编辑表单：挂载需要 id，而新建表单在保存前还没有 id

### 雪花 ID 的类型账（既有欠账）

`SchemaBase` 的 `field_serializer` **只认字段名 `id`**。其他雪花字段声明成 `int` 时
openapi 生成 `number`，而编码层 `stringify_unsafe_ints` 运行时下发的是**字符串** ——
类型和运行时对不上。`sys_file` 的 `created_by` 已写成 `int | str`；
**`dept_id` / `parent_id` 那笔账还欠着**，改的时候记得连 `schema.d.ts` 一起重新生成。

> 入参方向不用改：pydantic 会把 JSON 字符串 `"2202…"` 无损转成 Python int
> （任意精度），所以前端必须发字符串、后端声明 `int` 是对的组合。

### 预览器是第三方包 `@file-viewer`（Apache-2.0）

我们只写了一层壳（`packages/ui/src/components/file-viewer/`），渲染 pdf / docx /
xlsx / 图片 / 文本 / 压缩包的是 `@file-viewer/renderer-*`。React 19 + Vite 8 实测无摩擦
（peer 分别是 `react >=17 <20`、`vite >=5 <9`，零 peer warning）。

**喂 `buffer` 而不是 `url`** —— 字节由调用方带 JWT 取回，viewer 只管渲染。
所以不需要「Redis 票据 + 短时效公开 URL」那一套，后端也没有无鉴权直链可给。
（例外：音视频要 Range 拖进度，整块 ArrayBuffer 拖不动，那类得走真实 URL。）

**只在可见处挂载** —— 放 Dialog / Sheet 里，别常驻页面。多页签用 `<Activity>` 保活，
隐藏 tab 是 `display:none`（宽度 0），而 renderer 要测容器尺寸（recharts 栽过同一个坑）。
关闭即卸载，**不要** `keepMounted`，顺带把 ArrayBuffer 让给 GC。

四个只有实测才知道的坑：

| 坑 | 症状 | 修法 |
|---|---|---|
| 没装 `@file-viewer/vite-plugin` | pdf.js 取 `/file-viewer/vendor/pdf/pdf.worker.mjs` 得 404。**viewer 外壳照常显示**，只有正文空白 + 一行 `Setting up fake worker failed` —— 像加载慢，其实是坏的 | 插件 + `copyAssets: { baseDir: 'file-viewer' }` |
| `inject: true` | 注册模块被注入 HTML 入口 → 每个 renderer 一条 `modulepreload`，**登录页预下载约 2.5MB** | `inject: false`，注册改在 `file-viewer/viewer.tsx` 里手动做，靠 `lazy(() => import('./viewer'))` 关进懒加载分片 |
| `chunkStrategy` 用默认的 `'renderer'` | JSZip / libarchive 被归进 `file-viewer-archive` 分片，入口用到一个共享符号就得拉整个 250KB | `chunkStrategy: 'none'`，交给 rolldown 自己分片（入口只静态 import 一个 4KB runtime） |
| `toolbar.position` 写了非法值 | **不报错**、运行时静默回落到默认位置 —— 看着像生效其实是巧合（`top-right` 踩过） | 只有 `auto｜top｜top-center｜bottom-right` 四个。表格类要用 `top-center`：底部有工作表页签，`bottom-right` 会把 `Print` 裁成 `…rt` |

**不要换成 `preset-all` / `@file-viewer/*-full` 包。** 那会把 drawio(66MB) ·
typst(37MB) · cad(20MB) · iwork 全拷进 dist（实测 dist 60MB → 186MB），
而且在插件里 narrow `formats` 是**无效**的 —— `-full` 包静态依赖 `preset-all`，
整个 renderer 图已经在模块图里了。

**增删 renderer 要动三处**，少一处就出错：
`file-viewer/viewer.tsx` 的 import + 数组 · `apps/web/vite.config.ts` 的 `renderers`
（决定 copyAssets 发布哪些资产）· `pages/file/api.ts` 的 `PREVIEWABLE`
（决定界面上哪些能点预览）。

> viewer 渲染在 **Shadow DOM** 里（`.file-viewer-web-shell`）。样式与 Tailwind
> 天然隔离是好事；代价是 `page.evaluate` 里的 `document.querySelector` 穿不进去 ——
> 写 E2E 要用 Playwright 自己的 locator（它会自动穿透 shadow）。
> 实测第一次探测时 host 的 `innerHTML` 只有 63 字符，差点误判成没渲染。

## 富文本里的图片（`ui/components/rich-text` + 公开子树）

正文存 HTML，图片存的是**真链接**：`<img src="/uploads/2026/08/22/x.png" data-file-id="220…">`。

### 🔴 为什么必须有一条无鉴权的读取路径

`<img src>` 带不上 Authorization 头（access token 走 `HTTPBearer`，cookie 里只有
refresh token），所以 `/sys/files/{pk}/download` 只会给 401；而 blob URL 活不过一次
刷新，存进 `NVARCHAR(MAX)` 就是死链。base64 更不行 —— 公告**列表接口返回完整
`content`**，一张 300KB 截图变 400KB base64，20 行就是 8MB 响应。

所以后端开了一棵**独立的公开子树**：

| | 目录 | 怎么读 |
|---|---|---|
| 私有（现状） | `UPLOAD_DIR` = `backend/upload/` | `GET /sys/files/{pk}/download`（JWT） |
| 公开（仅内联图） | `PUBLIC_UPLOAD_DIR` = `backend/upload-public/` | `/uploads/<path>` 静态挂载，**不鉴权** |

两棵树**物理分开**而不是在 `UPLOAD_DIR` 里开个 `public/` 子目录：共用一个根就只剩
「谁记得别给根目录加 mount」这一道纪律在守着，而这条纪律已经被破掉过一次
（`/static` 覆盖 `/static/upload`，实测删了那条 mount 还是 200）。

### 🔴 `?public=true` 只能接在富文本的上传路径上

后端只强制「公开的必须是图片」（`file_service.verify_public`），**反过来不成立** ——
文件管理页传的身份证扫描件也是图片。公开性是上传时的显式选择，不是分类的推论。

所以前端拆成两个函数而不是一个带参数的：`useUploadFile()`（私有）和
`uploadInlineImage()`（公开）。通用上传路径**在类型上就产生不了公开文件**。
**绝不要把 `public=true` 接到「文件管理」页那个上传按钮上。**

### `is_public` 要贯到四个地方，漏一个都静默出错

| 地方 | 漏了的表现 |
|---|---|
| `upload_file(public=)` | 落错树 |
| `resolve_path()` 选根 | 公开图走鉴权下载接口一律 404 |
| `delete_file(public=)` | **库里删了、盘上留孤儿，连 warning 都没有**（`missing_ok=True` 静默成功） |
| `get_by_sha256(is_public=)` | 秒传串树：命中私有旧记录 → `public_url` 是 `None` → 裂图；命中公开旧记录去满足私有请求 → **私有文件被按公开直链下发，这个方向是安全问题** |

### src 必须是**相对**路径，dev 靠 Vite 代理

`/uploads/…` 不带 host。`apps/web/vite.config.ts` 有一条 `/uploads` → API 的
`server.proxy`；生产同域天然可用。写成绝对地址就等于把 `http://127.0.0.1:8000`
烙进 `sys_notice.content`，换环境全部裂掉。
落盘名允许 CJK，所以 `public_url` **必须 percent-encode**（`quote(path, safe='/')`——
不留斜杠会把日期目录分隔符编成 `%2F`，静态挂载直接 404）。

### 防孤儿：`NOTICE_CONTENT` 关联

内联图会写 `sys_file` 但不会自动挂 `sys_file_relation` —— 公告删了图就永远留在磁盘和
文件管理里。保存时按正文里的 `data-file-id` diff 挂/卸（`useSyncNoticeImages`）。
用 `NOTICE_CONTENT` 而不是共用 `NOTICE`：正文里十几张图全涌进详情抽屉的「附件」
会把那个概念冲掉。三条：挂载幂等（返回 0 是成功）· 卸载只删关联不删文件 ·
**同步失败不能往上抛**（正文已经存进库了，报「保存失败」会让人再存一遍）。

> `POST /sys/notices` 因此改成**下发创建结果**（原来是空 `success()`）——
> 拿不到 id 就没法给新公告挂关联。
> ⚠️ `create_model` 默认**不 flush**，`id` 是数据库生成的：不加 `flush=True` 就返回，
> 序列化响应直接 500（`('response','data','id') Input should be a valid integer`，实测踩到）。

### 编辑器侧的四个坑

- **上传占位用 ProseMirror widget decoration，不要往文档里插节点。** 插节点它就会进
  `getHTML()` → `onUpdate` → `form.setValue`，用户在上传没结束时点「发布」，
  存进库的就是一个永远转圈的假节点。decoration 只活在视图层，`getHTML()` 看不见它。
  插件里 `set.map(tr.mapping, tr.doc)` 那一行是全部意义 —— 上传期间用户照常打字，
  不映射位置图就插到句子中间去了。占位找不到（用户撤销了）就**丢掉结果**，别硬插
- **状态提示存结构化数据，`t()` 推到渲染处。** 在事件回调里拼好字符串，会话内切语言
  之后那句话会停在旧语言上（`useMemo` deps 漏 `t` 是同一个 bug 的另一种面目）
- **清提示放在「新动作入口」，不要放在「每个文件成功之后」。** 放成功分支里有两个后果：
  一次粘 5 张第 2 张挂了、第 3 张成功就把失败提示抹了；更糟的是它会清掉**别的来源**的
  提示（「已移除 N 张外链图片」是粘贴时报的、跟上传无关），表现成这条警告**时有时无**，
  取决于上传比下一次粘贴快还是慢 —— e2e 里间歇失败，抓了三轮日志才定位到
- **FileHandler 要在 effect 里用 `FileHandlePlugin` 注册，不能塞进扩展数组。**
  扩展数组只在编辑器创建时求值一次（`useEditor` 的 deps 是 `[]`），塞进去的 `onPaste`
  会永久闭包在首次渲染上

### 工具栏不能裸读 `editor.isActive()`

Tiptap v3 把 `useEditor` 的 `shouldRerenderOnTransaction` 默认改成了 `false`，
于是渲染期裸读只在**父组件**重渲染时才更新：打字时因为
`onUpdate → form.setValue → 父级 setState` 绕了一圈凑巧能刷新，但**只移动光标**
（点进一个 H2 或加粗词里）不产生 update，按钮就不亮 —— 一个只在「不打字」时出现、
看起来像随机的 bug。一律走 `useEditorState`（默认 equalityFn 是深比较，返回新对象没代价）。

### 其余约定

- 外链图（从 Word / 网页粘进来）在 `transformPastedHTML` 里**剥掉 + 给可见提示**。
  浏览器里转存不了（CORS），而留着它会随对方删除而裂、且每次浏览都在给第三方发请求。
  只作用于**粘贴**，不碰 `setContent` 加载的库里既有内容 —— 静默改写用户存过的东西更糟
- `allowBase64` 保持 `false`：它让 `parseHTML` 用 `img[src]:not([src^="data:"])`，
  粘贴来的 base64 内联图在解析阶段就没了，白拿一道防线
- **`Image` 扩展 Viewer 也要装**。少了它 schema 里就没有 img 节点，库里存好的图会在
  解析阶段被静默丢掉 —— 编辑时看得见、发布后看不见
- `PROSE` 的 `[&_img]:max-w-full` 和 `h-auto` **必须成对**：3.30 的 Image 自带 resize，
  拖角会把 `width`/`height` 一起写成属性，只钳宽度会把图压扁。
  图片**没接对齐**是刻意的，理由见 `prose.ts` 里那段注释
- `richTextToPlain(html, max, imageLabel)` 的第三个参数不能省。
  默认会把 `<img>` 连标签一起吃掉，于是**纯图片的公告在列表里是空单元格**，像数据坏了
- 客户端体积闸门（`INLINE_IMAGE_MAX_BYTES` 2MB）只是「别把注定被拒的字节先传一遍」，
  **服务端才是权威**（`UPLOAD_IMAGE_SIZE_MAX` 还会被 `sys_config` 在运行时覆盖）
- 没有 `sys:file:upload` 权限时**抛错而不是藏按钮**：藏了粘贴路径就变成静默失败
  （硬纪律 9），粘一张截图什么都不发生，用户以为是自己操作错了

## 查询区（QueryBar · `ui/components/query-bar/`）

全站列表页的顶部筛选栏。**字段是声明出来的**：页面给一份 `FilterField[]`，
查询区自己决定「添加条件」能挑什么、每个字段配哪些运算符、值用什么控件渲染。
加一个筛选项 = 数组里加一项。

```
query-bar/
├─ types.ts          字段类型 · 运算符 · 值形态（valueShape）
├─ value.ts          hasValue · countActive · 换字段/换运算符时的值迁移 · pruneUnknown
├─ params.ts         toQueryParams / toSearchParams / toFilterTree / packQuery / unpackQuery
├─ validate.ts       单条 + 跨端校验（结构化错误，t() 推到渲染处）
├─ field-control.tsx 值控件总分发 + TagsInput
├─ basic.tsx         基础模式：一排 [字段名|值]，隐含 AND
├─ advanced.tsx      高级模式：可嵌套的 AND/OR 条件树
├─ views.tsx         筛选视图（localStorage，可受控）
└─ index.tsx         编排 + 状态行
```

页面侧的胶水走 `pages/_shared/use-query-search.ts`（URL ↔ QueryValue），
**不要各页手写**。

### 支持的 12 种字段类型

| `type` | 控件 | 值的形状 | 典型用途 |
|---|---|---|---|
| `text` | 输入框 | `string` | 姓名、账号 |
| `number` | 数字框（`between` 时两个） | `number` / `[number?, number?]` | 金额、评分 |
| `select` | ≤8 项 Select，>8 项自动换 Combobox | `string` | 状态、团队 |
| `multiSelect` | 带复选框的可搜索多选 | `string[]` | 角色、标签 |
| `boolean` | 是 / 否 | `boolean` | 是否置顶 |
| `date` | 日历 | `'YYYY-MM-DD'` | 入职日期 |
| `dateRange` | 快捷区间 + 双月日历 | `[起, 止]` | 统计口径 |
| `dateTime` | 日历 + 时分秒 | `'YYYY-MM-DD HH:mm:ss'` | 精确时刻 |
| `dateTimeRange` | 快捷区间 + 双月日历 + 时分秒 | `[起, 止]` | **日志排查（最常用）** |
| `time` | 时间框 | `'HH:mm:ss'` | 打卡时段 |
| `tags` | 标签输入（回车/逗号/粘贴分隔） | `string[]` | 一次查多个工号 |
| `custom` | `field.render` 自己画 | 随意（要能 JSON 往返） | 内置的都不合适时 |

运算符 15 个（`等于/不等于/包含/不包含/开头是/结尾是/大于/大于等于/小于/小于等于/属于/不属于/介于/为空/不为空`），
每种类型有默认集合（`TYPE_OPERATORS`），可以按字段覆盖。

### 🔴 值必须是 JSON 原样往返的，不能放 `Date`

这是这一版最重要的一条改动。三条路都要求它：

| 走哪 | 放 `Date` 会怎样 |
|---|---|
| URL search params（硬纪律 2） | 只能序列化成 ISO 串，读回来是字符串，schema 一验就炸 |
| localStorage（筛选视图） | `stringify` 出去是串、`parse` 回来还是串 —— **存进去能用、读回来裂** |
| 接口 | `toISOString()` 是 UTC，而后端收 `2026-08-22 00:00:00` 本地串，差 8 小时 |

所以时间类字段一律是**本地时间串**，区间是 `[起, 止]`，多选是 `string[]`，
`select` 的值也存字符串（选项原本是 number 时在出参阶段按 `options` 查回去）。
时间控件因此**不能直接用 `date-picker` / `date-range-picker`**（它们的值是 `Date`），
换成了 `ui/components/datetime-picker.tsx` 的 `DateTimeValuePicker` / `DateTimeRangePicker`。

### 值的形态由「类型 + 运算符」共同决定

`valueShape(field, op)` → `none | single | range | multi`。**控件、校验、出参三处都问它**，
不然会各自跑偏 —— 原来 `select` 的默认运算符里就有「属于」，而控件只有单选下拉：
勾了「属于」还是只能选一个，出参也只有一个值。

换运算符时值**能留就留**（`包含 张` → `等于 张`），只有形态真的变了才动
（单值 ↔ 两端 ↔ 多个，见 `migrateValue`）。换字段一律清值：
「张三」搬到「状态」上会变成一个不在选项里的值 —— 下拉空白、出参却带着它。

### 出参映射写在字段声明里，不在页面里

后端各列表接口收的是平铺入参，名字由接口定，一个字段还可能对应两个入参：

```ts
{ key: 'createdAt', label: '创建时间', type: 'dateTimeRange',
  rangeParams: ['start_time', 'end_time'] }        // 一个字段 → 两个入参
{ key: 'dept', label: '部门', type: 'select', param: 'dept_id' }
{ key: 'role', label: '角色', type: 'multiSelect', multiFormat: 'csv' }  // 默认 csv
{ key: 'weird', ..., toParam: (v, op) => ({ [`x__${op}`]: v }) }         // 完全自定义
```

四个出参函数分工不同，别混用：

| 函数 | 出什么 | 用在哪 |
|---|---|---|
| `toQueryParams` | 平铺 `{入参名: 值}` | 发给后端 |
| `toSearchParams` | 同上但**全是标量**（数组压成 csv） | 写进 URL |
| `packQuery` / `unpackQuery` | **整份查询**（压缩 JSON） | URL 里的 `q` |
| `toFilterTree` | 条件树 | 高级模式，**后端得先支持过滤语法** |

### 🔴 URL 参数 ≠ 接口入参

这两件事**必须分开**。一开始它们是同一份（页面把接口参数名直接当 URL 参数名写），
代价是地址栏被接口签名绑死，实测长这样（74 个字符，用户指出「很乱」）：

```
/log/login?start_time=2026-08-16+00%3A00%3A00&end_time=2026-08-22+23%3A59%3A59&page=1
```

里面没几个是用户真选的东西：

| 段 | 问题 |
|---|---|
| `00:00:00` / `23:59:59` | **派生值** —— 用户选的是两个日期，整天边界是必然结果 |
| `+` `%3A` | 编码噪音（值里有空格和冒号才会有） |
| 两个参数 | 一个「时间范围」被拆成两个 |
| `page=1` | 默认值（见 `_shared/pagination.ts`） |

现在：

```
URL   /log/login?time=2026-08-16~2026-08-22
请求  ?start_time=2026-08-16 00:00:00&end_time=2026-08-22 23:59:59
```

- **URL 侧**（`toUrlParams` / `fromUrlParams`）：一个字段一个参数、**按字段 `key`
  命名**、值压到最短（区间 `a~b`、多值 `a,b`、整天边界不写时分秒）
- **接口侧**（`toQueryParams`）：名字走 `param` / `rangeParams`，精度不变

⚠️ **补时分秒不能省。** 后端是 `login_time <= end_time`，`end_time=2026-08-22`
会被 pydantic 解析成当天 00:00:00，**静默丢掉 22 号一整天**。
所以压缩只发生在 URL 上，解码时立刻补回规范形式 ——
条件值本身永远是完整的，`matchRangePreset` 才认得出「近 7 天」。

### `f` 记布局，`adv` 记条件树

值参数还原不出两件事，所以另有两个参数：

| 参数 | 记什么 | 什么时候出现 |
|---|---|---|
| `f` | 摆开了哪几格（`key` 或 `key:op`） | **只在布局和默认不一样时** |
| `adv` | 高级模式的条件树（压缩 JSON） | 只在高级模式 |

`f` 一个参数同时表达两个方向，不用 `+a,-b` 语法：

```
什么都没动        →  不写（?time=… 就够了）
加了「城市」      →  f=username,ip,status,time,city
删掉了「IP」      →  f=username,status,time
「额度」切成大于  →  f=…,amount:gt
```

🔴 **两个方向都得记。** 只记「摆开但没填值的格子」的话：默认布局那几格会被全列进
`f`（刚进页面地址栏就是 `?f=username,ip,status,time`，纯噪音），而用户**删掉**一个
默认格子之后又无从表达 —— 刷新它自己回来了。反过来，`f` 缺席时必须回落到
**默认布局**而不是空数组，否则第一次进页面是个空筛选栏（`defaultVisible` 白声明了）。

`adv` 刻意**不叫 `q`**：`q` 是页面自己最容易用的关键词参数名（在线用户页和字典页
都在用），撞上之后表现是「搜索框一填，高级模式的树被覆盖掉」。
没开 `advanced` 的页面**不要**在 schema 里留 `adv`（休眠字段会骗下一个人）。

### 写回时要先清掉查询区管的键

只做 `{...search, ...next}` 的话，被移除的条件会永远留在地址栏 ——
界面上没有那一格、请求里也没有它，但复制出去的链接还带着，别人打开就多一个筛选。
`useQuerySearch` 用 `urlParamKeys(fields)` 把它们先全部置 `undefined`。

⚠️ 运算符**默认不带出去**（带了后端也不认）。所以基础模式里
`姓名 开头是 张` 发出去仍然是 `name=张` —— 要真按运算符查，得先给后端加过滤语法。

### 🔴 布局是「等宽网格 + 独立动作行」，不是 flex 换行

第一版是 `flex flex-wrap` + 每个控件自带固定宽度（`w-44` / `w-56` / `w-72`），
铺十四个条件的结果是**没有两格一样宽、没有一条对齐的竖边**（用户截图指出过）。
根因是每格宽度 = 标签宽 + 控件宽 + 移除按钮位，三项都随字段变。

现在：

- **条件是 CSS Grid**，列数跟着**容器**走（`@lg` 2 列 → `@3xl` 3 → `@5xl` 4 → `@7xl` 5）。
  用容器查询而不是 `sm:` / `md:` —— 查询区可能在页面主区，也可能在卡片或抽屉里
- **控件不带宽度**，一律 `flex-1` 撑满格子。要跨两格用 `span: 2`
  （⚠️ 它会在网格里留一个洞，长内容优先想办法**缩短显示**，见下）
- **动作区独占一行、右对齐**。和条件挤在同一行时，动作区约 500px 钉在右侧，
  条件区只剩 320px —— 每格各占一行、字段名还被压成竖排。分行之后布局与条件数无关
- **状态行放在动作行左侧**，不再单独占一行：「改了没搜」这句话最该出现在
  「搜索」按钮旁边，而动作行左半边本来是空的

### 🔴 「嵌在框里」是布尔量 `inline`，不是一串 className

基础模式把控件塞进 `InputGroup`（外面已经有一圈边框），控件必须去掉自己的边框。
第一版靠调用方传 `border-0 shadow-none …` 下来，于是**漏一个分支就静默双框**：

| 漏的地方 | 表现 |
|---|---|
| `dateTimeRange` 走 `cn(field.width, invalid)` | 时间区间那一格多一圈框 |
| 数字区间把类给了外层 `<span>` | **一个框里套着两个框**（两个 Input 各自带边框） |
| `TagsInput` 的 `focus-within:ring-3` | 平时正常，**一聚焦内圈就浮出来** |

两处都是用户截图指出来的。现在语义化成 `inline`：控件自己决定去掉什么，
加新控件时忘了它会**长得不对**（一眼看见），而不是**恰好对**（要靠人眼撞见）。
焦点反馈统一由外框接（`has-[:focus-visible]:*`）—— 用它而不是 `InputGroup`
自带的 `has-[[data-slot=input-group-control]…]`，后者只认原生 input，
Select / 日期按钮这些触发器全漏在外面。

### 🔴 一格里只有**一种字号**：14px

第一版给字段名 `text-xs`（12px）、值走控件基础类 `text-sm`（14px），于是同一个
32px 的框里**字段名比它标注的值小一号**，一整片网格上 12/14 交替；
动作行更明显 —— 「基础筛选/高级筛选」被写成 `text-xs`，紧挨着的
「搜索/重置」（Button 基础类 `text-sm`）差一号（用户截图指出过）。

规则：**层级靠颜色分，不靠字号。**

| 元素 | 字号 | 颜色 |
|---|---|---|
| 字段名 | 14px | `text-muted-foreground` |
| 运算符（用户选过的） | 14px | `text-foreground/70` —— 夹在字段名和值之间 |
| 值 | 14px | 默认前景色 |
| 区间的 `–` | 14px | `text-muted-foreground/60`（弱化只做颜色） |
| 所有按钮（含模式切换） | 14px | 各自 variant |

12px 只留给**两类东西**，它们和控件内的文字不在同一条基线上：

- **药丸**（标签 chip、`+n`）—— 对齐 `Badge` 的 `text-xs`，这是设计系统的既定档
- **注解**（状态行、弹层里的分组头与说明）

`text-[11px]` 只用在「右侧 hint」那一个角色上（对齐 `combobox.tsx` 的既有用法），
别拿它当第三档正文字号。

> 顺带：`type=number` 的原生微调箭头要关掉（`NO_SPIN`）。它悬停才出现，
> 一出现就把「介于」那一格挤成「最小 ⇅ – 最大」，两侧间距还不对称。
> 筛选场景是打字，不是点箭头。

### 高级模式的值控件不能给 `w-full`

条件行是 flex，`w-full` = 100% 行宽 → 值控件把 `[字段][运算符]` 挤到上一行、
`[复制][删除]` 挤到下一行，**一条条件占三行**（2× 截图下一眼看见）。
要的是 `flex-1 basis-48`：吃掉剩余宽度，同时给一个收缩下限，窄行才换行。

这条和基础模式的 `inline`（`min-w-0 flex-1`，撑满外框剩余）是同一个 `box`
变量的两支，加控件时两支都要过一遍。

### 一格 32px 是硬约束，长内容要缩短显示而不是加宽格子

网格里一格变高，那一行其它格（固定 32px）就和它对不齐，整片看起来是坏的。
两处为此做了压缩，思路一样：**关闭态只显示够用的信息，完整值在展开处**。

| 控件 | 完整形态 | 关闭态 |
|---|---|---|
| 时间区间 | `2026-08-05 00:00:00 ~ 2026-08-11 23:59:59`（41 字符） | `08-05 ~ 08-11`（同年省年份，整天边界省时分秒） |
| 标签输入 | 换行铺全部标签 → 这一格变高 | `flex-nowrap`，前 2 个 + `+n`（`title` 里有全部） |

### 三条 UX 上不能省的

- **回车 = 搜索。** 每个输入框都接了；`preventDefault` 不能省，
  查询区可能落在 `<form>` 里，不拦会整页刷新
- **「改了没搜」要说出来。** 显式搜索的代价就是「以为改完就生效了」，
  所以状态行会明说「条件已改，按回车或点搜索应用」。
  这一句准不准取决于有没有传 `applied`（页面已生效的那份）——
  不传的话组件自己记最后一次 `onSearch`，页面**从外部换掉 `value`** 时会误报
- **查得出来的错在点搜索之前拦住。**「介于 100 和 10」后端会老实照办、
  返回空列表，和「没数据」长得一模一样。错在哪一格就红哪一格（`validate.ts`）

### 其他约定

- **`Select` 的空态给 `null` 而不是哨兵值**，否则关闭态永远写着「不限」、
  placeholder 一次都不露脸。「不限」只作为**列表里的一项**存在（用来清空）——
  没有它的话选中之后就再也回不到空值了
- **字段名要 `shrink-0 whitespace-nowrap`。** 容器一窄，「创建时间」会被压成
  一列竖排的字（实测 320px 宽的查询区就是这样）。该收缩的是值控件
- **字段名右侧要有一条淡竖线**，移除 `×` 左侧也要。少了前者读起来是一句话
  （「姓名包含模糊匹配」）；少了后者，`×` 和 Select 的上下箭头是两个间距 6px
  的同色图标，「换个值」和「删掉这一条」看起来是同一组控件（用户截图特写过）
- 字段超过 8 个时「添加条件」自动出搜索框，`field.group` 分组
- `field.locked` 的条件不给移除入口；`collapseAfter`（默认 8）之后折叠
- 筛选视图存 localStorage（`useQueryViews` **惰性 initializer 首帧就读**，
  用 effect 会晚一帧、默认视图会闪一下空筛选）。要落库就传受控的
  `views` / `onViewsChange`
- 高级模式的 `advanced` 开关**后端没有过滤 DSL 时别开** ——
  界面上配得出「或」、发出去只剩平铺 AND，是最难解释的那种「查出来的不是我要的」

> 沙箱里有一份把 12 种类型全摆一个的 demo（`/sandbox/components?c=query-bar`
> 的「默认铺开 = 全部铺开」），下面挂着四块出参面板。
> 配查询区最容易翻车的就是「界面上勾了但没进请求」，摊开看一眼就知道接没接上。

## 组件约定

| 场景 | 用法 |
|---|---|
| 带图标的输入框 | `InputGroup` + `InputGroupAddon`，**不要**「相对定位 + 手动 padding」——`px-*` 是 `padding-inline` 简写，会覆盖 `pl-*` |
| Select 显示标签 | 必须传 `items={{value: label}}`，否则关闭态显示原始 value |
| **下拉选哪个** | **按选项数量分**：≤ 8 项（状态/类型/是否）用 `Select`，点开一眼看全，多个输入框是噪音；长列表用 `Combobox`（菜单管理的「上级菜单」28 项、「路由地址」23 项都是它）。过滤走 `Intl.Collator`，中文与大小写都对 |
| **选多个** | `ui/components/multi-select`。关闭态刻意**不铺 chips**（筛选栏一行 32px，铺三个就换行）—— 1 项显示 label、多项显示「label +n」，完整清单靠下拉里的勾选态。下拉底部有「全选 / 清空」 |
| 时间筛选 | `ui/components/datetime-picker` 的 `DateTimeValuePicker` / `DateTimeRangePicker`。值是**本地时间串**不是 `Date`（理由见「查询区」），区间自带快捷区间（今天/昨天/近 7 天/近 30 天/本月/上月） |
| 列表页筛选栏 | `ui/components/query-bar` + `_shared/use-query-search`。**不要**在页面里手拼筛选控件和入参映射，详见「查询区（QueryBar）」 |
| 别用 `command.tsx` | 那是 cmdk，仓库里**一个调用方都没有**。要可搜索下拉走 `Combobox`（Base UI 底座，和其余组件同源） |
| 滚动条外观 | 已在 `ui/styles/globals.css` 全站统一（`scrollbar-width: thin` + `--scrollbar-thumb`），**不要逐个容器改**，也**别用 `scroll-area.tsx`**（零调用方，理由见那个文件的头注释）。刻意不用 `::-webkit-scrollbar` —— 它会强制 macOS 退回常驻滚动条 |
| 隐藏滚动条 | 一律 `no-scrollbar`（shadcn 上游的 `@utility`），别手写 `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`。用在**操作区**（标签条、侧边栏），内容区不要藏 |
| 抽屉表单的字段 | `_shared/form-fields.tsx` 的 `FormField`（标签在上/控件/错误），**不是** `ui/components/field` 的 `Field` —— 后者是 `ComponentProps<'div'>`，没有 label/error/required。历史上 5 个表单各写了一份包裹件、3 份字节级相同 |
| 长表单分组 | `_shared/form-fields.tsx` 的 `FormSection`（`▌标题 ────`）。渲染成 `fieldset` + `legend`，读屏会念「联系信息 分组」。**只给字段多的表单用** —— 菜单 12 个、用户 7 个值得，4 个字段的公告加了就是装饰 |
| DropdownMenuLabel | 必须包在 `DropdownMenuGroup` 内，否则 Base UI 抛 `MenuGroupContext is missing` |
| 表格容器 | `overflow-x-auto`，**不要** `overflow-hidden`（会把最右侧操作列裁掉，点不到） |
| 二次确认 | `platform/shell/confirm-dialog`（支持 async + pending），渲染成触发器的兄弟节点，不能放进 `DropdownMenuContent` |
| 树形多选 | `packages/ui/components/tree`（三态 + 级联 + 过滤）。**角色授权不用它**，见「主从页」 |
| 状态色 | 只在 `pages/_shared/status.tsx` 定义，用 `<StatusBadge>` / `<StatusPill tone>`；页面里手抄那串 emerald/destructive class 是禁止的 |
| 行选中 | 要么配 `buildSelectColumn` + `BulkBar`，要么 `enableRowSelection: false`（只读列表）；开着却没有复选框列，分页条上的「已选 N 项」永远是 0 |
| 半选复选框 | Base UI 是独立的 `indeterminate` prop，**不是** `checked="indeterminate"` |
| 分页 | 有 `page`/`size` 在 search schema 里，界面上就必须有分页条 —— 否则第 2 页不可达。默认每页走 `_shared/pagination.ts` 的 `DEFAULT_PAGE_SIZE`（宫格用 `DEFAULT_GRID_PAGE_SIZE`），**不要各页写 `search.size ?? 20`** —— 原来那个 `?? 10` 散在 8 处，改默认值必漏一处，而漏了只表现为「某一页跟别人不一样」。默认值刻意**不写进 URL**：写了就分不出「用户显式选了 20」和「没选、恰好是默认」 |
| 「回第一页」 | 写 `page: undefined`，**不是 `page: 1`**。改筛选必须跳回第一页（第 5 页改条件、结果只剩 3 条 → 空页，看着像「什么都没查到」），但写字面量 1 会让 `?page=1` 出现在每个列表页的地址栏 —— 全仓踩了 59 处 + 8 处 `page: i + 1`（从第 2 页点回第 1 页）。见 `_shared/pagination.ts` |
| 列显隐 | 用 `_shared/use-column-visibility`，URL 里存**被隐藏**的列 id（`hide=browser,os`）。默认全显示所以通常为空，加列也不会让老链接错位 |
| 空列表 | `DataTable` 的 `emptyAction` 放「清除筛选」—— 空态最常见的成因就是筛选太窄，别逼用户回工具栏找 |
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
| 文件预览 | `ui/components/file-viewer` + `pages/file/preview-dialog`。喂 `buffer`（带鉴权取回的字节）不喂 url；只在 Dialog 里挂，别常驻页面。详见「文件管理与附件预览」 |
| 业务对象附件 | `pages/file/attachments` 的 `<FileAttachments targetType targetId />`，别另写一套。`targetType` 走常量 |
| 富文本 | `ui/components/rich-text`。图片能力由 `platform` 注入（`useRichTextImages()`），不传 `images` 就整块关掉。详见「富文本里的图片」 |
| 带鉴权的下载 | 不能用 `<a href download>`（带不上 Authorization 头，会把 401 的 JSON 存成文件）。走 `fetchBytes` → Blob → 临时 `<a>` → `revokeObjectURL` |

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

这个坑在本仓库已经踩到三次（抽屉宽度 8 处 · Select 高度 2 处 · 加上表里那条）。
改尺寸前先去 `packages/ui/src/components/<组件>.tsx` 看基础类**有没有变体前缀**：

```bash
grep -oE '(data-\[[^]]+\]|has-\[[^]]+\]):(sm:)?(max-w|min-w|h|w|size)-[^ "]+' \
  packages/ui/src/components/select.tsx
```

## 国际化（`packages/i18n` · 中文原文即 key）

**已做**：后端 msg 全量翻译 · 前端 1191 条 key（含菜单标题、接口 summary、
插件元信息）· 语言切换。全站扫下来只剩**用户自己录的业务数据**（见文末「边界」）。
**没做**：部门 63 / 角色 88 / 数据范围与规则 16 / 字典 33 / 公告 27 这些纯业务数据；
`dev-sandbox` / `playground-*` / `ui/data-grid` 是沙箱与在建组件，
刻意不纳管（`check.mjs` 的 `SKIP_DIRS` 里列着）。
`ui/query-bar` **已经从 SKIP_DIRS 里拿出来了** —— 它要用在全站列表页上，
不纳管等于每个列表页的筛选栏在英文下都是中文。
（两个脚本的 SKIP 列表要一起改，`jsx-text.mjs` 那份是另一处。）

### 包结构（参照 Rocket.Chat 的 `packages/i18n`）

```
packages/i18n/
├─ src/locales/zh-CN.json     基准语言（恒等映射：key 与值都是中文）
├─ src/locales/en-US.json     译文
├─ src/index.ts               i18next 实例 · LANGUAGES · changeLanguage · menuKey
│                            · 模块级 t() · formatNumber/Time/Date/Duration
├─ src/server-data-keys.json  后端数据里的中文（见「白名单」）
└─ src/scripts/check.mjs      校验器，`pnpm i18n:check` / `pnpm i18n:fix`
```

语言文件**不放在 app 里** —— 文案来自 `ui` / `platform` / `web` 三层，
放 app 会让最底层 `ui` 的文案存在最上层，分层就反了。

⚠️ **`packages/i18n` 不依赖 `react-i18next`**（保持框架无关）。
React 绑定 `initReactI18next` 在 `apps/web/src/i18n.ts` 里通过
`initI18n([initReactI18next])` 注入。**忘了注入的后果很隐蔽**：
`useTranslation()` 会绑到 react-i18next 自己的空实例上，`t()` 原样返回 key ——
界面看起来「全是中文」（因为 key 就是中文），连插值都不做，
分页条直接显示 `共 {{total}} 条`。实测踩过。

同理，「切语言时同步接口 `Accept-Language`」也在 app 层用
`onLanguageChange()` 订阅 —— 那需要 import platform 的 api-client。

### key 策略：中文原文即 key

```tsx
const { t } = useTranslation()
<span>{t('每页')}</span>
{t('已选 {{n}} 项', { n })}
```

GitLab（gettext，英文原文即 msgid）和 VS Code（`l10n.t()`）都是这个路线。
**刻意不抄 Rocket.Chat 的 `Department_name` 式符号 key** —— 那是他们英文优先的
结果而不是独立最佳实践（他们的 zh-CN 也只是英文译文）。我们中文优先，
符号 key 会把「漏一条 zh 条目 → 屏幕上出现 raw key」变成常态失败模式。

`zh-CN.json` 是**恒等映射**。放它的意义：文案有一处可集中修改；
最坏情况（漏条目）也只是回落到 key，而 key 本身就是中文。

### 菜单标题：key 用 **path**，不用标题

```tsx
t(menuKey(node.path), { defaultValue: node.title })
```

标题存在数据库里、管理员随时能改，用它当 key 改一次文案就失效；
而 `path` 是菜单管理页从**前端真实路由下拉选**的，是这套数据里最稳的东西。
`defaultValue` 回落库里的中文标题 —— 管理员新建的菜单**永远不会露 raw key**。
`tab-item.tsx` 用 `href` 的 pathname 同理。

### 五条硬规则

1. **`keySeparator: false` + `nsSeparator: false`**。删了会**静默出错**：
   默认 `.` 会把 `smtp.qq.com` 切成嵌套路径，默认 `:` 会把 `最后更新 14:58`
   和 `menu:/system/dept` 当成「命名空间:key」
2. **只许传字符串字面量**。`t(label)` / `` t(`第 ${n} 页`) `` 校验器看不见 ——
   和 GitLab 文档同一条规则。动态文案用插值 `t('第 {{n}} 页', { n })`
3. **模块级常量翻不了**（加载时求值、切语言不更新）。但因为 key 就是中文原文，
   在**渲染组件**里 `t(变量)` 就行 —— `STATUS_META`、页面里的 `XXX_ITEMS`
   和它们的调用点一个都不用改。这是「原文即 key」最实用的好处
4. **参数默认值里不能调 hook**。`emptyMessage = '暂无数据'` 要改成
   `emptyMessage` + 渲染处 `?? t('暂无数据')`
5. **普通函数不能调 hook**。`buildColumns()` 是在 `useMemo` 里被调用的普通函数，
   自己 `useTranslation()` 会让 React 抛
   `Should have a queue. You are likely calling Hooks conditionally` 直接白屏 ——
   把 `t` 当参数传进去。它的 `t` 参数签名要写成
   `(k: string, vars?: Record<string, unknown>) => string`，
   写成 `(k: string) => string` 的话带插值的调用会编译不过

### 一句话里夹了 `<code>` / `<strong>` 就得用 `<Trans>`

拆成「前半 t() + `<code>` + 后半 t()」在中文下看不出问题，换英文语序一变就散架
（而且那两半会变成两条谁也读不懂的碎 key）。整句一个 key，标签走 `components`：

```tsx
<Trans
  t={t}
  i18nKey="该插件 extend 到 <code>{{app}}</code>，实际挂载路径会带上宿主应用的段。"
  values={{ app: info.app.extend }}
  components={{ code: <code className="font-mono" /> }}
/>
```

`check.mjs` 认 `i18nKey="…"`，所以这类 key 一样受 missing-keys 保护。

### 模块级 `t()`：给 api.ts、纯函数、抛异常的地方

`packages/i18n` 导出一个不带 hook 的 `t()`。它读的是**调用瞬间**的语言、不订阅变更，
所以只能用在「每次都会重新调用」的位置：mutation 里抛的 `new Error(t('…'))`、
`remainingText()` 这种 render 期间算的派生文案、`registry.ts` 的校验信息。
组件里的静态文案一律 `useTranslation()`，否则切语言不重渲染。

### zod 校验信息：定义处不动，渲染处翻

schema 是模块级常量，拿不到 hook。但 key 就是中文原文，于是用
`pages/_shared/form-error.ts` 的 `useFieldError()`：

```tsx
const fe = useFieldError()
<Field label={t('用户名')} error={fe(errs.username?.message)} />
```

### 时长/时间不要在后端拼中文

原来 `utils/format.py: fmt_seconds()` 在后端就把「3 天 5 小时」拼好了，
英文界面上这一格永远是中文。接口改成下发 `*_seconds`（`uptime_seconds` /
`elapsed_seconds`），成句交给 `packages/i18n` 的 `formatDuration()`。
**新增任何「时长」字段都照这个来 —— 后端只发数值。**

### 校验器（`pnpm i18n:check`，`pnpm i18n:fix` 自动修）

规则挑自 Rocket.Chat 的 `check.mts`：

| 规则 | 级别 |
|---|---|
| `sort-keys` 基准语言排序、其他语言跟随（diff 可读） | 错误，可 --fix |
| `missing-keys` 代码里 `t('…')` 用到但语言包里没有 | **错误** |
| `missing-placeholder` 译文丢了基准语言有的 `{{var}}` | **错误**（i18next 会渲染成空） |
| `extra-placeholder` 译文凭空多出 `{{var}}` | **错误**（会渲染字面量 `{{var}}`） |
| `extra-keys` 语言包里有、代码里已无 | 警告，可 --fix |
| `missing-translation` / `untranslated` | 警告 |
| `shadowed-t` 声明了叫 `t` 的变量/回调参数 | **错误** —— 见下 |
| `stale-server-keys` 白名单里已不在语言包的键 | 警告 |
| 动态 key 候选（`t(变量)` 形态） | 仅提醒 —— 对象值里的中文不一定真走 `t()` |

扫描前**先剥注释**。不剥的话中文注释里的成对引号（`用 'a' 而不是 'b'`）会被当成
字符串字面量，动态 key 提醒里塞进几百条散碎片段（实测 369 → 240，全是噪声）。

#### 白名单 `server-data-keys.json`

后端数据里的中文（`sys_config.name` 61 · 接口 `summary` 108 · 插件 `summary`/
`description` · 公告类型…）在代码里**根本不会出现** —— 渲染处写的是
`t(item.name)`，值来自数据库。没有白名单 `extra-keys` 会把它们全判成孤儿，
**`--fix` 一跑就整片删掉**，英文界面上这些字段瞬间回中文。
后端加了配置项 / 接口就往这里补一条（同时补两个语言包）。

#### JSX 文本节点是校验器的盲区 —— 单独一个 `pnpm i18n:jsx`

`t('…')` 正则只看**字符串字面量**，而 `<IconPencil />编辑` 里的「编辑」是 JSX
**文本节点** —— `check.mjs` 一个字都看不见，界面上却是明明白白的中文
（第一次跑出来 114 处，每个 ⋯ 菜单里的「编辑 / 删除」都在里面）。

`scripts/jsx-text.mjs` 做反向扫描：剥注释 → 把字符串/模板字面量掏空 →
剩下的中文只可能是 JSX 文本。**干净状态下输出 0 处**，非 0 就退出码 1。
两个脚本要一起跑，缺一个都会漏：

```bash
pnpm i18n:check   # t('…') 的 key 有没有进语言包 + shadowed-t
pnpm i18n:jsx     # 有没有压根没进 t() 的裸中文
```

#### 🔴 剥注释必须是**字符串感知**的（`strip-comments.mjs`）

两个脚本都先剥注释再扫。原来用的是裸正则 `/\/\*[\s\S]*?\*\//g`，
**它会把字符串里的 `/*` 当成块注释开头**：

```tsx
<input accept="image/*" />     // ← 这里开始「注释」
…
{t('上传图片')}                 // ← 被吃掉了，扫不到
```

一路吃到文件里下一个 `*/`。实测：`profile/index.tsx` 加了 `accept="image/*"` 之后，
它下面 6 条 key 全被判成「代码里已无此 key」的孤儿 —— 而 **`--fix` 会把孤儿从语言包里
删掉**，英文界面上那几处直接回落中文；missing-keys 同时瞎掉（key 明明在代码里却报缺失）。

反方向的坑同样存在：CSS-in-JS 的注释藏在**多行模板字面量**里
（`-sign-in-brand.tsx` 有一个 `` `…` `` 装 CSS，里面是中文注释）。字符串内容原样保留时，
`jsx-text` 会把它们当成裸露的 JSX 中文报出来 —— 而 jsx-text 原来那几条**逐行**的
引号正则看不见跨行的模板字面量。

所以 `strip-comments.mjs` 逐字符扫，两种模式：

| 模式 | 用在 | 行为 |
|---|---|---|
| `blankStrings: false` | `check.mjs` | 字符串整段原样留着 —— key 藏在里面 |
| `blankStrings: true` | `jsx-text.mjs` | 字符串内容抹成空格，只找字符串**外面**的中文，模板字面量跨多少行都抹干净 |

`keepLines: true` 保留行号（jsx-text 要报行号）。另外 `\/` 后面的 `/` 不算行注释开头，
否则正则字面量 `/^https?:\/\/\S+$/` 会把自己那行的后半截吃掉。

> 新增这类脚本时**不要**再写裸的注释正则。

#### 另外三个盲区，脚本兜不住，只能靠纪律

1. **`{}` 表达式里的字面量**。`{isEdit ? '保存修改' : '创建用户'}` 既不是 JSX 文本
   （在花括号里）、也不在 `t()` 里 —— 两个脚本都看不见。**所有表单的提交按钮
   曾经全是裸中文**，就是这么漏的。
2. **`「」『』（）` 不在 `[一-鿿]` 区间里**。`` `「${username}」` `` 这种只由标点 +
   变量组成的片段，missing-keys 抓不到，英文界面还会渲染中文书名号。
3. **`.map(h => t(h))` 是动态 key**。CSV 表头写成 `['序号','登录时间',…].map(t)`
   看起来很干净，但校验器一条都抽不到 —— 要展开成 25 个 `t('序号')` 字面量。

#### Select 的 `items=` 是**关闭态**的标签源

`items={STATUS_ITEMS}` 传中文常量进去，等于关闭态永远不翻（下拉展开时才对）。
一律在渲染处 `useMemo` 映射一遍：

```tsx
const statusItems = React.useMemo(
  () => Object.fromEntries(Object.entries(STATUS_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
  [t]
)
```
**`useMemo` 的 deps 必须带 `t`** —— 漏了的话会话内切语言不重算，标签留在旧语言
（`columns` 的 `useMemo` deps 写成 `[]` 也是同一个 bug）。

#### 一个 key 只能有一个意思

`关闭` 曾经译成 `Off`，而它 8 处用法里 7 处是「关闭抽屉/标签页」= `Close` ——
于是所有抽屉的关闭按钮在英文下都显示 `Off`。**判给多数方**（`Close`），
开关那一处换成独立的 `已开启` / `已关闭`。
同类：`引用`（Reference）不能给富文本的引用块用，另起 `引用块`（Blockquote）。

### 后端侧：前端传 `Accept-Language`，后端在**响应出口**翻

```
前端 client.ts (setApiLanguage)     →  Accept-Language: en-US
  ↓
I18nMiddleware.dispatch             →  ctx.language = 'en-US'   ← **请求级**（starlette-context）
  ↓
出口翻译                             →  t(点分隔键) / tm(原文查表)
```

`ctx.language` 走 starlette-context 的请求作用域，**不是全局单例**——
并发下不会串语言。（`i18n.current_language` 在请求周期外访问会抛
`ContextDoesNotExistError`，这正是它请求级的证据；写单测要用
`with request_cycle_context({'language': lang}):`。）

**两套翻译函数并存是刻意的**：

| | 入参 | 用在哪 | 语言包位置 |
|---|---|---|---|
| `t()` | 点分隔**键**（`response.success`） | `CustomResponseCode` 枚举、pydantic 校验 | `error` / `pydantic` / `response` 段 |
| `tm()` | **原文**（中文字面量） | 业务代码 189 处 `msg='中文'`（28 个文件） | `messages` / `message_templates` 段 |

`tm()` 存在的理由：逐个改成 `t('error.user.not_found')` 会在 fork 里铺开 28 个文件的
冲突面，而出口翻译**调用点一行都不动**。两级查找：`messages` 精确匹配 →
`message_templates` 模板匹配（`{}` 占位生成正则去套）→ 查不到原样返回。

#### 出口必须收全 —— 漏一个出口就漏一整类响应

| 出口 | 翻法 |
|---|---|
| `exception_handler.py` 4 处 | `tm(str(exc.msg))` / `tm(str(exc.detail))` |
| `ResponseBase.__response()` | `tm(res.msg)` |
| `ResponseBase.fast_success()` | `tm(res.msg)` |

> **`response_schema.py` 那两处曾经是漏的**：`CustomResponseCode` 的 msg 由
> `CustomCodeBase.msg` 的 `t()` 翻过了，看起来没问题 —— 但
> `CustomResponse(code=200, msg='插件 x 安装成功…')` 是**裸中文字面量**，
> 直接漏进响应。而语言包里那两条模板一直都在，成了**死条目**。
> `tm()` 对已翻过的 msg 是幂等的（查不到表就原样返回），所以在出口无脑套一层是安全的。

#### `CustomResponseCode` 的值必须是点分隔键，不能写中文

`HTTP_500 = (500, '服务器内部错误')` 曾经这么写 —— `t()` 拿它当 key 去查，
查不到就原样返回，于是 500 的 msg **在任何语言下都是那句中文**。
（`HTTP_200` / `HTTP_400` 用的是 `response.success` / `response.error`，就它不一致。）

#### 反向缺口：框架抛的文案是**英文**的

FastAPI 的 `HTTPBearer` 抛 `Not authenticated`、starlette 抛 `Method Not Allowed` ——
**中文界面下这些才是需要翻的那一方**。`tm()` 原来无条件在默认语言短路，
所以中文界面永远露英文。短路条件已改成「默认语言 **且** 该语言没有 `messages` 表」，
`zh-CN.yml` 补了一个 `messages` 段放这类英文→中文的映射。
业务中文查不到就原样返回，所以这一段只会命中英文，不会误伤中文。

#### 中间件：认不出的语言必须回落

`lang_mapping.get(lang, lang)` 把没映射的语言原样返回过 —— `I18n.t()` 查不到语言包时
会把 key 整个换成 `error.language_not_found`，于是**所有**响应的 msg 都变成
「当前语言包未初始化或不存在」。实测：日文浏览器访问，连 `请求成功` 都是那句话。

### 两个容易踩的

- **别把 map/回调的变量命名成 `t`** —— 会遮蔽翻译函数。**已经踩过 15 处**，
  所以 `check.mjs` 有一条 `shadowed-t` 硬规则专门挡它（在 import 了翻译函数的文件里，
  扫 `(t) =>` / `function (t` / `const|let|var t =` / `for (const t of`）。
  形态五花八门：`TABS.map((t) => …{t.label})`（role/profile 两处 tab 从来没翻）·
  `const t = setTimeout(…)` · `tags.forEach((t) => …)` ·
  `const t = tone ?? usageTone(pct)` · `ToastItem({ toast: t })` ·
  `const t = Date.parse(…)` · `railIdOf` 里 `const t = item.type`。

  > 为什么必须靠静态规则：它**不一定报错**。`{t.label}` 里 t 是对象时 tsc 能拦
  > （"has no call signatures"），但 `const t = 5` 之后调 `t('x')` 要到运行时才炸，
  > 而"返回原文"那种写法连炸都不炸 —— 静默不翻，只能靠人眼在界面上发现
- **默认参数值里不能调 hook**（`placeholder = '选择日期范围'`、
  `title = t('管理平台')`）—— 默认值在 hook 之前求值。改成 `placeholder?: string`
  + 渲染处 `?? t('…')`
- **数字/时间格式化走 `formatNumber` / `formatTime` / `formatDate`**（`packages/i18n`），
  不要写死 `toLocaleString('zh-CN')`。中英分组符号一样，所以写死了也看不出来 ——
  等加了德语（`1.234.567`）才会发现漏了哪几处

### 边界：**业务数据不翻**

用户自己录的数据不进语言包：数据范围名 · 规则名 · 部门名 · 字典项 · 公告正文 ·
角色名与描述 · 人名。要多语言得加翻译表/翻译列，属于另一个量级。

而**从代码/配置里来的中文**是例外：菜单按钮标题、参数配置的 `name`/`remark`、
接口 `summary`（= 操作日志的「操作内容」列，108 条）、插件 `plugin.toml` 的
`summary`/`description`、登录日志的 `msg`。它们虽然也在库里，但稳定、来源在仓库里，
渲染处走一次 `t(变量)` 就能翻 —— **历史记录也一起翻了**，因为存的就是中文原文。
这是「原文即 key」最大的实用价值。它们必须同时进 `server-data-keys.json`。

判据很简单：**这段中文是谁写的？** 仓库里写的 → 翻；用户在界面上敲的 → 不翻。

⚠️ **判"是业务数据"之前必须把清单看完。** 扫描脚本按页输出，一页几十条时
很容易只看前十几条就下结论 —— `/system/role` 的 88 条里前 14 条恰好全是角色名，
于是"功能权限/数据范围/角色用户"三个 tab 被埋在后面 —— 是在界面上被发现的，不是扫描脚本报出来的。
现在扫描按「语言包里**已有**这条 key、界面上却还是中文」分桶：命中的一定是
渲染处漏了 `t()`，**不可能是业务数据**，必修。
（反过来会有假阳性：字典类型名「通知公告」恰好和菜单标题撞了 key —— 这是这个
判据的固有代价，看一眼上下文就能排除。）

最后一次全站扫描（英文模式，逐页抓中文片段）剩 256 种，全部落在下面这几类：
部门 63 · 角色 88 · 数据范围/规则 16 · 字典 33 · 公告 27 · 人名 —— 一条 UI 文案都没有。

菜单表格标题用**两级回落**：`t(menuKey(node.path), { defaultValue: t(node.title) })`
—— 一级用 path（稳定），按钮行没有 path 就回落到「标题本身即 key」。

### 布局提醒

**英文比中文长约 40%**。`SelectFilter` 的宽度用 `min-w-*` + `w-auto`，
写死 `w-28` 会把 `All statuses` 截成 `All statuse:`（切到英文界面才会暴露）。

## 跑测试

```bash
pnpm test                     # = turbo test → apps/api 的 pytest
cd apps/api && uv run pytest backend/app/admin/tests/api_v1/test_file.py -q
```

**测试跑在独立的 `fba_test` 库上**（`backend/conftest.py` 覆盖了 `get_db`），
不是开发库。第一次要手工准备，否则报的是一句看不出原因的 sqlalchemy 连接错误：

```bash
# 1. 建库
docker exec fba_mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PW" -C \
  -Q "IF DB_ID('fba_test') IS NULL CREATE DATABASE fba_test;"

# 2. 建表（从模型生成，和开发库同一套路子）
cd apps/api && uv run python -c "
import asyncio, backend.app.admin.model, backend.plugin.config.model, backend.plugin.dict.model
import backend.plugin.notice.model, backend.plugin.oauth2.model
from backend.common.model import MappedBase
from backend.database.db import create_database_async_engine, get_database_url
async def m():
    eng = create_database_async_engine(get_database_url(unittest=True))
    async with eng.begin() as c: await c.run_sync(MappedBase.metadata.create_all)
    await eng.dispose()
asyncio.run(m())"

# 3. 灌种子（登录 fixture 要 admin 账号）
docker cp backend/sql/sqlserver/init_snowflake_test_data.sql fba_mssql:/tmp/seed.sql
docker exec fba_mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PW" -C -I \
  -d fba_test -i /tmp/seed.sql
```

三个坑：

- **`sqlcmd` 灌种子必须加 `-I`**（QUOTED_IDENTIFIER ON）。`sys_user` 上有筛选唯一索引
  （`_EMAIL_UNIQUE`），SQL Server 要求这个选项为 ON 才允许 INSERT，否则报
  `Msg 1934 … SET options have incorrect settings: 'QUOTED_IDENTIFIER'`
- **`test` 脚本用 `uv run --no-sync`**。裸 `uv run` 每次都会重新 sync 依赖，
  那一步要联网 —— 在 turbo 的净化环境里会卡成 `Request failed after 3 retries`。
  代价是要先跑过一次 `uv sync --group dev`
- **`turbo.json` 里 `test` 必须 `cache: false`** —— 测试打真实数据库，
  缓存住「上次通过了」毫无意义

### 写测试时：`UPLOAD_DIR` 必须顶到 tmp

`UPLOAD_DIR` 是在各模块顶层 `from ... import UPLOAD_DIR` 进来的，
改 `path_conf` 上那一个**没用** —— 必须逐个模块 monkeypatch
（`utils.file_ops` 和 `service.file_service` 各一份，见 `test_file.py` 的
`isolated_upload_dir`）。漏掉哪个，那条路径就会读写开发环境真实的 `backend/upload/`。

### 有测试的部分 / 没测试的部分

| | 状态 |
|---|---|
| 文件模块接口（上传 · 去重 · 穿越 · 日期目录 · 列表 · 统计 · 下载 · 附件 · 删除） | `test_file.py` 23 条 |
| `/auth/logout` | 上游留下的 1 条 |
| **其余所有模块** | **没有测试** |
| **前端** | **没有测试基建**（无 vitest / 无 playwright 配置） |

> `test_file.py` 里两条标了 🔴 的是**回归测试**，对应两个真出现过的 bug
> （去重丢文件名 · 列表缺 `download_url`）。做过变异验证：把修复分别打回去，
> 对应的测试会失败 —— 它们不是摆设。

## 后端约定

三层：`api/v1/` → `service/` → `crud/`，模型在 `model/`、DTO 在 `schema/`。

- 存中文的列用 `UniversalStr(n)`，**不要** `sa.String(n)`（SQL Server 下要 NVARCHAR）
- 长文本用 `UniversalText`（mssql → `NVARCHAR(MAX)`，不是废弃的 `NTEXT`）
- 分页查询必须带 `ORDER BY`（`select_order`）——SQL Server 的 `OFFSET FETCH` 强制要求
- 唯一约束若含可空列，SQL Server 下要改用筛选唯一索引
  （见 `model/user.py` 的 `_EMAIL_UNIQUE`）
- 返回裸 dict 的接口要过 `stringify_big_ids` / 编码层的 `stringify_unsafe_ints`
- 用户列表的 `role` 入参（本仓库加的）是落在已 join 的 `user_role` 上的，
  **副作用是返回的 `roles` 只剩被过滤的那一个**。要用户的完整角色走 `GET /users/{pk}/roles`。
  改成 `User.id.in_(子查询)` 能拿回完整 roles，但用户会按角色数重复成多行，
  `apaginate` 按行计数 —— total 和翻页会一起错
- 角色 ↔ 用户的增删走 `POST/DELETE /roles/{pk}/users`，**不要**用 `PUT /users/{pk}`：
  后者收整个用户对象，为改一个角色要把 username/email/dept 全带上回传，读漏一个字段就清掉一个
- 关联表写完记得 `user_cache_manager.clear*` —— 权限码和侧边栏缓存在 Redis，
  不清的话新权限要等 token 过期才生效
- 🔴 **给嵌在用户缓存里的 DTO 加必填字段，必须同时清掉 `fba:user:*`。**
  `GetUserInfoWithRelationDetail` 里嵌着 `dept` 和 `roles`，整份序列化后存在
  `fba:user:<id>`（`JWT_USER_REDIS_PREFIX`）。给 `GetDeptDetail` / `GetRoleDetail`
  加了必填字段之后，**旧缓存里没有那个字段** → 每个已登录用户的每个请求都
  `ValidationError: dept.code Field required` → **全站 500**，而代码、数据库、
  语言包全都是对的。实测踩过（加 `code` 时 pytest 13 条全红，报的是文件上传 500）。
  一行的事：`redis-cli --raw KEYS 'fba:user:*' | xargs -r redis-cli DEL`
  —— 它只清缓存，不影响登录态（token 在 `fba:token:*`）
- `xxx_dao.update_*` 返回的是「写了几行」，不是成败。清空类操作（`menus=[]`）本来就是 0，
  接口层拿它判 `response_base.fail()` 会把一次成功的清空报成失败
- **`deleted` 不是布尔，是「0 或这一行自己的 id」**（`LogicalDeleteMixin`，`BigInteger`，
  注释写着「0：否；id：是」）。这样含可空列的唯一约束在软删之后还能再插同一个键。
  **副作用**：任何手写 SQL 忘了 `AND deleted=0`，都会把已删除的行当成活的。
  实测踩过：`UPDATE sys_menu SET path=… WHERE id=…` 改的是一条**已软删**的目录，
  再往它下面 INSERT 子项 —— 父节点不在侧边栏结果集里，`traversal_to_tree`
  把三个子项**当孤儿提到了根**，侧边栏凭空多出三条顶层菜单
- **`.env.example` 和 `cli.py` 是靠精确字符串耦合的**。`setup_env_file()` 用
  `env_content.replace("DATABASE_PORT=1433", …)` 这种字面量替换填用户的输入 ——
  改了模板里的默认值、`cli.py` 那边没跟着改，替换会**静默不生效**：
  `fba init` 一路问完、写出的 `.env` 里还是模板的旧值，报错要等到连数据库时才出现。
  改模板后跑一遍对账（9 处 replace + 1 处 `TOKEN_SECRET_KEY` 正则）
- 记录操作日志的请求/响应头时，`OPERA_LOG_REDACT_HEADERS` 里的字段必须打码 ——
  否则操作日志表本身会变成凭据泄露面
- 登录失败必须记日志。异常分支要捕获 `errors.BaseExceptionError` 并把
  `BackgroundTask` 挂到**原异常**上再 `raise`（不要包成 `RequestError`，会改掉状态码）
- **socket.io 的命名空间是 `/` 而不是 `/ws`**。`AsyncServer(namespaces=['/ws'])` 极具误导性：
  那个参数只是「额外接受哪些命名空间」，而 `@sio.event` 注册的 connect/disconnect
  处理器绑在**默认命名空间**上。客户端连 `io(base + '/ws')` 会握手成功、日志里也是
  `WebSocket /ws/socket.io/... [accepted]`，但**处理器一行都不执行** ——
  `fba:token_online` 一个都不写，「在线用户」页全是离线。
  正确写法：`io(API_BASE, { path: '/ws/socket.io' })`（路径带 `/ws`，命名空间不带）。
  实测：连 `/` 时 `SCARD fba:token_online` = 1，连 `/ws` 时 = 0
- **`UploadFile.filename` 是攻击面，不是文件名**。Starlette 原样透传
  Content-Disposition 里的值、不做任何过滤，拿它拼 `UPLOAD_DIR / filename`
  就是任意文件写入（`filename=../../../../../x.png` 实测写到了仓库根，接口还返回 200）。
  一律先过 `utils/file_ops.py: strip_path()`，落盘名走 `build_filename()`
  （随机后缀，不复用原名做唯一性）。
  ⚠️ `/static/upload` 是**无鉴权**静态挂载 —— 上传物对任何人可读，
  只靠文件名不可猜兜着。要真正的访问控制得改成带鉴权的下载接口

## 部门与角色的编码（稳定引用键）

`sys_dept.code` / `sys_role.code` 是 2026-08-22 加的。**加它的理由不是「别人都有」**，
而是这套数据本来没有任何一个「跨环境稳定 + 人可读 + 能写进配置」的键：

| 候选 | 为什么不行 |
|---|---|
| 名字 | 管理员在界面上随时能改。硬编码它，改个名字业务逻辑就静默不走 |
| 雪花 ID | 每套环境不同。种子里那串 `2048601263515500544` 只在这份种子里成立 |

上游 FBA 没有这两列（菜单靠 `perms`、字典靠 `code`、配置靠 `key`，**凡是被代码
引用的表都有编码，只有这两张没有** —— 因为它们此前只被界面引用）。

四条约定：

- **格式是 `^[A-Z][A-Z0-9_]*$` + 2–32 位**，定义在 `common/schema.py: CustomCode`，
  前端 zod 各有一份同样的正则（那份只为当场报错，**后端才是权威**）。
  限大写是因为编码和中文名同排显示，混排就分不出哪个是标识；
  首字符限字母是为了排除「纯数字编码」—— 那种一旦在某处被 `Number()` 掉不会被发现（同硬纪律 6）
- 🔴 **`code` 创建后不可改，靠「`UpdateDeptParam` / `UpdateRoleParam` 里没有这个字段」实现**，
  不是靠前端禁用输入框。改编码会让所有引用方静默指向空（不报错，只是查不到），
  所以这道门要在契约上就关掉。要换编码就删了重建
- 🔴 **部门名称的唯一性从「全局」改成了「同级」。** 原来是 `(name, deleted)` 全局唯一，
  于是整棵树里只能有一个「测试组」—— 而「技术中心/测试组」和「质量中心/测试组」
  在真实组织里是常态，第二个建不出来、报的还是「部门名称已存在」。
  现在库上只有 `(code, deleted)` 唯一，同级重名由 `dept_service` 拦
  （`get_sibling_by_name`）。**刻意不建库约束**：`parent_id` 可空，而各方言对
  「唯一索引里的 NULL」语义相反（SQL Server 认为多个 NULL 相等、MySQL/PG 认为互不相等），
  建了只会得到一条在某一种库上生效、在另一种上静默失效的约束。
  ⚠️ 更新时要按**目标**父级判：只挪了上级、名字没动，一样可能撞到新兄弟
- 角色的 `(name, deleted)` 全局唯一**保留** —— 角色是平的，没有层级，全局唯一是对的

列表接口都收 `code` 入参，且**大小写归一**（`code.upper()`），所以 `?code=fin`
命中 `FIN`。部门页有独立的编码筛选框；角色页没有（一共几条，编码在每行里都显示着），
这是**取舍不是遗漏**。

> 存量行的编码推不出来（中文名推不出真实编码），开发库和 `fba_test` 是按 id 序
> 回填的占位码（`DEPT_0001` / `ROLE_0001`）。真要用的话得人工改一遍 —— 但改不动，
> 见上面那条。这批占位码要换只能删了重建。

## 还没发版 —— 可以自由重构

**0.0.1 还没发布，没有线上实例、没有要保的数据、没有外部调用方。**
所以不要为「兼容」让设计将就：

- **表结构直接改模型**。没有 alembic 迁移历史（`versions/` 是空的），schema 由
  `MappedBase.metadata.create_all()` 从模型生成。开发库上要么手写一条 `ALTER`，
  要么用 `cli.py` 的 drop_all + create_all 重建
- **删字段就真删**，不要留「休眠字段」。留着的下一个人会以为它有用（`sys_menu.cache`
  就骗过一轮：字段在、界面上没有、行为不变）
- **改接口不用留旧字段**。`schema.d.ts` 是 `pnpm gen:api` 生成的，跟着后端走
- **和上游 FBA 冲突是可以接受的代价**。永久分叉是既定事实（见「fork 管理」），
  为了 cherry-pick 方便而保留用不上的结构，是把成本永久摊给自己

> ⚠️ 改模型后**表结构不会跟着变**：`--reload` 只是重启进程重新 import 模型，
> 不会去动数据库里已经建好的表。新增/删除列仍要手写 `ALTER` 或 drop_all + create_all，
> 否则新进程一样会 SELECT 不存在的列 —— reload 让人以为「已经生效了」，这是新的坑。
> 改了字段也要同步 `backend/sql/*/init_*_test_data.sql` —— 那些 INSERT 是显式列名的，
> 漏改会让全新环境初始化失败。

## 已经删掉的东西，不要照上游加回来

`sys_menu` 的两列已从**模型、DTO、种子 SQL 和数据库**里彻底删除：

| 列 | 上游的用途 | 为什么这里不需要 |
|---|---|---|
| `component` | Vue 运行时动态路由的组件路径 | 前端是编译期文件路由，`page-registry.tsx` 按 routeId 挂载 |
| `cache` | Vben `<KeepAlive>` 的 per-page 开关 | `TabOutlet` 用 `<Activity>` 一律保活，没有 per-page 概念 |

侧边栏也不再下发 `meta.keepAlive`（`utils/build_tree.py`）。

> 想给某一页关掉保活时**不要复活这个字段**，直接在 `TabOutlet` 里判断。
> 另外记住 `update` 走 `model_dump(exclude_unset=True)`：前端不传的字段不会被写 ——
> 这条在「前端删字段」时是好事（不会静默重置老数据），但要归一老值就得显式传一次。

## fork 管理

上游明确拒绝合并 SQL Server 支持，永久分叉是既定事实。
基线记在 `apps/api/.upstream-baseline`，只 cherry-pick 上游安全补丁，功能更新不跟。

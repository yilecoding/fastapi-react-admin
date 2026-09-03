# apps/mobile/src/app —— 屏与路由（expo-router）

> 这份文件是 [`apps/mobile` 分册](../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载它。

目录即路由（expo-router 的约定式路由）。两棵**互斥**的树：
`login`（未登录）和 `(app)`（已登录），由 `_layout.tsx` 的 `AuthGate` 按会话状态挂载 —— 为什么用「渲染哪一棵树」而不是跳转，见 [`apps/mobile` 分册](../../AGENTS.md) 的鉴权一节。

## 导航壳：Stack 套 Tabs

```
(app)/_layout.tsx            Stack —— 外层，非 tab 的屏推在这里
(app)/(tabs)/_layout.tsx     Tabs —— 首页 · 应用 · 我的
(app)/(tabs)/index.tsx       首页
(app)/(tabs)/apps.tsx        应用
(app)/(tabs)/profile.tsx     个人中心
(app)/notifications.tsx      通知      ┐ 推在 tab 之上：
(app)/profile/edit.tsx       编辑资料  │ 天然带返回键、盖住 tab 栏
(app)/profile/password.tsx   修改密码  │
(app)/users/index.tsx        用户列表  │ ← 分页列表的范式样板
(app)/users/[id].tsx         用户详情  ┘ ← 详情 + 写操作的范式样板
```

⚠️ 动态段在 `(app)/_layout.tsx` 里注册时，`name` 用的是**文件名**
（`users/[id]`），不是拼好的路径。

🔴 **tabs 必须套在一层 Stack 里，不能让 `(app)` 直接是 Tabs。**
`(tabs)/` 下每多一个文件就自动多一个 tab，所以通知、编辑资料这类屏没地方放。
用 `options={{ href: null }}` 藏得掉，但那样它**仍在 tab 导航器内 ——
没有返回键、标题也要自己接**。这条踩过一次：通知屏一加就变成第 4 个 tab。

⚠️ 三个 tab 都关掉了 Tabs 自己的 header（`headerShown: false`）：它们各自有品牌头
或自定义筛选条，再叠一条系统标题栏会很挤。

⚠️ tab 的选中色**只能从令牌取**（`useCSSVariable('--color-primary')`）——
`tabBar*TintColor` 是原生组件的 prop，不吃 `className`；写死一个 hex 的话
深浅色主题里必然有一头是错的。

## 个人中心：哪些字段能改，哪些不能（不是漏做）

| 字段 | 能不能自己改 | 走哪个口 |
|---|---|---|
| 昵称 | ✅ | `PUT /sys/users/me/nickname` |
| 头像 | ✅ 但**只能填 URL** | `PUT /sys/users/me/avatar` |
| 密码 | ✅ | `PUT /sys/users/me/password` |
| 时区 | ✅ | `PUT /sys/users/me/timezone`，并 `setDisplayTimeZone()` |
| **手机号** | ❌ | 后端**没有** `/me/phone`，只有超管的 `PUT /sys/users/{pk}` |
| **邮箱** | ❌ | `PUT /me/email` 要一个**邮件验证码**，那条链路移动端还没有 |

界面上手机号/邮箱是只读行并写明原因 —— 放一个改了会失败的输入框更糟。

🔴 **头像清空要发 `null`，不能发 `''`。** 读取侧 `GetUserInfoDetail.avatar` 是
`HttpUrl | None`，存进空串之后登录和 `/users/me` 会**全部 422**
（`url_parsing: input is empty`），连改坏它的人自己都登不回来。后端那个 handler
上就记着这次实测。

⚠️ 从相册选头像还没做 —— 要 `expo-image-picker`（Expo Go 自带）+ 文件上传接口，
是独立一件事。

### `is_staff` 这道闸门**不影响**个人中心

`rbac.py` 那条「非 GET/OPTIONS 且 `is_staff` 为假 → 403」挂在 **`DependsRBAC`** 上，
而 `/sys/users/me/*` 全部只挂 `DependsJwtAuth`。所以普通用户（`is_staff=False`）
改自己的昵称/头像/密码**不会 403**。
（真正会撞上这道闸门的是将来那些管理类的写操作。）

## 设置：外观 · 时区 · 服务器地址

```
(app)/settings.tsx    设置总屏（外观单选 + 两个入口 + 关于）
(app)/server.tsx      服务器地址
(app)/timezone.tsx    显示时区
src/lib/appearance.ts 深浅色偏好（本机）
src/lib/server.ts     服务器地址（本机，运行时可改）
```

### 🔴 主题色只有一份：`global.css`，导航主题从它现读

`react-native-reusables` 的脚手架在 `src/lib/theme.ts` 里带了**一整套自己的
zinc 色板**（`hsl(0 0% 100%)` / `hsl(0 0% 3.9%)` …）和一个 `NAV_THEME` 派生。
那套值**和 `src/styles/global.css` 里真正生效的令牌不是一回事** ——
我们的页面底色是 iOS 分组灰 `#f4f2fa`（深色 `#000000`），导航拿到的是纯白
（深色 `#0a0a0a`）。

症状：**push / pop 动画期间闪一下白**（深色下闪一下不够黑的灰）。
静态截图完全看不出来 —— 停下来之后每屏都自己画了 `bg-background`，
只有转场那几百毫秒里露出的是导航容器的底色。

修法**不是把 hex 抄对**（那就有了两份真相、web 改色时静默偏离），
而是 `useNavTheme()` 用 `useCSSVariable` 现读 —— 和 `bg-background` 同源。

⚠️ `useCSSVariable` 的签名是 `<const T extends Array<string>>(names: T)`，
约束是**可变**数组：给名字数组加 `as const` 会编译不过
（`readonly [...] cannot be assigned to string[]`）。

同一条也适用于 `app.json`：splash 的 `backgroundColor` 和 `expo.backgroundColor`
原来是 `#ffffff` / 品牌紫，和任何一屏都不一样，已改成页面底色。

### 🔴 原生 splash 要自己压住，否则首帧是白屏

`fontsReady` / `i18nReady` 之前是 `return null`，而原生 splash
**默认在 JS bundle 一加载完就自己隐藏** —— 冷启动看到的是
「图标闪一下 → 白屏一会儿 → 界面」。`expo-splash-screen` 一直装着、
`app.json` 里也配了插件，但**从来没有人 import 它**，那两行 API 从没被调用过。

```ts
void SplashScreen.preventAutoHideAsync().catch(() => {})   // 模块作用域
React.useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => {}) }, [ready])
```

🔴 **压住 splash 之后，「永远不 ready」的后果变严重了。** 原来是白屏，
现在是**启动画面永远不结束** —— 看起来是卡死，连错都看不到。所以字体和 i18n
都要 **fail-open**：`fontsReady || fontError !== null`，`setupI18n()` 用
`.catch(() => {}).finally(() => setReady(true))`。
字体回落成系统字只是丑一点；`t()` 原样返回 key 而 key 就是中文原文，界面仍可用。

### CI 必须真的打一次移动端包

`pnpm typecheck --force` 挡不住移动端那一类失败 —— 实测踩过的三个都是
**tsc 全绿、bundle 才炸或才静默失效**：

| 实测过的 | 表现 |
|---|---|
| `global.css` 少 `@source` | 每个 className 成空操作，**不报错** |
| `babel-preset-expo` 没进 devDependencies | Metro 解析不到（19 分钟后才报） |
| uniwind 令牌 light/dark 数量不一致 | 那批颜色隐形，`expo export` **仍返回成功** |

所以 `apps/mobile` 有了 `build` 脚本（`expo export --platform android`），
CI 的 static job 里跟在 `web build` 后面跑一条。

### 🔴 服务器地址必须是**运行时**的，不能是编译期常量

`EXPO_PUBLIC_*` 是**构建期替换的字符串** —— 打成 APK 之后地址就焊死了，
想在生产/预发/本机之间切只能重新打包。所以地址存 SecureStore，
`src/lib/api.ts` 把 `serverStore.current` 作为 `getBaseUrl` 注进客户端，
**每次请求现取**。

⚠️ 共享客户端里有一条同源的坑：`openapi-fetch` 会在 `createClient` 时把
`baseUrl` 固化，所以地址是走**每请求覆盖**传下去的 ——
细节见 [`packages/api` 分册](../../../../packages/api/AGENTS.md)。写错的表现是
「设置屏改完地址、请求还发去旧地址，且不报错」。

⚠️ `src/lib/config.ts` 里那个 `API_BASE_DEFAULT` 只是**默认值**，
**不要 import 它去发请求**。

🔴 **冷启动的顺序不能换**：先 `serverStore.hydrate()` 再 `tokenStore.hydrate()` ——
反了的话第一个请求打的是编译期默认地址。

🔴 **保存前要先探一次那个地址**（打 `/auth/captcha`，无需鉴权、一定存在，
并检查响应里有 `code` 字段来确认这确实是 FBA 后端）。存一个打不通的地址进去，
下一个动作是「登录失败」——那个报错**完全不提是地址错了**，用户会一直去试账号密码。

🔴 **保存成功要登出。** token 是跟着服务器发的，换了服务器旧 token 一定无效，
而那个失败会表现成「莫名其妙 401」。

### ⚠️ uniwind 自己不持久化主题

`Uniwind.setTheme()` 只改当前会话，重启就回到跟随系统。所以偏好自己存，
`src/app/_layout.tsx` 冷启动喂回去。「跟随系统」存的是**删除那个键**，
不是存一个具体值 —— 存了 `'light'` 之后系统切深色它就不跟了。

### ⚠️ 时区给列表，不给输入框

后端入参是 `IanaTimeZone`、会校验，随手传个拼错的名字 422。而**手输时区名是最容易
打错的那类字段**，存进一个拼错的值会让那个用户所有带时间的页面白屏
（后端 handler 上记着这次实测）。

列表是**常用项不是全集**，所以「账号上的时区不在列表里」要单独显示出来 ——
否则用户看到一个都没选中，会以为设置丢了。

### 🔴 选了时区还得**喂给 datetime 层**，否则是个空转开关

这个设置曾经**完整地什么都没做**：设置屏能选、能存、`/me` 里也回来了，
但界面上每个时间仍按**设备**时区渲染 —— 一个「设置好了但什么都没变」的开关，
而且没有任何错误现象。

漏的是这一句（web 端在 `packages/platform/src/auth/queries.ts` 的 meQuery 里）：

```ts
setDisplayTimeZone(me.timezone)   // 拿到 /me 就调，登出传 null 归位
```

现在收在 `session.tsx` 的 `applyUser()` / `applyAnonymous()` 里。
⚠️ **登出必须归位**，否则换账号登进来还带着上一个账号的时区。

### 时间的解析和格式化一律用 `@admin/i18n` 的 `datetime`

`src/lib/datetime.ts` 只剩「相对时间」那十行文案，解析走 `toEpochMs()`、
兜底日期走 `dateKey()`。**不要自己 `new Date(iso)`**：后端下发的时间戳有两种
形态（实测同一个接口里就混着 `…Z` 和 `…+08:00`），而 ES 规范对不带时区标记的串
按本地时区解释、空格分隔的那种规范里压根没定义。抄一份必漏，
而漏掉的表现是**时间差 8 小时**、不报错。

⚠️ **Hermes 的 Intl 是部分实现**：`Collator` / `DateTimeFormat` / `NumberFormat`
有，**`RelativeTimeFormat` 没有**（缺了是静默回落）。所以相对时间那几句自己写。
`DateTimeFormat`（`dateKey` / `formatDateTime` 用的那个）是安全的 ——
RN 在两端都硬编译了 `-DHERMES_ENABLE_INTL=True`
（`ReactAndroid/hermes-engine/build.gradle.kts:358`，注释是
"We intentionally build Hermes with Intl support only"）。

## 通知：接的是 `plugin/notification`，但**没有实时推送**

```
src/lib/notifications.tsx      UnreadProvider —— 未读数，tab 红点的唯一来源
src/app/(app)/notifications.tsx 列表：全部 / 未读 · 点一条标已读 · 全部已读
```

🔴 **刻意没接 socket.io。** web 端靠 `packages/platform/src/shell/use-presence.ts`
收 `notification_new` 事件实时刷新；移动端这一版用「进入页面 + 下拉刷新」代替。
理由是长连接在移动端要处理的东西完全不同（切后台被系统掐、蜂窝网切换、省电策略），
那是独立一件事，不该顺手塞进来。**所以红点不是实时的，界面上也不要暗示它是。**

契约上两个容易错的点：

- `read_time` **有值即已读**，而它**不是数据库列** —— 是 service 在分页之后按
  `sys_notification_read` 回填的。别指望拿它做服务端筛选，筛未读要用 `?unread=true`
- `unread-count` 的 `by_category` 的 key 是**分类数值的字符串形式**（`'0'`/`'1'`/`'2'`），
  不是名字

⚠️ `link` 字段是**web 的前端路由**（`/profile`、`/plugins/notice` 这种），
移动端没有对应页面，所以现在只展示不跳。哪天移动端页面多了再做映射。

⚠️ 标记已读是**幂等**的（重复标记返回 0 行也算成功），所以列表用了乐观更新、
失败也不回滚 —— 下一次刷新自然会纠正。

## 权限：`usePerm()`，而门控天生会把错误伪装成缺失

```
src/lib/perm.ts               usePerm() —— /auth/codes + can / canAny / canWrite
src/app/(app)/(tabs)/apps.tsx 「应用」：按权限码列模块，三种「空」分开
```

权限码来自 `GET /auth/codes`（登录后一次，形如 `sys:user:add`）。
在 `lib/perm.ts` 之前移动端**完全没有权限概念** —— `CurrentUser` 里只有
`roles: string[]`，那是角色**名字**不是码，不能拿来判断。

### 🔴 `known` 这一位是必须的（硬纪律 9 的权限形态）

`can()` 返回 false 的原因有**两个**：真没权限 / 权限码没问上。界面上长得一样，
而后者会让**所有入口消失** —— 用户看到的是「一个功能不存在的 App」。

所以 `usePerm()` 除了 `can` 还给 `known`（= `isSuccess || isSuperuser`）和 `error`，
调用方**先看 `known`，再看 `can()`**。和未读数那次是同一个物种
（`lib/notifications.tsx` 里记着）：**「不知道」不等于「没有」。**

⚠️ 错误只在**一处**兜（「应用」那一屏）—— 首页的用户入口和详情页的删除按钮都是
「`known` 为假就不出现」，不重复报一遍。三个屏各弹一次同一个错更糟。

### 🔴 写操作用 `canWrite()`，不是 `can()`

`common/security/rbac.py` 的闸门**有顺序**，逐条读过：

| 顺序 | 判断 |
|---|---|
| 1 | `is_superuser` → **直接放行**，后面全跳过 |
| 2 | 有没有启用的角色（否则 403 `role_locked`） |
| 3 | 角色有没有挂菜单（否则 403 `menu_not_assigned`） |
| 4 | **非 GET/OPTIONS 且 `is_staff` 为假 → 403** ← 权限码还没开始校验 |
| 5 | 权限码在不在已分配菜单里 |

第 4 道是新建账号最容易撞的：`is_staff` 默认 False，而 `AddUserParam` 里
**根本没有这个字段**。症状是「能登录、能看列表、所有写操作 403」，
而三条 403 的文案都不提移动端。`canWrite()` = `isSuperuser || (isStaff && can(...))`，
把这道闸门算进去 —— 界面上就不会出现一个点了必然 403 的按钮。

## 用户模块：列表 → 详情 → 删除（**范式样板**）

```
(app)/users/index.tsx   分页列表：useInfiniteQuery + FlatList + 防抖搜索 + 五个状态
(app)/users/[id].tsx    详情 + 删除（确认框 + toast）
src/lib/users.ts        取数（列表 / 详情 / 删除 mutation）
src/lib/debounce.ts     useDebounced —— 延后「值」，不是延后「请求」
```

挑用户这个模块没有业务含义，挑的是它的**形状**。字典、部门、公告要抄的就是这一份。

### 🔴 列表要 `useInfiniteQuery` + `FlatList`，不是「一个大 size + map()」

通知那一屏是 `size: 50` 一次拉完 + `ScrollView` + `map()`。那个形状在几十条以内
看不出问题，**照抄到上千条的列表上就废了**（首屏等全量、内存里挂上千个 View、
滚动掉帧）。移动端的列表既然不能是表格，它就必须是「一条条 + 翻到底继续拉」。

两个容易写错的地方：

- 🔴 翻页终点用 `page < total_pages`，**不要用 `items.length < size`** ——
  后者在「最后一页刚好装满」时会多请求一次空页。FBA 的 `PageData` 直接给了 `total_pages`
- 🔴 `onEndReached` 一次滚动里会被调多次，**必须看 `hasNextPage && !isFetchingNextPage`**，
  否则会连发几页

✅ **实测（Android，真机验收）**：滚到底自动拉下一页、没有连发。

### 🔴 五个状态，缺一个都会变成「这 App 坏了」

| 状态 | 长什么样 |
|---|---|
| 首屏加载 | 骨架屏 |
| **首屏失败** | 占位错误块 + 重试 |
| 空（没筛选） | 「还没有用户」 |
| 空（**筛了**） | 「没有匹配」+ 提示改条件 —— 和上一条**必须分开**，筛出空白时用户第一反应是「搜坏了」 |
| **翻页失败** | 列表**底部**一条错误 + 重试。⚠️ 最容易漏 —— 前面的数据是好的，不能把整屏换成错误块 |
| **下拉刷新失败** | `toast.error` |

🔴 **「翻页失败」用 `isFetchNextPageError`，不要用 `isError && items !== null`。**
后者会把**下拉刷新失败**也算进来 —— 列表底部冒出一句「加载更多失败」，
而用户刚做的动作是下拉。文案指着一个他没做过的操作，比不报还难懂。
TanStack Query v5 把这两件事分开了。

🔴 **下拉刷新失败走 toast**，因为它是这一屏唯一**没有位置可占**的失败：
列表内容还在（上一次的数据，仍然可读），换成错误块反而丢内容。
不报的话下拉一下什么都没变，看起来像「刷新了但没有新数据」。

### 🔴 筛选条件进 key 之后要 `placeholderData`，否则每次搜索列表整块闪成骨架屏

条件进 key 换来「每套条件一份缓存 + 没有竞态」，代价是**新 key 没有数据** ——
`items === null`，屏上从「一列用户」跳成「五条骨架」再跳回来。功能没错，
但那个闪动读起来像「列表被清空了」。`placeholderData: (prev) => prev` 保留上一套。

⚠️ **代价必须一起处理**：占位期间 `data` 是**上一套条件**的，所以
`hasNextPage` / 页码说的也是上一套 —— `onEndReached` 必须加
`&& !q.isPlaceholderData`，否则会把两套结果串起来。
占位期间要给个信号（转圈），否则看起来像「搜了但没反应」。

### 🔴 搜索要防抖「值」，不要自己 setTimeout 发请求

延后值之后它进的是 query key（`usersKey.list(filter)`）—— 每套条件一份缓存，
没有「后到的请求赢」这种竞态，退回上一个关键词还是秒开。
自己管 timer 发请求等于把竞态搬到自己手里。
⚠️ 输入框显示的是**未延后**的值，否则每敲一个字要等 300ms 才看到字符。

### 🔴 自己不能删自己 —— 后端**没有**这道守卫

`user_service.delete` 读过了：查到就删，然后 `delete_by_prefix` 掉该用户的
access / refresh / 用户缓存三组 key。所以删自己会**成功**，然后当前会话立刻失效、
被弹回登录屏 —— 看起来像「App 把我踢了」。这道守卫只能在客户端做。

⚠️ 判据比 `id` 且两边都 `String()`：`id` 在 schema 里是 `string | number`，
路由参数一定是字符串，不统一的话 `===` 永远为假、守卫**静默失效**。

### 🔴 删除后**只失效列表那一层**，不要 `invalidate(['users'])`，也不要 `removeQueries`

删除是从**详情屏**发起的，而那一屏此刻还挂着 `useUser(id)`（`router.back()` 是
紧接着才发生的）。往 `['users']` 上失效会连带命中 `['users','detail',id]` ——
那个查询有活跃观察者，于是它会去**重新请求一个刚刚被删掉的 ID**：
白打一个必然 404 的请求，还可能在屏 pop 之前闪一下「这个用户不存在」。
`removeQueries` 是同一个形状（移除后观察者重新取）。

失效 `['users','list']` 就够了：详情那份缓存随屏卸载后自然回收，
而它已经不可能被点到 —— 列表里没有这条了。

### 🔴 删除接口在「删了 0 行」时是 `HTTP 200 + code: 400`

`resolveEnvelope` 会判成失败并抛 —— 所以不要写成「走到这儿就是成了」。
而且「删了 0 行」在三个方言下**不是同一件事**（MySQL 数变更行，
PostgreSQL / SQL Server 数匹配行），别拿这个接口的返回当「记录存在与否」的判据。

## 🔴 typed routes 那份声明是 `expo start` 生成的，`expo export` **不生成**

`.expo/types/router.d.ts` 给 `router.push()` 提供路由字面量的联合类型。
它是**生成产物且在 `.gitignore` 里**，两个后果都要知道：

| | |
|---|---|
| 本地加了新屏 | `pnpm typecheck` 对着一份**过期**的声明报错（`Argument of type '"/users"' is not assignable…`）。**实测 `expo export` 不会刷新它** —— 要跑一次 `expo start`（约 4 秒就写好了，然后可以 kill） |
| CI | `.expo/` 不在版本库里 → **那份声明压根不存在** → `Href` 退化成宽松类型，**路由写错 CI 抓不到** |

所以路由字面量的正确性**只有本地 typecheck 才保得住**，而它依赖一个手动步骤。
加屏之后跑一次 dev server 再 typecheck。

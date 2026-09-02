# apps/mobile —— 移动端原生 App（issue #39 的 **C 路线**）

> **路线已定：C（RN 原生 UI），不是 B（WebView 套现有 web）。**
> 定这一条的理由不是技术偏好：移动端的交互逻辑是全新的一套，
> **列表不能是表格**。B 路线的前提是「复用 PC 端渲染」，而那个前提在移动端不成立 ——
> 所以 B 那半天的验收（浏览器代答五条、注入 token 免登录…）连同 `react-native-webview`
> 一起删掉了，git 历史里还能翻到。
>
> 现在的状态：**登录 + 个人中心 + 一个最小导航壳**。issue #39 的第 2/3 条
> （要哪几个屏 / 导航形态）还没拍，所以壳是刻意做小的，见下面「导航壳」一节。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 读到本目录下的文件时才加载它。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 起服务

```bash
docker start fba_mssql fba_redis     # 前置：数据库 + Redis
pnpm --filter api dev                # 前置：后端 :8088

pnpm mobile:dev                      # = node scripts/dev.mjs，打印一个地址，去 Expo Go 里填
```

`scripts/dev.mjs` 不是随手包的一层 —— 直接跑 `expo start` 有**四处会静默地不对**：

| 它替你做的事 | 不做会怎样 |
|---|---|
| 算出一个**真能连的地址**，用 `EXPO_PACKAGER_HOSTNAME` 钉住 | Metro 从网卡列表里挑一个 **docker bridge**（这台机器有 8 个）打印成 `exp://172.24.0.1:8800` —— 在 WSL 里、在 NAT 后面、还是 docker 内部网桥，三重不可达 |
| 注入 `EXPO_PUBLIC_API_BASE` | App 打的后端地址和 Metro 的不是一回事，写死哪个都会错一半 —— 表现是 App 起得来、所有请求 `Network request failed`，看着像后端挂了 |
| 端口固定 **8800** + 被占时**直接报 pid 退出** | Expo 默认 8081 太容易撞，撞了它**默默漂到 8082** —— 打印的地址就是错的，「地址看着有、就是不通」比连不上难查得多 |
| 自己去 `~/Android/sdk` 找 `adb` | 这台机器的 shell 里 `ANDROID_HOME` 没设、`adb` 不在 PATH 上，涉及设备的分支全都静默走不到 |

🔴 **它刻意不自动追加 `--android`。** 试过，是个坏设计：设备刚开机时 package 服务
还没起（`cmd: Can't find service: package`），`--android` 会让 expo **整个进程退出** ——
一个瞬时的设备状态变成了「dev server 起不来」。

`start:plain` 是不带这层的原始 `expo start`，排查这层本身有没有问题时用。

⚠️ **它没有 `dev` 脚本，这是刻意的。** 根 `pnpm dev` 是 `turbo dev`，按**脚本名**
匹配 —— 叫 `dev` 就会被一起拉起来，而 Expo 要占端口、要交互式选设备，会把那个 TUI
搅乱。照 `apps/desktop` 的先例走独立入口（`start` / `android` / `ios`）。

## 技术选型：uniwind，不是 nativewind

| | |
|---|---|
| 底座 | [`react-native-reusables`](https://github.com/founded-labs/react-native-reusables) 的 `minimal-uniwind` 模板（shadcn 的 RN 对应物） |
| 样式 | **uniwind** —— Tailwind **v4** 在 RN 上的实现 |
| 路由 | Expo Router（文件路由，根目录是 `src/app`） |

🔴 **不要换成 nativewind。** `nativewind@4.2.6` 的 `react-native-css-interop@0.2.6`
peer 写死 `tailwindcss: "~3"` —— 而本仓库 `packages/ui` 是 Tailwind **v4**
（`@theme inline` + oklch）。选 nativewind 等于在同一个仓库里维护两套 Tailwind 大版本，
设计令牌就没有唯一真相源了。

## 版本：SDK 57，跟 Expo Go 的商店版本对齐

`react-native-reusables` 的 `minimal-uniwind` 模板给的是 **SDK 56**，
底座一开始就是照抄那一组（被测过的组合），两条实测和登录/个人中心都是在 56 上验的。

**2026-09-02 升到了 57**，理由不是「追新」：

🔴 **Expo Go 一个客户端只支持一个 SDK，而且两个版本包名相同
（`host.exp.exponent`），装不了两份。** 它把整套原生运行时（RN 核心、Hermes、
所有自带原生模块的编译产物）打进了 APK —— 同时支持两个 SDK 等于塞两套运行时，
Expo 早期这么干过，后来砍掉了。

于是钉在 56 就意味着：手动装旧 APK，**而且 Play 商店每次自动更新都会把它顶回最新**，
得一直手动压着。升一次一劳永逸。

实测报错长这样（是 Expo Go 拿到 manifest 读到 `sdkVersion` 之后才报的，
所以**看到它反而说明网络那条链已经通了**）：

    Project is incompatible with this version of Expo Go
    • The installed version of Expo Go is for SDK 57.
    • The project you opened uses SDK 56.

升级前先核了 SDK 57 的自带清单，我们用到的原生模块**一个都不缺**
（reanimated 4.5.1 / worklets 0.10.1 / screens ~4.26.0 / svg 15.15.4 /
gesture-handler ~2.32.0 / safe-area-context ~5.7.0 / expo-router ~57.0.18 /
expo-secure-store ~57.0.3），所以「Expo Go 就能跑、不用 prebuild」那条豁免还在。

🔴 **改任何一个 RN 生态依赖后跑 `npx expo install --check`。**
实测抓到过：模板写 `react-native-screens: 4.25.2`，但 pnpm 把 `expo` 解到
`56.0.21`，那个补丁版把 screens 提到了 `~4.26.0`。**`--check` 是唯一会说话的地方** ——
打包、typecheck、Expo Go 启动全都不报。升级用 `npx expo install --fix` 一次对齐。

⚠️ 升级会往 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里追加一串条目 ——
那是本仓库的供应链新鲜度闸门，`expo install` 会自动给新版本放行。**要读一眼再提交**，
别当成无关噪音。

## 🔴 `@/*` 指向 `src/`，而 `global.css` 也必须在 `src/` 下

模板的 `@/*` 是指向**项目根**的，`global.css` 放根目录。本仓库统一 `src/` 布局，
所以 `@/*` → `./src/*` —— 那一改之后 `import '@/global.css'` 当场解析失败：

    Unable to resolve module @/global.css from src/app/_layout.tsx

现在是 `src/styles/global.css`（对齐 `packages/ui/src/styles/globals.css`），
**三处必须同时改，漏一处的表现都不长得像路径问题**：

| 改哪里 | 漏了的表现 |
|---|---|
| `src/app/_layout.tsx` 的 import | 打包直接失败（响亮，好排） |
| `metro.config.js` 的 `cssEntryFile` | 🔴 **打包成功，但所有 `className` 静默失效** —— 编译的是一个不存在的入口 |
| `components.json` 里 `tailwind` → `css` 那个字段 | rnr CLI 后续 `add` 组件时写错文件 |

## 🔴 `tsconfig.json` 不能有 `baseUrl`，且要补一条 `*.css` 声明

两条都是 tsc 直接报错、不静默，但都会卡住第一次 typecheck：

- `baseUrl` 在 **TS 6 已弃用**（`error TS5101`）。`paths` 用相对写法即可（`"./src/*"`）
- `import '@/styles/global.css'` 报 `TS2882` —— uniwind 1.11.0 的
  `uniwind/types` **没有**声明 `.css` 模块。本目录 `src/types.d.ts` 补了一条

## 🔴 Metro：不要抄 Expo monorepo 指南那份配方

`metro.config.js` 里 resolver 全默认，只有 `watchFolders` 一行（外加 uniwind 的包装）。
官方那份 `disableHierarchicalLookup: true` + `nodeModulesPaths` 是针对 Yarn / npm
**提升式布局**的，在 pnpm 上直接把构建打死。

**做过对照实验**（同一个工程、同一次 `expo export --platform android`）：

| 配置 | 结果 |
|---|---|
| 只有 `watchFolders`（现在这份） | ✅ 打包成功 |
| 加上官方那两条 | 🔴 **第 1 个模块就失败**：`Unable to resolve module expo-modules-core from …/node_modules/expo/src/Expo.ts` |

注意失败点：炸的**不是**某个 workspace 包，是 `expo` 自己。好消息是这个失败很响；
坏消息是**报错里没有一个字提到这份配置** —— 看着像「依赖装坏了」，
很容易去反复 `pnpm install` 或删 node_modules 重装。

顺带一个对 C 路线关键的结论：**`@admin/i18n` 在 Metro 侧解析没有任何问题**
（连它私有的 `i18next` 一起）。所以「能不能 import workspace 包」这一步不存在障碍，
障碍在**运行时**（`packages/i18n` 里那个没守卫的 `document`、以及 Hermes 的 Intl 行为）。

## 只出 ios / android，不出 web

`app.json` 里写了 `"platforms": ["ios", "android"]`，`react-native-web` / `react-dom`
**都没装**。不限制的话按 `w` 会去解析没装的包，打出一句

    Unable to resolve "react-native-web/dist/exports/ActivityIndicator"

—— 它和真正要排的问题毫无关系，但会混在同一屏日志里，白排查一轮。实测踩过。

## 🔴 `src/styles/global.css` 里那条 `@source` 不能省

**这是这一轮踩到的最贵的一个坑，而它是纯静默的。**

症状：App 正常跑起来、Metro 不报任何错、`expo export` 打包成功、uniwind 的组件包装
也确实进了 bundle —— 但**每一个 `className` 都是空操作**。界面上所有间距、颜色、
尺寸全丢，色块因为 `h-16` 没生效而直接不占位、整块消失。看起来像「uniwind 没接上」，
于是会去查 metro 配置、查 babel、查版本 —— 全是白工。

根因：Tailwind v4 的自动源码探测以**那个 CSS 文件所在目录**为根。这份文件在
`src/styles/` 下（对齐 `packages/ui/src/styles/globals.css` 的布局），而那个目录里
一个组件都没有 → **一条工具类都不生成**。模板原本把 `global.css` 放在项目根，
所以模板自己不会撞上；是「搬进 `src/`」这个决定引入的。

判据（最省事的一条）：从 dev server 抓 bundle，数几个最普通的工具类在不在。

```bash
curl -s "http://127.0.0.1:8800/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&minify=false" \
  -o /tmp/dev.bundle
grep -c '"flex-1"' /tmp/dev.bundle      # 0 = 一条都没生成；正常是 ≥1
```

实测数据（同一个工程，只差 `@source` 一行）：

| | `flex-1` | `p-4` | `gap-6` | `h-16` | 界面 |
|---|---|---|---|---|---|
| 没有 `@source` | 0 | 0 | 0 | 0 | 全裸，色块消失 |
| 加上 `@source` | 2 | 2 | 2 | 2 | 正常 |

和根 `CLAUDE.md` **硬纪律 7** 是同一个物种（「class 在、CSS 规则不在」），
也和 `packages/ui/src/styles/globals.css` 里那两条 `@source` 一致。

## 🔬 两条实测的结论（探针页已删，结论留在这儿）

两条都在 WSL 里的 Android 模拟器上跑完了，**结论都是「行」**。
探针页在写登录屏时删掉了，下面是它测出来的东西。

### ✅ 1. uniwind 认 `oklch()` —— 设计令牌可以和 web 共享一份真相源

探针是三对色块：每对左边写 `oklch(...)`、右边写它**离线算出的精确 sRGB 等价值**。
`adb exec-out screencap` 截图后逐像素比对：

| 探针 | oklch 侧 | sRGB 侧 | 两侧最大通道差 | 与离线期望差 |
|---|---|---|---|---|
| `oklch(0.62 0.19 250)` | `#0088F2` | `#0088F2` | **0** | **0** |
| `oklch(0.72 0.19 145)` | `#43C251` | `#43C251` | **0** | **0** |
| `oklch(0.65 0.24 20)` | `#FF2C4D` | `#FF2C4D` | **0** | **0** |

**逐位相同** —— uniwind 在构建期就把 oklch 精确转成了 sRGB
（`expo export` 出来的 `.hbc` 里也没有字面的 `oklch(` 颜色值，两边印证）。
所以移动端**不需要**为颜色维护第二份定义。

### ✅ 2. RN 的 `fetch` 读得到 `set-cookie`，cookie jar 也会自动回传 —— 后端不用改

`POST /api/v1/auth/login` 的响应头，RN 侧完整可见：

```
headers: content-length, content-type, date, server, set-cookie, x-request-id
set-cookie: fba_refresh_token=eyJ…; expires=…; HttpOnly; Max-Age=604800; Path=/; SameSite=lax
```

🔴 **注意这和浏览器的差别**：浏览器里 `set-cookie` 是禁止读取的响应头，
`HttpOnly` 的值 JS 绝对拿不到。RN（Android 侧是 okhttp）**给得到，连 `HttpOnly`
的原始值一起**。写鉴权代码时不要按浏览器的直觉推断。

第二半更关键：`POST /api/v1/auth/refresh` **不带任何头**（它只读 refresh cookie）
→ **200**，并下发了一个新的 refresh token（`expires` 递增、token 值不同，轮转生效）。
说明 **RN 自带 cookie jar 并自动回传**。

两条推论：

- **后端不用为移动端改刷新链路**，现有 httpOnly cookie 那套直接可用
- `apps/desktop/src/main/auth.ts` 那套「读 Set-Cookie → 自己存 → 手工带 Cookie 头」
  在 RN 上是**多余的**，不要照搬过来

⚠️ 顺带核到一件事：**本机 dev 的 `LOGIN_CAPTCHA_ENABLED` 也是 `false`**
（`/auth/captcha` 返回 `is_enabled=false`），不只是生产。所以探针的「取验证码 → 
去 redis 取答案」那两步实际上验不到验证码链路 —— 要验得先把那条 `sys_config` 改回 true。

## 鉴权：token 在 SecureStore，refresh 在 cookie jar

```
src/lib/token-store.ts   access token —— expo-secure-store（Keystore / Keychain）
src/lib/api.ts           fetch 包装：拆 {code,msg,data} 包封 · 401 单飞刷新
src/lib/session.tsx      SessionProvider：冷启动 / 登录 / 登出，唯一的登录态真相源
src/app/_layout.tsx      AuthGate：按登录态挂载两棵互斥的路由树
```

🔴 **access token 必须进 `expo-secure-store`，不能进 `AsyncStorage`。**
AsyncStorage 在 Android 上就是一个明文 SQLite 文件、iOS 上是明文 plist ——
root / 越狱设备直接可读，备份也会带走。这条**和 web 端不一样**：web 上 token 在
`sessionStorage`，关掉标签页就没了；App 会长期驻留，落盘的东西要当长期资产看。

🔴 **refresh token 不要自己管。** 它在 httpOnly cookie 里，RN 自带 cookie jar
（Android 侧是 okhttp 的 `CookieManager`）会自动带上。
**不要照搬 `apps/desktop/src/main/auth.ts` 那套「读 Set-Cookie → 自己存 →
手工带 Cookie 头」** —— 在 RN 上那是多余的第二份状态，两份不同步的失败是静默的
（刷新"成功"了但用的是旧 token）。

✅ **cookie jar 跨 App 冷启动是持久的**（实测：头一天探针登录留下的 refresh
cookie，隔夜 + 多次 `am force-stop` + 重装 bundle 之后，冷启动仍然刷新成功）。
所以「SecureStore 里没有 token」不等于「没登录」—— 冷启动流程是
**先无条件打 `/me`**，401 由 api 层单飞刷新兜住，刷不动才判定未登录。

🔴 **`AuthGate` 用「渲染哪一棵树」切换登录态，不要用 `router.replace` 跳转。**
在 effect 里跳转会有一帧渲染出已登录的界面（`user` 还是 `null`，各处崩或闪），
而且返回键能退回去。现在两棵树用 `Stack.Protected` 互斥挂载，
未登录时登录屏之外的路由**根本不存在**，没有中间态可漏。

⚠️ **`bootstrapError`：401 和「连不上」必须分开。** 都当成「没登录」的话，
用户看到一个登录屏、输对密码还是失败，而屏上没有任何东西说是网络不通
（根 `CLAUDE.md` 硬纪律 9 的移动端形态）。非 401 的启动失败会带到登录屏上显示。

### 改密码之后会话就死了，要主动收场

`user_service.update_password` 会 `delete_by_prefix` 掉该用户的
access / refresh / 用户缓存**三组** key。不主动登出的话，用户会在下一个请求 401 时
被莫名其妙弹回登录页 —— 看起来像 bug，其实是预期行为。
所以 `src/app/(app)/profile/password.tsx` 成功后切到一屏「密码已修改，请重新登录」，明说一句再登出。

## 个人中心：哪些字段能改，哪些不能（不是漏做）

| 字段 | 能不能自己改 | 走哪个口 |
|---|---|---|
| 昵称 | ✅ | `PUT /sys/users/me/nickname` |
| 头像 | ✅ 但**只能填 URL** | `PUT /sys/users/me/avatar` |
| 密码 | ✅ | `PUT /sys/users/me/password` |
| 时区 | ✅（界面还没做） | `PUT /sys/users/me/timezone` |
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

## 导航壳：Stack 套 Tabs

```
(app)/_layout.tsx            Stack —— 外层，非 tab 的屏推在这里
(app)/(tabs)/_layout.tsx     Tabs —— 首页 · 应用 · 我的
(app)/(tabs)/index.tsx       首页
(app)/(tabs)/apps.tsx        应用
(app)/(tabs)/profile.tsx     个人中心
(app)/notifications.tsx      通知      ┐ 推在 tab 之上：
(app)/profile/edit.tsx       编辑资料  │ 天然带返回键、盖住 tab 栏
(app)/profile/password.tsx   修改密码  ┘
```

🔴 **tabs 必须套在一层 Stack 里，不能让 `(app)` 直接是 Tabs。**
`(tabs)/` 下每多一个文件就自动多一个 tab，所以通知、编辑资料这类屏没地方放。
用 `options={{ href: null }}` 藏得掉，但那样它**仍在 tab 导航器内 ——
没有返回键、标题也要自己接**。这条踩过一次：通知屏一加就变成第 4 个 tab。

⚠️ 三个 tab 都关掉了 Tabs 自己的 header（`headerShown: false`）：它们各自有品牌头
或自定义筛选条，再叠一条系统标题栏会很挤。

⚠️ tab 的选中色**只能从令牌取**（`useCSSVariable('--color-primary')`）——
`tabBar*TintColor` 是原生组件的 prop，不吃 `className`；写死一个 hex 的话
深浅色主题里必然有一头是错的。

## 设计令牌：抄自 `packages/ui`，不是模板那套中性灰

`src/styles/global.css` 里的颜色是从 `packages/ui/src/styles/globals.css`
**逐值抄过来**的，包括品牌紫 `--color-primary: oklch(0.457 0.24 277.023)`。
rnr 模板给的是一套全无彩度的中性灰（`oklch(0.205 0 0)` 那种），照着跑出来
一眼就是"模板感"。

抄而不是 import：那份 CSS 里有 `@custom-variant`、shadcn 的 tailwind 预设、字体包
一堆 web-only 的东西，而 `apps/mobile` 也不在 `i18n ← ui ← platform ← apps/web`
那条依赖箭头上。**能直接抄是因为实测确认 uniwind 在构建期精确转换 `oklch()`**
（见上面「两条实测的结论」）—— 否则这里得维护第二份降级成 sRGB 的颜色。

⚠️ **web 改了主题色，这里要跟着改**，不会自己报错。

🔴 **深色模式的 `--border` / `--input` 是唯一一处刻意和 web 不同的令牌。**
web 上它们是 `oklch(1 0 0 / 10%)`（带透明度的白）；RN 里半透明边框叠在深色卡片上
**看不见**（卡片本身就比背景亮），所以换成了实色。

### 品牌图形

`src/components/tenon-mark.tsx` 是 `apps/web/src/components/tenon-mark.tsx` 的
RN 版，**路径逐字一致**。⚠️ web 那份用 `currentColor` 上色，`react-native-svg`
**不认 `currentColor`**（没有 CSS 继承），所以颜色走 `color` prop 显式传。

图标由 `scripts/gen-brand-icons.mjs` 生成（`pnpm brand:icons`），**不要手放图**。
移动端那三张的形状要求各不相同，不能拿同一张糊过去：

| 文件 | 形状 | 为什么 |
|---|---|---|
| `icon.png` | 满幅方形、**不透明** | iOS 自己会圆角裁切；给带透明圆角的图，那几个角在 iOS 上会变成**黑色** |
| `adaptive-icon.png` | **透明底、墨迹缩到安全区内** | Android 用系统蒙版裁这张前景层，外圈约 1/3 一定被切掉；底色在 `app.json` 的 `adaptiveIcon.backgroundColor` 给 |
| `splash.png` | 圆形徽章、透明底 | 配 `app.json` 里的浅/深背景色 |

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

## 契约是手抄的：`src/lib/contract.ts`

web 端的类型是 `pnpm gen:api` 从 OpenAPI 生成的，但那份产物住在
`packages/platform` 里，而 `apps/mobile` 不在 `i18n ← ui ← platform ← apps/web`
那条箭头上。所以移动端这份是**手抄**的。

🔴 **改后端契约时这份要跟着改** —— 它不会自己报错，字段对不上只会在运行时变成
`undefined`（表现为界面上某一项空着，不报错）。

两个抄的时候容易错的点，已经在文件里标了：

- `GET /sys/users/me` 用的是 `GetCurrentUserInfoWithRelationDetail`，
  它把 `dept` 换成了**部门名字**、`roles` 换成了**角色名字列表**（不是对象）
- `POST /auth/login` 的响应体里**没有 refresh token**，它只在 Set-Cookie 里；
  而且响应里的 `user` 是 `GetUserInfoDetail`，**没有 dept/roles 名字** ——
  所以登录成功后要再打一次 `/me` 才拿得到个人中心要显示的东西

## 🔴 占位符颜色只能走 `placeholderTextColor`

Tailwind 的 `placeholder:*` 是 CSS 伪元素变体，RN 里没有这个概念 ——
写了不报错也不生效。不给的话各 Android 版本的默认占位色不一样，深色主题下经常
糊成一片看不见，而这**不会报任何错**。`components/ui/input.tsx` 用
`useCSSVariable('--color-muted-foreground')` 取值再传给这个 prop。

## 设备：用**宿主机（Windows）侧**的 Expo Go，不要在 WSL 里跑模拟器

🔴 **WSL 内的 Android 模拟器这条路已经放弃了，不要再往回走。**
它能跑通（两条实测就是在上面跑的），但兼容性代价太高，实测踩到的：

| 症状 | 真因 |
|---|---|
| `libpulse.so.0: cannot open shared object file` | 系统缺库，`-no-audio` 不管用（链接期就死） |
| `ProbeKVM: This user doesn't have permissions` | 不在 `kvm` 组 → 只能 `-accel off`，开机 9 分钟 |
| `no Qt platform plugin could be initialized` | 非交互 shell 里 `DISPLAY` 是空的；设了又只有 `xcb` 插件、没有 `wayland` |
| `screencap` 超时 / 画面全黑 | 软件 GPU 下 SurfaceFlinger 僵死，换 `-gpu guest` 也一样 |
| 装的 App 每次开机都没了 | AVD 的 `disk.dataPartition.path = <temp>`，数据分区是临时的 |
| `pm` / `dumpsys` 返回**空输出**而不是报错 | 机器太慢，「没装」和「服务还没起」长得一模一样 |

每一条都能修，但加起来是一条**长期不稳的验证链路**，而且和被测代码毫无关系。

### 两条外部路径

`scripts/dev.mjs` 会按情况打印**一个**地址，照着填就行。

**① 宿主机（Windows）上的模拟器 —— 现在就能用**

```bash
pnpm --filter api dev:host        # 🔴 后端要绑 0.0.0.0，不是默认的 dev
pnpm mobile:dev                   # 打印 exp://<WSL的eth0>:8800
```

地址用 **WSL 自己的 eth0 地址**（脚本自动探），Windows 侧的模拟器能直接路由到 ——
AVD 是 NAT 在 Windows 后面的，由 Windows 替它路由到 `vEthernet (WSL)`。

🔴 **不要用 `10.0.2.2`，在这台机器上它不通。** 那个别名指向**宿主机的 loopback**，
要靠 WSL2 的 `localhostForwarding` 把 Windows 的 localhost 转进 WSL —— **实测没转**
（Windows 侧的适配器名是 `vEthernet (WSL (Hyper-V firewall))`，Hyper-V 防火墙介入了）。

症状很有迷惑性：Expo Go 报 `Packager is not running at http://10.0.2.2:8800`，
而同一时刻在 WSL 里 `curl 127.0.0.1:8800/status` 是好的 —— 看着像 Metro 没起来。

**最省事的判据**：在模拟器的浏览器里开这两个，看哪个出 `packager-status:running`：

```
http://10.0.2.2:8800/status
http://<WSL的eth0>:8800/status      # ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+'
```

浏览器测比 Expo Go 干净 —— 只验网络，不掺 SDK / bundle / manifest。

🔴 **用 WSL 的 IP 就必须 `pnpm --filter api dev:host`。**
`pnpm --filter api dev` 绑的是 `127.0.0.1`，从 eth0 那个地址打不进去，而这个失败
**要到你在 App 里点登录时才现形**（`Network request failed`，看着像后端挂了）。
`scripts/dev.mjs` 现在会**主动探一下**后端在选定地址上通不通，直接把结论打出来 ——
不是打一句警告完事。

⚠️ 绑 `0.0.0.0` 在这里**不等于暴露到局域网** —— WSL2 是 NAT 的，只有 Windows 宿主
够得着（这正是当初否掉 mirrored / portproxy 想保住的性质）。

⚠️ eth0 地址**每次 WSL 重启都会变**，所以脚本每次现探，不要写死到任何配置里。

**换地址**：`MOBILE_HOST=<地址> pnpm mobile:dev`

| 地址 | 什么时候用 |
|---|---|
| WSL 的 eth0 地址 | **默认**，标准 AVD 走这个 |
| `10.0.2.2` | 换台机器 localhostForwarding 是好的，或第三方模拟器路由不到 WSL 网段 |
| `127.0.0.1` | USB 真机 / WSL 内设备，配 `adb reverse`。脚本检测到本地设备时自动选 |

不要用 Windows 的局域网地址（`ipconfig` 里 Wi-Fi 那个）—— Windows 上没有进程
监听 8800，要让它转发就得 `netsh portproxy`，那条已经被否掉了。

⚠️ **Expo Go 一个客户端只支持一个 SDK。** 工程是 SDK 57，手机/模拟器上装的
Expo Go 也得是 57（`https://expo.dev/go` 下，或用 `~/.expo/android-apk-cache/`
里 expo 自己下好的那份）。版本不对的表现是一屏「出错了」，不提 SDK 两个字。

### ❌ 局域网那三条解法仍然不能用

| 解法 | 为什么 |
|---|---|
| `expo start --tunnel`（ngrok） | 隧道端点被墙，`CommandError: failed to start tunnel`。所以**刻意不装 `@expo/ngrok`** |
| `.wslconfig` 的 `networkingMode=mirrored` | 🔴 会把 WSL 里监听 `0.0.0.0` 的服务一起暴露到局域网 —— 这台机器上跑着 `fba_mssql`（1433）和 `fba_redis`（6380）。**已被否掉，不要再提议** |
| `netsh interface portproxy` | 同理，显式往局域网开口。**已被否掉** |

上面两条外部路径都**不碰局域网**：走的都是「宿主机 loopback + WSL2 自带的
localhostForwarding」，只有这台 Windows 自己够得着。

## 品牌图标还是模板的占位图

`assets/images/` 下三张是 rnr 模板自带的占位图。
唯一真相源是 `scripts/gen-brand-icons.mjs`（见根 `CLAUDE.md`），
但它现在只出 favicon 和桌面端图标，**还没有 Android/iOS 那套尺寸**。
要换的时候扩那个脚本，**不要手放图**。

## 没有 lint，这是暂时的

模板不带任何 eslint 配置。**不要顺手用 `expo lint` / 装 `eslint-config-expo` 补** ——
它会经 `eslint-import-resolver-typescript` 拖进带 postinstall 的 `unrs-resolver`，
而 pnpm 11 对未放行的 build script 是 **exit 1 不是警告**，要同时改
`pnpm-workspace.yaml` 的 `allowBuilds`。真要补的时候一起做。

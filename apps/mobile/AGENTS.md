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
pnpm mobile:dev                                        # = expo start
EXPO_PUBLIC_API_BASE=http://10.0.2.2:8088 pnpm mobile:dev
```

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

## 版本：跟模板的 SDK 56，不是自己挑最新

`package.json` 里的版本**整组抄 `minimal-uniwind` 模板**（SDK 56 / RN 0.85.3 /
React 19.2.3），不是逐个挑最新的。理由：这是**被测过的组合**；
uniwind + reanimated 4 + worklets + expo-router 之间的版本约束不写在任何一处，
偏离它的失败长得像随机的运行时错误。

之前那个 WebView spike 是 SDK 57，掉头时**降到 56** —— 模板还没跟上 57。

🔴 **改任何一个 RN 生态依赖后跑 `npx expo install --check`。**
实测抓到一个：模板写 `react-native-screens: 4.25.2`，但 pnpm 把 `expo` 解到
`56.0.21`，那个补丁版把 screens 提到了 `~4.26.0`。**`--check` 是唯一会说话的地方** ——
打包、typecheck、Expo Go 启动全都不报。

## Expo Go 还能用：uniwind 是纯 JS

核过了：`uniwind@1.11.0` 的 npm 包里**没有 android / ios 目录、没有 podspec、
也没有 expo-module 声明文件** —— 它是 Metro transformer + babel 层的东西，
把 `global.css` 交给 Tailwind v4 自己的引擎编译，产物转成 RN 样式。**没有原生代码。**

其余带原生代码的依赖逐个核过 expo 包自带的 bundledNativeModules 清单（SDK 56），
全都在清单里 —— 在清单里就意味着 Expo Go 自带：

| 包 | 清单里的版本 |
|---|---|
| `react-native-reanimated` | 4.3.1 |
| `react-native-worklets` | 0.8.3 |
| `react-native-screens` | ~4.26.0 |
| `react-native-svg` | 15.15.4 |
| `react-native-gesture-handler` | ~2.31.1 |
| `react-native-safe-area-context` | ~5.7.0 |
| `expo-router` | ~56.2.20 |

**所以现在还不用 `expo prebuild`、不用碰 pnpm 的 `nodeLinker: hoisted`**（那是个
**整仓**开关，会连带影响 web 与 desktop 的依赖隔离）。

⚠️ 一旦需要一个 Expo Go 不带的原生模块（扫码、静默打印…），这条豁免就没了。
那时候再评估 hoisted 的代价，**别提前付**。

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
curl -s "http://127.0.0.1:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&minify=false" \
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
所以 `change-password.tsx` 成功后切到一屏「密码已修改，请重新登录」，明说一句再登出。

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

## 导航壳：`src/app/(app)/_layout.tsx` 是唯一的换形态点

issue #39 第 3 条（底部 tab / 抽屉 / 栈怎么组合）还没拍，所以现在是一个**最小 Stack**。
换形态时**只动那一个文件**：`Stack` → `Tabs`，下面的屏一行都不用改（它们只是
文件路由里的叶子）。

⚠️ `expo-router` 的 `Tabs` 要额外装 `@react-navigation/bottom-tabs` ——
它**不在** Expo Go 自带模块清单里，但那是纯 JS 包，装了就能用，不需要 prebuild。

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

## 设备：WSL 里的 Android 模拟器（**不往局域网开任何口**）

Metro 和 dev API 都只绑 `127.0.0.1`，靠 **`adb reverse`** 把端口隧道进设备，
全程留在 WSL 内部、**不往局域网开任何口**：

```bash
adb reverse tcp:8081 tcp:8081     # Metro（expo start --localhost 会自己设）
adb reverse tcp:8088 tcp:8088     # dev API（要自己设）
```

🔴 **不要用 `10.0.2.2`。** 那条「模拟器里 `10.0.2.2` 就是宿主 loopback」的经典说法
**在这台机器上实测不成立**：

    adb shell ping -c2 10.0.2.2  →  connect: Network is unreachable
    adb shell ip route           →  （空）

这个 emulator 的网络后端没提供那个别名。表现在 App 里是
`java.net.ConnectException: Failed to connect to /10.0.2.2:8088` ——
响亮但指向错误的方向（看着像后端没起）。而且 `10.0.2.2` 本来就只对模拟器成立，
真机没有等价物；`adb reverse` 两边都通，所以直接统一用它。

### ❌ 真机 + 三条常规解法，在这台机器上都不能用

**实测现场**：Metro 打印 `Metro: exp://172.24.0.1:8081`，扫码后 Expo Go 停在一屏
「出错了。对此表示歉意。」—— 那是它拉不到 bundle 时的通用错误页，**不提网络两个字**。

`172.24.0.1` 是本机一个 **Docker bridge**。这台机器上有 8 个 docker bridge
（`172.18`–`172.24`）加 `docker0`，Metro 从网卡列表里挑了其中一个。那个地址
**三重不可达**：在 WSL 里、在 NAT 后面、而且是 docker 内部网桥。

| 解法 | 为什么不能用 |
|---|---|
| `expo start --tunnel`（ngrok） | **实测起不来**：`CommandError: failed to start tunnel / session closed`。ngrok 的隧道端点被墙（`connect.ngrok-agent.com` curl 返回 `000`；`status.ngrok.com` 返回 200 只是因为它托管在 Atlassian）。所以**刻意不提供 `start:tunnel` 脚本、也不装 `@expo/ngrok`** |
| `.wslconfig` 的 `networkingMode=mirrored` | 🔴 **会把 WSL 里监听 `0.0.0.0` 的服务一起暴露到局域网** —— 这台机器上跑着 `fba_mssql`（1433）和 `fba_redis`（6380）。**已被否掉，不要再提议** |
| `netsh interface portproxy` | 同理，是显式往局域网开一个口；还要管理员权限，WSL 的 eth0 地址每次重启还会变 |

另外：**Expo Go 一个客户端只支持一个 SDK**（实测手机上是
`54.0.8 / Supported SDK 54`，工程是 56，加载不了）。走模拟器时
`expo start --android` 会**自动装匹配版本的 Expo Go**，这个问题顺带就没了。

### 装模拟器踩的两个坑

**① `libpulse.so.0` 缺失，报错完全不提音频。**
`emulator` 进程正常启动、日志一切正常，然后：

    qemu-system-x86_64: error while loading shared libraries:
    libpulse.so.0: cannot open shared object file

`-no-audio` **不管用** —— 动态链接在 `main()` 之前就失败了。
不需要动系统：deb 解到本地目录、`LD_LIBRARY_PATH` 指过去即可
（`libpulse0` 会连带拖出 `libsndfile1` → 7 个音频编解码库）。

**② `/dev/kvm` 存在 ≠ 有权限用。** 根 `CLAUDE.md` 之前只核了「文件在不在」，
不够 —— 还要在 `kvm` 组里：

    ProbeKVM: This user doesn't have permissions to use KVM (/dev/kvm).

这一条**必须 root**：`sudo gpasswd -a $USER kvm`。加完组不用重启 WSL，
用 `sg kvm -c '<命令>'` 就能在当前会话里拿到新组。

**没有 KVM 也能跑**（`-accel off`，纯 TCG 软件模拟），这一轮两条实测就是这么跑完的。
代价是慢一个量级，实测量级：开机 ~9 分钟 · Expo Go 安装 ~3 分钟 ·
首次 bundle 后到画面出来 ~2 分钟。

**③ 必须 `-no-window`。** 带窗口跑会死在
`no Qt platform plugin could be initialized`（WSLg 下 emulator 自带的 Qt 起不来）。
headless 反而更顺手：截图走 `adb exec-out screencap -p`，能直接逐像素比对。

**④ 慢机器上 ANR 弹窗会挡住整屏。** 实测撞到 `Digital Wellbeing isn't responding`
和 `System UI isn't responding` 两次，都盖在 App 上面 —— 截图看起来像 App 挂了。
一次性关掉：

```bash
adb shell settings put global hide_error_dialogs 1
```

**⑤ 🔴 慢机器上 `pm` / `dumpsys` 会返回空输出而不是报错。**
`adb install` 报了 `Failure calling service package: Broken pipe`（真失败），
但紧接着 `pm list packages | grep exponent` 返回空、`dumpsys package` 也返回空 ——
**「没装」和「包服务当时忙」长得一模一样**，我据此下过一个错判断。
可靠的判据是 `pm path <包名>` 拿到路径 **且** `cmd package resolve-activity --brief <包名>`
解析出 activity；只满足前者说明是半装状态，要 `pm uninstall` 再装。

装法上：200MB 的 APK 在 TCG 上别走 `adb install` 的流式协议，
`adb push` 到 `/data/local/tmp/` 再 `adb shell pm install` 稳得多。

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

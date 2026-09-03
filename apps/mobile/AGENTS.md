# apps/mobile —— 移动端原生 App（issue #39 的 **C 路线**）

> **路线已定：C（RN 原生 UI），不是 B（WebView 套现有 web）。**
> 定这一条的理由不是技术偏好：移动端的交互逻辑是全新的一套，
> **列表不能是表格**。B 路线的前提是「复用 PC 端渲染」，而那个前提在移动端不成立 ——
> 所以 B 那半天的验收（浏览器代答五条、注入 token 免登录…）连同 `react-native-webview`
> 一起删掉了，git 历史里还能翻到。
>
> 现在的状态：**登录 + 个人中心 + 一个最小导航壳，一个业务屏都还没有**。
> #39 已关闭（三件事里路线和导航形态都定了），**还开着的只有「要哪几个业务屏」→ #96**
> —— 所以首页的「待办与动态」和「应用」整屏是刻意留空的（空态文案里就写着在等什么）。
> 导航形态已定：**Stack 套 Tabs**，见 [`src/app/` 分册](src/app/AGENTS.md) 的「导航壳」一节。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 读到本目录下的文件时才加载它。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 按任务导航

这份文件只放**跨整个 app 的东西**（选型 · 版本 · 构建管线 · 鉴权 · i18n · 取数 · 契约）。
按目录拆出去的三份是**按需加载**的 —— Claude Code 读到那个目录下的文件时会自动带上：

| 我要… | 读 |
|---|---|
| 起服务 / 连真机 / 打 APK | [`scripts/` 分册](scripts/AGENTS.md) |
| 加屏 / 动导航 / 动设置 · 通知 · 个人中心 | [`src/app/` 分册](src/app/AGENTS.md) |
| 挑组件 / 动样式 / 动主题令牌 | [`src/components/` 分册](src/components/AGENTS.md) |
| 动请求 / 契约 / 错误判定 | 本文件的「契约」一节 + [`packages/api` 分册](../../packages/api/AGENTS.md) |

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
src/lib/api.ts           `@admin/api` 的一次实例化（传输层不在这儿，见下）
src/lib/session.tsx      SessionProvider：冷启动 / 登录 / 登出，唯一的登录态真相源
src/app/_layout.tsx      AuthGate：按登录态挂载两棵互斥的路由树
```

🔴 **传输层不在 `apps/mobile` 里。** 信封判定、401 单飞刷新、`Accept-Language`
全在 `@admin/api` 的 `createApiClient()`，**和 web 端共用一份**；`src/lib/api.ts`
只注入四样东西（地址 / token / 语言 / 网络错误文案）。
**要改重试或错误判定去改那个包**（[分册](../../packages/api/AGENTS.md)）——
这份文件曾经自己复制过一遍，代价是「HTTP 200 + `code: 400` 被当成成功」
那个坑两端各有一份，改一边不修另一边。

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

## i18n：复用 `@admin/i18n`，接线层在 `src/lib/i18n.ts`

语言包、i18next 实例、校验脚本都在 `packages/i18n`（最底层、**框架无关**，
连 `react-i18next` 都不依赖）。移动端和 `apps/web/src/i18n.ts` 对称，
只挂 React 绑定和副作用。

🔴 **依赖箭头写进了 `apps/mobile/package.json`**（`@admin/i18n: workspace:*`），
不是只靠 Metro 能解析 —— 根 `CLAUDE.md` 结构那一节的硬纪律。

### 为此改动了 `packages/i18n`（两处，都是 web-only 的东西）

| | 原来 | 现在 |
|---|---|---|
| `notify()` 里 `document.documentElement.lang = lang` | 🔴 RN **没有 `document`**，移动端一初始化就抛 | 挪到 `apps/web/src/i18n.ts` 的 `onLanguageChange` 订阅里 —— 和那个包自己写的「副作用由上层注册」是同一条规则，当初漏了这处 |
| `initI18n(plugins)` 只从 `localStorage` 读初值 | RN 没有 `localStorage`，`readStoredLanguage()` 走 catch **恒定返回基准语言**（不报错，但永远读不到用户的选择） | 加了第二个参数 `initialLanguage`，移动端传自己异步读出来的值 |

⚠️ **以后往 `packages/i18n` 里加东西，先问一句「RN 上有这个 API 吗」。**

### 移动端这一侧

- 语言存 `expo-secure-store`；没选过就取**设备语言**
- ⚠️ `getLocales()[0]` 可能是 `zh-Hant-TW` / `en-GB` 这种带地区的标签，
  而我们只有两个语言。**按语言主段落匹配**，别拿完整标签比 ——
  那样 `en-GB` 会被判成「不支持」然后给一个中文界面
- 🔴 `Accept-Language` **必须跟界面语言同步**（`api.ts` 从 `currentLanguage()` 取）。
  之前写死 `'zh-CN'`：切成英文界面之后接口报错还是中文，看起来像坏了
- 🔴 i18n 和字体一样**卡住首帧**（`_layout` 里 `!i18nReady` 直接 `return null`）。
  忘了注入 `initReactI18next` 的后果很隐蔽：`useTranslation()` 会绑到
  react-i18next **自己的默认实例**上，那个实例没有 resources，`t()` 原样返回 key ——
  界面看起来「全是中文」（因为 key 就是中文），连 `{{n}}` 插值都不做

### 写文案的两条

🔴 **模块级常量里放 key，不要在定义处 `t()`。** 那是 import 时求值的 ——
切语言不会变，而且求值时 i18n 可能还没初始化完。
`APPEARANCE_LABEL` / `ZONES[].label` / `METHODS[].label` /
`NOTIFICATION_CATEGORY` / `greeting()` / `accountKind()` 全是这个形态，
一律在使用处 `t(常量)`。

🔴 **局部变量不要叫 `t`。** `src/lib/datetime.ts` 里有个时间戳原来叫 `t`，
把导入的 `t()` 遮住了 —— 这正是 `i18n:check` 的 `shadowed-t` 规则要抓的东西
（tsc 也会报 `Type 'Number' has no call signatures`，算是响亮）。

⚠️ **语言名本身不翻译** —— 「English」在中文界面里也要显示 English，
否则用户找不到自己那一项。这是少数刻意不 `t()` 的地方。

`apps/mobile/src` 已经加进 `packages/i18n/src/scripts/check.mjs` 的 `SRC_ROOTS`，
`pnpm i18n:check` 会一起校验（`missing-keys` 是硬失败）。

## 取数层：`@tanstack/react-query`（`src/lib/query.tsx`）

加它的动机很具体 —— **三个修过的 bug 是同一个根因**：每屏自己写
`useEffect` + `useState` 取数。

| 修过的 bug | 手写取数的哪一面 |
|---|---|
| 通知页切页签的竞态（慢的那个后到会赢，选了未读却混着已读） | 没有请求版本管理 —— 筛选条件进 query key 就没有这回事 |
| 未读数「不知道 vs 是 0」被混成一个，「全部已读」永久禁用 | 没有 `status` / `error` 的区分，只有一个 `T \| null` |
| 3 条 `react-hooks/set-state-in-effect` | effect 里同步置 loading 态 |

三处都换掉之后 lint 的那 3 条警告归零，所以那条规则**已经恢复成 `error`**
（和 `apps/web` 一致）—— 再出现就说明有人又在 effect 里手写取数了。

🔴 **硬纪律 10（有限流的接口必须做单飞）现在由 query 层给。**
`/auth/captcha` 是 5 次/30 秒，而 StrictMode 开发期把 effect 跑两遍。
React Query 对同一个 key 的并发请求天然去重 —— 那就是单飞，
手写的 `inFlight` ref + `alive` ref 都可以退了。

### ⚠️ 不引入 `@react-native-community/netinfo`

官方 RN 集成用它接 `onlineManager`（离线时不重试）。**那是原生模块，
Expo Go 里没有** —— 装了本仓库赖以调试的那条路就断了
（见 [`scripts/` 分册](scripts/AGENTS.md) 的设备一节）。
所以只接 `focusManager` 那一半，它走 `AppState`、纯 JS：

```ts
AppState.addEventListener('change', (s) => focusManager.setFocused(s === 'active'))
```

🔴 **不接这一句的话 `refetchOnWindowFocus` 是静默无效的** ——
web 上它监听 `visibilitychange`，RN 没有那个事件。

代价是「离线时不重试」这个优化没有：请求照常失败、照常显示错误态，不影响正确性。

### 🔴 401 / 403 / 429 / 422 不重试

401 的收尾在 `@admin/api` 的客户端里（单飞刷新 → 刷不回来就判会话结束 →
弹回登录屏）。query 层再重试只会多打几个必然失败的请求，
还会把「弹回登录屏」推迟几秒。429 同理：重试就是拿限流配额换一次必然的失败。

### 会话引导刻意**不**走 query 层

`src/lib/session.tsx` 的冷启动那一段仍然是手写的 effect，三个理由：
它决定**挂哪一棵路由树**（跑在任何屏渲染之前）· 必须按顺序 hydrate 两个
SecureStore（地址再 token，顺序不能换）· 要把 401 和「连不上」分开。
**query 层管「数据」，那一段管「会话存不存在」，不要合并。**

⚠️ `QueryProvider` 要在 `SessionProvider` **外面**：`useUnread()` 这类查询
按 `useSession()` 的状态 `enabled`，所以 session 是它的输入。

## 契约不再手抄：类型从 `schema.d.ts` 推出来

🔴 **移动端用的是严类型面** —— 路径、查询参数名、请求体、返回字段全部由
`@admin/api` 从 `schema.d.ts` 推出来，**写错就是编译错误**：

```ts
const me = await api.GET('/api/v1/sys/users/me')            // me.nickname 有类型
await api.PUT('/api/v1/sys/notifications/{pk}/read', { params: { path: { pk: n.id } } })
await api.GET('/api/v1/sys/notifications', { params: { query: { page: 1, size: 50 } } })
```

⚠️ **web 端还在松类型面上**（三条结构性障碍，见
[`packages/api` 分册](../../packages/api/AGENTS.md)）—— 所以别照 `packages/platform`
里的 `api.GET<T>()` 写法抄到这边。

`src/lib/contract.ts` 曾经是一整份**手抄本**（十几个 DTO、上百个字段），
字段名对不上不会报错、只在运行时变 `undefined`（界面上空一格）。
现在只剩三个别名，而且都指向 `components['schemas'][...]`，
留着**只为组件 props 要写类型**（`NotifRow` 收一条 `Notification`）。
原来的 `LoginResult` / `Captcha` / `PageData` 全部因为推断变成死代码 —— eslint 抓出来的。

两个仍然要知道的契约细节：

- `GET /sys/users/me` 用的是 `GetCurrentUserInfoWithRelationDetail`，
  它把 `dept` 换成了**部门名字**、`roles` 换成了**角色名字列表**（不是对象）。
  要完整对象得走 `GET /sys/users/{pk}/roles`
- `POST /auth/login` 的响应体里**没有 refresh token**，它只在 Set-Cookie 里；
  而且响应里的 `user` 是 `GetUserInfoDetail`，**没有 dept/roles 名字** ——
  所以登录成功后要再打一次 `/me` 才拿得到个人中心要显示的东西

🔴 **查询参数不要用条件展开**：`...(cond ? { unread: true } : {})` 里的属性
**绕过 TS 的多余属性检查**（实测：`unreadd` 经展开 0 错误，直接写 1 错误）。
该省的传 `undefined`。

## 品牌图标还是模板的占位图

`assets/images/` 下三张是 rnr 模板自带的占位图。
唯一真相源是 `scripts/gen-brand-icons.mjs`（见根 `CLAUDE.md`），
但它现在只出 favicon 和桌面端图标，**还没有 Android/iOS 那套尺寸**。
要换的时候扩那个脚本，**不要手放图**。

## lint：照 `apps/web` 抄，**不用 `eslint-config-expo`**

`pnpm --filter @admin/mobile lint`（CI 的 eslint job 里跟在 web 后面）。

🔴 **不要用 `expo lint` / 装 `eslint-config-expo`** —— 它会经
`eslint-import-resolver-typescript` 拖进带 postinstall 的 `unrs-resolver`，
而 pnpm 11 对未放行的 build script 是 **exit 1 不是警告**，要同时改
`pnpm-workspace.yaml` 的 `allowBuilds`。为一套 lint 规则放行一个原生编译的
postinstall 不划算，我们真正要的只有 `react-hooks`。

三条和 web 那份不同的地方，都是踩出来的：

| | 为什么 |
|---|---|
| 文件名 `eslint.config.**mjs**` | RN 的 `package.json` **不能加 `type: "module"`**（`metro.config.js` / `babel.config.js` 是 CommonJS，加了当场坏）。`.js` 配置会先按 CJS 解析失败再重解析成 ESM，并打 MODULE_TYPELESS_PACKAGE_JSON 警告 |
| `globals` 要 **^17** | `react-native` 那个预设**在 v17 才有**。装到 v16 的话 59 个 RN 全局量全没了，`languageOptions.globals` 收到 `undefined` 直接 `Expected an object` 报错 |
| `react-hooks/set-state-in-effect` 降 `warn` | web 走 TanStack Query、压根没有「effect 里取数」这种代码；移动端**没有 query 层**，验证码 / 通知列表 / 未读数都是 effect 里发请求 + 同步先置 loading。那条规则是**性能**建议（多一次渲染），不是正确性问题。降成 warn 而不是 off：将来加了 query 层要能看见这 3 处 |

⚠️ 用 `globals['react-native']` 而不是 `globals.browser` 还有个护栏作用：
往 RN 代码里写 `document.xxx` 会被 `no-undef` 抓住 —— 那正是 `packages/i18n`
踩过的坑（一句 `document.documentElement.lang` 让移动端一初始化就抛）。

第一次跑抓到 **10 处死代码**（UI 迭代留下的 `bg` / `fg` / `router`、
三个不调 `t()` 却解构了 `useTranslation()` 的子组件、四个没用的 import），
以及 `metro.config.js` 里两条**无效的** `eslint-disable`
（`@typescript-eslint/no-require-imports` 没作用于 `.js`，所以那两行
反而会以「规则不存在」报错）。

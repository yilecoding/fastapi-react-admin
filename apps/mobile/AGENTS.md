# apps/mobile —— 移动端原生 App（issue #39 的 **C 路线**）

> **路线已定：C（RN 原生 UI），不是 B（WebView 套现有 web）。**
> 定这一条的理由不是技术偏好：移动端的交互逻辑是全新的一套，
> **列表不能是表格**。B 路线的前提是「复用 PC 端渲染」，而那个前提在移动端不成立 ——
> 所以 B 那半天的验收（浏览器代答五条、注入 token 免登录…）连同 `react-native-webview`
> 一起删掉了，git 历史里还能翻到。
>
> 现在的状态：**底座 + 两条实测的探针页**，还没有业务页面。
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

## 🔬 两条只能在设备上回答的实测（`src/app/index.tsx` 是一次性探针页）

`src/app/index.tsx` 现在是探针页，不是首页。两条实测跑完就换成真页面。

### 1. uniwind 认不认 `oklch()`

**为什么要问**：`packages/ui/src/styles/globals.css` 的令牌全是 oklch。认，
则移动端和 web 可以共享一份真相源；不认，则令牌要在构建期降级成 sRGB，
**而那意味着两份颜色定义**。

探针（`src/styles/global.css` 的 `--color-probe-*`）：三对色块，每对左边写 oklch、
右边写**离线算出的精确 sRGB 等价值**。看不出接缝 = 认。

已知的构建期迹象（还不是结论）：`expo export` 出来的 `.hbc` 里
**没有字面的 `oklch(` 颜色**，说明 uniwind 在编译期就把它算掉了。
`strings` 抓到的 3 个 `oklch` 是字符串池里的巧合子串，不是颜色值。

### 2. RN 的 `fetch` 能不能读到 `set-cookie` / cookie jar 会不会自动回传

**为什么要问**：refresh token 在 httpOnly cookie 里（`fba_refresh_token`，7 天）。
`apps/desktop/src/main/auth.ts` 那套「读 Set-Cookie → 自己存 → 手工带 Cookie 头」
在 RN 侧成不成立，全看这一条。不成立就得为移动端改后端刷新链路。

探针三步，打的是**本机 dev API**（`http://10.0.2.2:8088`）：

1. `GET /api/v1/auth/captcha` → 拿 uuid。答案在 redis：
   `docker exec fba_redis redis-cli -n 6 --raw GET "fba:login:captcha:<uuid>"`
2. `POST /api/v1/auth/login` → 打印 `res.headers` 的全部 key，看 `set-cookie` 在不在
3. `POST /api/v1/auth/refresh` **不带任何头** —— 它只读 refresh cookie。
   200 = jar 自动回传了；401 = 没回传

⚠️ 探针刻意打**本机 dev** 而不是生产：生产的 `sys_config` 里
`LOGIN_CAPTCHA_ENABLED` 是 `false`（有意设的），验不到验证码那条链路。

## 设备：WSL 里的 Android 模拟器（**不往局域网开任何口**）

`10.0.2.2` 在 Android 模拟器里就是宿主的 `127.0.0.1`（这里的「宿主」是 WSL 本身），
所以 Metro 和 dev API 都只绑 localhost，全程留在 WSL 内部。

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

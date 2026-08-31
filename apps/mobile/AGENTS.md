# apps/mobile —— 移动端外壳（issue #39 的 B 路线）

> 现在只有 **step 0 的 spike**：原生壳 + WebView 承载现有 web，不做鉴权托管、
> 不做服务器地址设置屏、不做原生能力桥（那些是 step 1/2/4）。
> 路线取舍（A 响应式 / B 混合 / C RN 原生）见 issue #39，**第 1 条决策还没拍**。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载）。跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 起服务

```bash
pnpm mobile:dev                                   # = expo start
EXPO_PUBLIC_WEB_URL=https://... pnpm mobile:dev   # 指向别的站点
```

## 🔴 WSL2 + 真机：Metro 会挑一个 Docker bridge 当 LAN 地址，手机永远连不上

**实测现场**：Metro 打印 `Metro: exp://172.24.0.1:8081`，扫码后 Expo Go 停在一屏
「出错了。对此表示歉意。」—— 那是它拉不到 bundle 时的通用错误页，**不提网络两个字**，
很容易当成代码写错了去查。

`172.24.0.1` 是本机一个 **Docker bridge**（`br-237b20062eef`）。这台机器上有 8 个
docker bridge（`172.18`–`172.24`）加 `docker0`，Metro 从网卡列表里挑了其中一个。
那个地址**三重不可达**：在 WSL 里、在 NAT 后面、而且是 docker 内部网桥。
WSL 真正的地址是 eth0 的 `172.17.108.1`，而它同样在 NAT 后面
（`.wslconfig` 里没有 `networkingMode=mirrored`），局域网里的手机照样到不了。

### ❌ 三条常规解法在这台机器上都不能用

| 解法 | 为什么不能用 |
|---|---|
| `expo start --tunnel`（ngrok） | **实测起不来**：`CommandError: failed to start tunnel / session closed`。ngrok 的隧道端点被墙 —— `connect.ngrok-agent.com` / `tunnel.us.ngrok.com` curl 返回 `000`，而 `status.ngrok.com` 返回 200 只是因为它托管在 Atlassian。所以**刻意不提供 `start:tunnel` 脚本、也不装 `@expo/ngrok`** |
| `.wslconfig` 的 `networkingMode=mirrored` | 🔴 **会把 WSL 里监听 `0.0.0.0` 的服务一起暴露到宿主机的局域网地址上** —— 这台机器上跑着 `fba_mssql`（1433）和 `fba_redis`（6380）。为了调一个 spike 把数据库开到局域网，不成比例。**已被否掉，不要再提议** |
| `netsh interface portproxy` | 同理，是显式往局域网开一个口；而且要管理员权限、WSL 的 eth0 地址每次重启还会变 |

### ⚠️ Expo Go 一个客户端只支持**一个** SDK 版本

实测撞到过：手机上装的 Expo Go 是 `54.0.8 / Supported SDK 54`，而工程是 SDK 57 ——
**加载不了**。这和上面那个「Metro 地址不可达」是**两个独立的问题**，当时叠在一起，
手机上都表现成同一屏「出错了」。

（Expo Go 早期支持多个 SDK 并存，现在不了：一个 Expo Go 版本对一个 SDK。）

三条出路：

| 出路 | 说明 |
|---|---|
| **升级手机上的 Expo Go**（推荐） | `https://expo.dev/go` 选 SDK 57 / Android 下 APK。这台机器上 `expo.dev` 返回 200，网络没问题。工程留在最新 SDK |
| **走 WSL 内的模拟器** | `expo start --android` 会**自动往模拟器里装匹配版本的 Expo Go** —— SDK 版本这个问题顺带就没了，不用手工下 APK |
| 把工程降到 SDK 54 | SDK 54 仍在维护（`54.0.37`，2026-08-17）。代价：`expo ~54.0.36` / `react 19.1.0` / `react-native 0.81.5`，比 SDK 57 的 `19.2.3` / `0.86.3` 落后三个大版本，而且以后要再升一次。**只有在 APK 下不动时才考虑** |

### ✅ 先用手机浏览器 —— B 路线下它是 WebView 的**忠实代理**

这是最容易被跳过的一条：**B 路线的 WebView 用的就是系统浏览器引擎**，
而生产站 `https://fra.wubunan.com` 本来就是公网可达的。所以手机直接用浏览器打开它，
**六条验收里有五条当场就能验，一行配置都不用改**：

| # | 验收项 | 浏览器能不能代答 |
|---|---|---|
| 1 | 能不能打开、前端资源完整 | ✅ 完全等价 |
| 2 | 登录能不能过 | ✅ 完全等价 |
| 3 | cookie 能不能跨刷新回传 | ⚠️ **服务端那一半等价**（cookie 属性在移动端浏览器上成不成立）。但 WebView 有自己独立的 cookie 存储、iOS 还要 `sharedCookiesEnabled`，那部分要壳才验得到。**而且它完全代答不了 C 路线那一问**（RN 的 `fetch` 能不能读到 `set-cookie`）—— 那是另一回事 |
| 4 | 注入 token 免登录 | ❌ 要壳（`injectedJavaScriptBeforeContentLoaded`） |
| 5 | 触屏落差实际有多难受（#39 第 2.5 节六条） | ✅ **完全等价，而且这是 step 0 最主要的产出** |
| 6 | 移动端账号 `is_staff=1` | ✅ 服务端行为，与客户端无关 |

**所以顺序应该是：先用浏览器把 1/2/5/6 跑完并记录，再决定值不值得为 3/4 装环境。**
第 5 条本来就是 step 0 里最需要人眼判断、也最影响路线决策的一条。

### 装环境的话：WSL 内的 Android 模拟器（不碰宿主网络）

要验第 3、4 条就得有真正的壳。在**不暴露任何端口**的前提下，只有这一条：
在 WSL 里跑 Android 模拟器，Metro 绑 localhost，模拟器通过 `10.0.2.2` 访问它，
全程在 WSL 内部。

前提这台机器都满足（已核）：`/dev/kvm` 存在（硬件加速）、`/mnt/wslg` 存在（显示）。
代价是要装 Android SDK + 系统镜像，**几 GB 的下载**。
装了之后 dev client / prebuild / EAS 本地构建也一起解锁了，不只为 step 0 服务。

## 只出 ios / android，不出 web

`app.json` 里写了 `"platforms": ["ios", "android"]`。这是个 WebView 壳，渲染到 web
等于「浏览器里套一个浏览器」，没有意义；而不限制的话按 `w`（或 Expo 自己探测 web）
会去解析没装的 `react-native-web`，打出一句

    Unable to resolve "react-native-web/dist/exports/ActivityIndicator"

—— 它和手机连不上**毫无关系**，但会和真正的错误混在同一屏日志里，白排查一轮。
实测踩过。

⚠️ **它没有 `dev` 脚本，这是刻意的。** 根 `pnpm dev` 是 `turbo dev`，按**脚本名**
匹配 —— 叫 `dev` 就会被 `pnpm dev` 一起拉起来，而 Expo 要占端口、要交互式选设备，
会把那个 TUI 搅乱。照 `apps/desktop` 的先例走独立入口。

## 🔴 Metro：不要抄 Expo monorepo 指南那份配方

`metro.config.js` 里**只有一行** `watchFolders`，resolver 全默认。
官方那份 `disableHierarchicalLookup: true` + `nodeModulesPaths` 是针对
Yarn / npm **提升式布局**的，在 pnpm 上直接把构建打死。

**做过对照实验**（同一个工程、同一次 `expo export --platform android`）：

| 配置 | 结果 |
|---|---|
| 只有 `watchFolders`（现在这份） | ✅ **588 模块打包成功**；临时 import `@admin/i18n` 时 594 模块，连它私有的 `i18next` 一起解析到了 |
| 加上官方那两条 | 🔴 **第 1 个模块就失败**：`Unable to resolve module expo-modules-core from …/node_modules/expo/src/Expo.ts` |

注意失败点：炸的**不是**某个 workspace 包，是 `expo` 自己。好消息是这个失败很响、
不会静默；坏消息是**报错里没有一个字提到这份配置** —— 看着像「依赖装坏了」，
很容易去反复 `pnpm install` 或删 node_modules 重装。

顺带一个对 C 路线有用的结论：**`@admin/i18n` 在 Metro 侧解析没有任何问题**
（连它私有的 `i18next` 一起），所以 C 路线在「能不能 import workspace 包」这一步
不存在障碍。C 的障碍在**运行时**（`index.ts:102` 那个没守卫的 `document`，
以及 Hermes 的 Intl 行为），见 issue #39 的评论。

## step 0 走 Expo Go，不需要 prebuild

`react-native-webview@13.16.1` 在 SDK 57 的 bundledNativeModules 清单里 ——
那份清单在 expo 包自己的 tarball 里，`npm pack expo@57.0.18` 解出来能自己核。
在那份清单里就意味着 **Expo Go 自带**。
所以 step 0 不用 `expo prebuild`、不出原生工程、也就**不用碰 pnpm 的
`nodeLinker: hoisted`** —— 那是个**整仓**开关，会连带影响 web 与 desktop 的依赖隔离
（issue #39 第四节提到的那条风险，在 step 0 范围内不存在）。

⚠️ 一旦需要一个 Expo Go 不带的原生模块（扫码、静默打印…），这条豁免就没了，
那时候再评估 hoisted 的代价，别提前付。

## 版本对齐

`react` 钉在 **19.2.3**（SDK 57 模板的值），而 `packages/*` 是 `^19.2.6` ——
pnpm 下各自一份，互不影响。**刻意跟 Expo 的 pin 而不是跟仓库的** ：
Expo 的版本校验（`expo-doctor`）按 SDK 对齐，偏离它是一类很难排的问题来源。
等真要从 mobile 里 import workspace 的 React 组件（那是 C 路线）再统一。

## 没有 lint，这是暂时的

模板不带任何 eslint 配置。**不要顺手用 `expo lint` / 装 `eslint-config-expo` 补** ——
它会经 `eslint-import-resolver-typescript` 拖进带 postinstall 的 `unrs-resolver`，
而 pnpm 11 对未放行的 build script 是 **exit 1 不是警告**，要同时改
`pnpm-workspace.yaml` 的 `allowBuilds`。真要补的时候一起做，别在 spike 里顺手引。

## 🔴 加载失败必须可见，不能白屏

WebView 的默认失败表现就是一片空白，而这个 spike 最需要区分的恰恰是
「站点挂了」/「证书不对」/「网络不通」/「还在转圈」这几种 —— 都长成白屏的话，
这半天基本白花。所以 `App.tsx` 把 `onError` / `onHttpError` 摊成一个带原因和
重试的面板（根 `CLAUDE.md` 硬纪律 9 在移动端的形态）。

## 两个必须开的 WebView 开关

| 开关 | 漏了会怎样 |
|---|---|
| `sharedCookiesEnabled`（iOS） | WebView 用自己那份隔离的 cookie 存储，而 refresh token 就在 httpOnly cookie 里（`fba_refresh_token`，7 天）。表现是「登录能过、过一天回来又要重新登录」，**隔一天才复现** |
| `thirdPartyCookiesEnabled`（Android） | 同源部署下用不上，但远端加载一旦前后端分域就会需要。先开着比事后查一天便宜 |

## 站点地址：必须是域名 + HTTPS

生产证书是 Let's Encrypt 签给 `fra.wubunan.com` 的，**走 IP 会 TLS 失败**，
而 WebView 报的是一个笼统的加载错误、不提「证书」两个字。
iOS 的 ATS 和 Android 的 cleartext 又默认拦明文 HTTP —— 要连本机 dev server
得在 `app.json` 里开例外，而**那条例外极容易被顺手带进 release 配置**。
所以 `src/config.ts` 不提供「自动降级到 http」的便利。

## step 0 的验收清单（要真机/模拟器上人工跑）

这几条本环境跑不了（没有 RN 运行时），必须在设备上过一遍并记录结果：

1. **能不能打开** `https://fra.wubunan.com`，前端资源加载完整
2. **登录能不能过。** ⚠️ 生产的 `sys_config` 里 `LOGIN_CAPTCHA_ENABLED` 是
   `false`（`/api/v1/auth/captcha` 返回 `is_enabled: false`，是有意设的），
   所以这一步**验不到验证码那条链路**。要验就得先把那条配置改回 true
3. 🔴 **`set-cookie` 能不能读到 / cookie jar 会不会自动回传。** 这条是
   issue #39 里 **B 的远端加载刷新链路** 和 **C 要不要动后端** 的**共同判据** ——
   `apps/desktop/src/main/auth.ts` 那套「读 Set-Cookie → 自己存 → 手工带 Cookie 头」
   在 RN 侧成不成立，全看这一条。放在最前面验
4. **注入 token 能不能免登录**：token 在 `sessionStorage['admin:access-token']`，
   WebView 有 `injectedJavaScriptBeforeContentLoaded`。这条 E2E 里已经验过同款
   （`e2e/fixtures/base.ts` 的 `authedPage` 用 Playwright 的 `addInitScript` 做同一件事）
5. **触屏落差实际有多难受**（issue #39 第 2.5 节列了六条），逐条拍照记录：
   纯图标按钮的 tooltip 在触屏上等于不存在 · 多页签 · 嵌套滚动 · 12 列宽表格 ·
   键盘遮挡 · Android 返回键
6. **移动端账号要 `is_staff=1`**：`rbac.py:48` 非 GET/OPTIONS 且 `is_staff` 为假
   → 403，而 `model/user.py` 默认 False、`AddUserParam` 里**根本没有这个字段**。
   表现是「能登录、能看列表、所有写操作 403」，而三条 403 文案都不提移动端

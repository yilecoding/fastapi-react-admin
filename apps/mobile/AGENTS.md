# apps/mobile —— 移动端外壳（issue #39 的 B 路线）

> 现在只有 **step 0 的 spike**：原生壳 + WebView 承载现有 web，不做鉴权托管、
> 不做服务器地址设置屏、不做原生能力桥（那些是 step 1/2/4）。
> 路线取舍（A 响应式 / B 混合 / C RN 原生）见 issue #39，**第 1 条决策还没拍**。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载）。跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 起服务

```bash
pnpm mobile:dev                    # = pnpm --filter @admin/mobile start
EXPO_PUBLIC_WEB_URL=https://... pnpm mobile:dev   # 指向别的站点
```

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

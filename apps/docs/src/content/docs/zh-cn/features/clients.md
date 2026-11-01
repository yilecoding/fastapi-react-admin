---
title: 桌面端与移动端
description: Electron 桌面端：三平台安装包、自动更新、静默打印；移动端是 Expo / React Native 原生 App，不是 WebView 套壳。
sidebar:
  order: 9
---

除了浏览器，仓库里还有两个客户端。`apps/desktop` 把同一份 web 构建产物装进 Electron，补上浏览器做不到的四件事：静默打印、通过原生助手进程接本地硬件、refresh token 由主进程托管、自动更新。每个 GitHub Release 都附带 Windows、macOS、Linux 三个平台的安装包。`apps/mobile` 是 Expo / React Native 原生 App，屏幕是单独写的，不是拿 WebView 套网页；请求客户端和语言包与 web 端共用。

## 桌面端在哪下载？

在 [GitHub Releases](https://github.com/yilecoding/fastapi-react-admin/releases) 下载。每个版本包含：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows 10/11 x64 | `admin-desktop-<版本>-setup.exe` | NSIS 安装向导，装到当前用户的 `%LOCALAPPDATA%\Programs`，不需要管理员权限 |
| macOS Apple Silicon / Intel | `admin-desktop-<版本>-arm64.dmg` / `-x64.dmg` | 同名的 `.zip` 是给自动更新用的 |
| Linux x64 | `admin-desktop-<版本>-x86_64.AppImage` | `chmod +x` 后直接运行 |

`.blockmap` 和 `latest*.yml` 是自动更新用的，不需要手动下载。

:::caution[安装包没有代码签名]
Windows 的 SmartScreen 会拦一次，点「更多信息 → 仍要运行」。macOS 的 Gatekeeper 会提示「已损坏」，右键 →「打开」即可，或执行 `xattr -dr com.apple.quarantine "/Applications/Admin Desktop.app"`。发版流水线已经把 `CSC_LINK`、`CSC_KEY_PASSWORD` 和 `APPLE_*` 这几个 secret 透传给了 electron-builder，在仓库里配上就能开启签名（macOS 还会公证），不用改流水线。不过这条路还没用真证书跑过。
:::

## 桌面外壳比浏览器多了什么？

外壳（Electron 42）不含任何业务代码，页面就是 `apps/web` 的构建产物。渲染层通过 `window.desktop` 调主进程，一共六个命名空间：`app`、`config`、`auth`、`print`、`devices`、`updater`。IPC 契约在 `packages/platform/src/desktop/contract.ts`。

- **静默打印。** `print.html()` 在隐藏窗口里渲染 HTML，再调 `webContents.print({ silent: true })`，全程不弹对话框。打印机取配置里的 `printerName`，没配就用系统默认。这条路只对 HTML 成立，现成的 PDF 没法静默打，所以标签要写成 HTML + CSS `@page`，可以借助 `buildLabelHtml()`。`print.htmlToPdf()` 走同一条渲染管线输出 PDF，没有打印机也能调版式。打印失败返回 `{ ok: false, reason }`，不会谎报成功。选 Electron 的决定性理由就是静默打印，[`apps/desktop/README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/desktop/README.md) 里有记录。
- **本地硬件。** 设备适配器拉起一个原生助手子进程，把它的输出作为事件流推给 `devices.on()`。仓库自带一个身份证读卡器适配器。`resources/` 里没有厂商的助手程序时，它自动进入桩模式，用 `devices.simulate()` 造假数据，在 Mac 上也能把「读卡 → 拉数据 → 打标签」整条链路跑通。
- **凭据托管。** 渲染层跑在 `app://local` 下，对后端是跨站请求，浏览器那条 `SameSite=Lax` 的 refresh cookie 带不过去。所以 refresh token 由主进程保存，用 Electron 的 `safeStorage` 加密落盘（Windows 走 DPAPI，macOS 走 Keychain），渲染层只拿 access token。这条链路目前只过了类型检查，还没在打包后的正式包里端到端验证过。
- **运行期配置。** 应用数据目录下的 `config.json` 存 `serverUrl`、`printerName`、`kiosk`、`autoLaunch`、`updateUrl`。同一个安装包可以发到不同环境，什么都不需要编译进去。

```ts
import { isDesktop, desktop } from "@admin/platform/desktop"

if (isDesktop()) {
  const res = await desktop().print.html(html, { pageSize: { width: 60000, height: 40000 } }) // 单位：微米
  if (!res.ok) showError(res.reason)
}
```

写外壳时实测到两点：`print()` 的 `pageSize` 单位是微米，`printToPDF()` 的单位却是英寸；开启 `preferCSSPageSize` 并写好 `@page` 后，60 × 40 mm 的标签实际输出 59.944 × 39.878 mm，偏差 0.09%。

## 桌面端怎么自动更新？

用的是 `electron-updater`。`config.json` 里填了 `updateUrl` 就用它，这是 generic 源，任何能列目录的静态 HTTP 服务都行，比如客户内网。没填就用打包时写进 `app-update.yml` 的源，也就是本仓库的 GitHub Releases。更新包自动下载，在应用退出时安装。`quitAndInstall(true, true)` 静默安装并自动重启；不带这两个参数的话，弹出来的是 NSIS 安装向导，停在那里等人点「下一步」。渲染层通过 `desktop().updater.check()`、`.on()`、`.quitAndInstall()` 驱动更新。web 端自己不会调 `check()`，需要你在应用里接一个按钮或在启动时调用。

| 平台 | 自动更新 |
|---|---|
| Windows（NSIS） | 可用。按用户安装，更新时不弹 UAC 提权 |
| Linux（AppImage） | 可用 |
| macOS | **不可用**。安装包未签名，而 electron-updater 会校验运行中应用的代码签名 |

内网部署时，往静态目录放 `<版本>.exe`、对应的 `.blockmap` 和 `latest.yml`。`latest.yml` **必须最后放**，并且不能被缓存。`.blockmap` 用于差量下载，但第一次更新通常会回落成全量下载。

## 安装包怎么出？

推一个 `v*` tag 就会触发 [`.github/workflows/release.yml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/.github/workflows/release.yml)。`prepare` job 先核对 tag、`apps/web/package.json` 的版本和后端 `__version__` 三者一致，再建**唯一一个**草稿 release。随后矩阵在 `windows-latest`、`macos-latest`、`ubuntu-latest` 上各自打包，每个平台只在自己的系统上出包。electron-builder 用 `--publish never`，产物由 `gh release upload` 上传，因为 electron-builder 自带的上传器曾经并发建出过两个草稿。草稿要有人先装一遍试过，再点发布。

本地手动打包：先 `pnpm --filter web build`，再 `pnpm --filter @admin/desktop package`。桌面端自己的构建不会重新构建前端，漏了第一步，打出来的就是上一版界面，而且不报任何错。开发时先把 web dev server 起在 :8888，再跑 `pnpm desktop:dev`。

## 移动端是什么？

`apps/mobile` 基于 Expo SDK 57、React Native 0.86 和 Expo Router，样式用 uniwind（Tailwind CSS v4 的 React Native 实现），组件来自 `react-native-reusables`。只出 Android 和 iOS，不出 web。

- **原生界面，不是 WebView。** 底部三个 tab：首页、应用、我的。另有通知、个人资料与改密码、设置、公告详情（带附件），以及「用户列表 → 详情 → 删除」这一组专门写成可照抄的范式。列表用 `FlatList` + 无限查询。公告正文是 web 端 Tiptap 产出的 HTML，按白名单转换成原生组件来渲染，不走 WebView。
- **与 web 共用：** `@admin/api`（信封判定、401 单飞刷新、从生成的 `schema.d.ts` 推出请求类型）和 `@admin/i18n`。不依赖 `@admin/platform`，那个包是按 web 的形状写的。
- **登录：** 密码和手机验证码两种方式，都要先过图形验证码。access token 存在 `expo-secure-store`（Keystore / Keychain），绝不放 `AsyncStorage`。refresh token 留在 httpOnly cookie 里：在 Android 上实测，React Native 自带的 cookie jar 会自动回传它，冷启动后依然有效。
- **服务器地址在 App 里设置**，存在设备上。保存前会先探一次 `/auth/captcha`，确认这个地址确实是一个能连通的后端。颜色令牌与 web 端是同一份 `oklch()`，在 Android 上实测逐像素一致。

## 移动端还没做什么？

- 只在 Android 上手工验收过（登录 → 权限门控 → 列表翻页 → 详情 → 删除确认 → toast）。较新的屏幕，比如手机验证码登录和公告附件，目前只过了 `tsc`、ESLint 和打包。**iOS 一次都没跑过。**
- 移动端没有自动化测试。CI 的闸门是 `pnpm build`，其中包括 `expo export --platform android`，只能挡住打包阶段的失败。
- 没有实时推送：没接 socket.io，进入页面或下拉时刷新。系统推送、扫码、静默打印明确不在范围内。
- 还没有发布过 APK。`pnpm --filter @admin/mobile apk` 只跑到原生模块编译那一步，而且用的是模板自带的 debug keystore，正式发布前要换成自己的 keystore。
- 改手机号、邮箱要走验证码流程，目前只有网页端有。

本地跑起来：先 `pnpm --filter api dev:host`（后端绑 `0.0.0.0:8088`），再 `pnpm mobile:dev`，把打印出来的 `exp://…:8800` 地址填进 SDK 57 版的 Expo Go。

## 代码在哪

- [`apps/desktop/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/desktop)：`src/main/`（窗口、`app://` 协议、`print.ts`、`updater.ts`、`auth.ts`、`devices/`）和 `electron-builder.yml`
- [`packages/platform/src/desktop/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/desktop)：桥接契约、`isDesktop()` / `desktop()`、标签模板
- [`apps/desktop/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/desktop/AGENTS.md)：打包、签名、自动更新在正式包里踩到的坑
- [`apps/mobile/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/mobile)：`src/app/`（屏幕）、`src/lib/`（会话、请求、权限），以及 [`AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/mobile/AGENTS.md)

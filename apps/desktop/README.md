# @admin/desktop — 桌面外壳模板

把 `apps/web` 装进 Electron 的外壳。**它不含任何业务代码**，业务全在渲染层；
外壳只提供浏览器给不了的四件事：静默打印、本地硬件、凭据托管、自动更新。

设计目标是**能被下一个项目直接套走**：换项目时改的是 `resources/` 里的原生助手
和 `src/main/index.ts` 里那一行设备注册，其余不动。

## 为什么是 Electron 不是 Tauri

一句话：**静默打印**。Electron 的 `webContents.print({ silent: true })` 是内建能力；
Tauri 至今没有 print API（tauri#4917 / #5330 / plugins-workspace#293 全部还开着），
WebView2 的 `window.print()` 必弹对话框，要静默就得出 PDF 再喂 Ghostscript /
SumatraPDF / 自写 winspool。

次要理由：Electron 把 Chromium 打进包里，终端机上跑的和你机器上跑的是同一个渲染引擎；
Tauri 用系统 WebView2，版本跟着 Windows 更新走，你说了不算。

> 硬件读取（读卡器之类）**不构成选型理由**——两边都是「起个子进程读 stdout」，
> 完全打平。详见 `src/main/devices/helper-process.ts` 顶部注释。

## 目录

```
src/main/
  index.ts              生命周期与装配（保持很短）
  window.ts             窗口、kiosk、外链拦截
  protocol.ts           app:// 标准协议 + SPA 回退
  config.ts             运行期配置（userData/config.json）
  auth.ts               refresh token 主进程托管 + safeStorage
  print.ts              静默打印 HTML
  updater.ts            electron-updater（generic 源）
  ipc.ts                IPC 注册（唯一的注册点）
  devices/
    types.ts            设备适配器接口
    registry.ts         注册表，主进程只跟它打交道
    helper-process.ts   原生助手子进程（一次性 / 长驻两种）
    card-reader.ts      身份证读卡器适配器（含桩模式）
src/preload/index.ts    contextBridge 白名单
resources/              原生助手程序及其 DLL（打包进 resources/native）
```

契约（IPC 通道名 + 所有类型）在 `packages/platform/src/desktop/contract.ts`，
主进程和渲染层共用一份。放 platform 是为了不把依赖方向掰弯。

## 跑起来

### 一次性准备：Electron 二进制

`pnpm install` 时 electron 的 postinstall 会去下 ~215MB 的二进制。
`pnpm-workspace.yaml` 的 `allowBuilds` 里已经放行了它，正常情况下装完就有。

**如果卡在 `fetch failed`**：那多半不是网络不通，是 **Node 的 undici 不读 `HTTPS_PROXY`
环境变量**（curl 读、node fetch 不读）。走代理的环境要显式告诉它：

```bash
cd $(node -e "console.log(require.resolve('electron/package.json').replace('/package.json',''))")
ELECTRON_GET_USE_PROXY=true \
GLOBAL_AGENT_HTTPS_PROXY=$https_proxy \
GLOBAL_AGENT_HTTP_PROXY=$http_proxy \
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ \
node install.js
```

（国内网络就算不走代理，加上 `ELECTRON_MIRROR` 也会快很多。`electron-builder`
打包时同理，它的下载器是 Go 写的、认 env 里的代理，再加个
`ELECTRON_BUILDER_CACHE=/tmp/eb-cache` 就行。）

### 开发

两个终端：

```bash
pnpm --filter web dev                 # 渲染层 :1125（必须先起）
pnpm --filter @admin/desktop dev      # 编译 main/preload → 等 dev server → 拉起 Electron
```

或者一条命令，turbo 会把 api / web / desktop 一起拉起来：

```bash
pnpm dev
```

`scripts/dev.mjs` 会 watch main 与 preload，任一重建完就自动重启 Electron；
渲染层的改动走 Vite HMR，不重启。关掉窗口 = 整个 dev 进程收工。

**WSL 下不需要额外做什么**——脚本自己处理了两件事（实测通过）：
`chrome-sandbox` 没配 setuid 时自动加 `--no-sandbox`；`DISPLAY` 为空但检测到
WSLg（`/tmp/.X11-unix/X0`）时自动设成 `:0`。两种情况都会打印一行说明。

要给 Electron 加参数（比如挂 CDP 调试）走环境变量：

```bash
DESKTOP_ELECTRON_ARGS=--remote-debugging-port=9555 pnpm --filter @admin/desktop dev
```

渲染层不在 1125 时用 `DESKTOP_DEV_SERVER_URL` 指过去。

### 打包

```bash
pnpm --filter @admin/desktop build          # 只出 main/preload
pnpm --filter @admin/desktop package:dir    # 出解包目录，本地验证用
pnpm --filter @admin/desktop package        # 出 NSIS 安装包（在 Windows 上跑）
```

`package` 会先 `build`，但**不会**自动构建渲染层——先跑
`pnpm --filter web build`，或者直接 `pnpm build`（turbo 里
`@admin/desktop#build` 已经声明依赖 `web#build`）。

> `apps/web` 一行都不用为桌面端改。浏览器版继续能单独构建、单独跑。

## 渲染层怎么用

```ts
import { isDesktop, desktop, buildLabelHtml, qrPixelSize } from "@admin/platform/desktop"

if (isDesktop()) {
  const html = buildLabelHtml({
    widthMm: 60, heightMm: 40,
    title: "示例凭条",
    fields: [
      { label: "名称", value: "示例条目", emphasis: true },
      { label: "归属", value: "示例分类 · 示例负责人" },
      { label: "有效", value: "2026-08-22 09:00 ~ 18:00" },
    ],
    qrDataUri,   // 按 qrPixelSize(18, 203) = 144px 生成的 PNG
  })
  const res = await desktop().print.html(html, { pageSize: { width: 60000, height: 40000 } })
  if (!res.ok) {
    // ⚠️ 失败绝不能回写「已打印」。以前的项目无论成败都回写，
    //    结果是没打出来的标签被标记成已打印，既对不了账也补不了打。
    showError(res.reason)
  }
}
```

设备是事件流：

```ts
const off = desktop().devices.on((ev) => {
  if (ev.deviceId === "card-reader" && ev.payload.kind === "card") {
    handleCard(ev.payload.idNumber)
  }
})
await desktop().devices.start("card-reader")
// 没有硬件时：desktop().devices.simulate("card-reader")
```

## 接一个新项目要改什么

1. `electron-builder.yml` 的 `appId` / `productName` / `publish.url`
2. `src/main/index.ts` 里那行 `registerDevice(...)` —— 换成你这个项目的设备
3. `resources/` 放对应的原生助手程序（连同它的 DLL，**必须同一层目录**）
4. 契约里 `CardReaderEvent` 换成你的设备事件类型

外壳的其余部分（窗口、协议、配置、认证、打印、更新）都是项目无关的。

## Mac / Windows 分工

外壳本身是跨平台的，**日常开发在 Mac 上做就行**：窗口、`app://` 协议、路由、配置、
主进程托管认证（macOS 走 Keychain）、IPC、贴纸排版全都不动。读卡器会自动落到桩模式
（`CardReaderAdapter` 判断的是 `resources/ReadCard.exe` 在不在），`simulate()` 造假卡，
「读卡 → 拉数据 → 打标签」整条链路照样能联调通。

只有两件事必须 Windows：

| | Mac 能做 | 必须 Windows |
|---|---|---|
| 读卡 | 桩模式 + `simulate()` | **真读卡** —— `ReadCard.exe` 是 Windows exe，调 `ghcmio.dll`，厂商没有 macOS SDK |
| 打印 | 版式迭代：`print.htmlToPdf()` 用同一条渲染管线导出 PDF，所见即所得<br>（macOS 默认没有 PDF 打印机设备，靠打印机列表验不了） | **真机验收** —— Windows 打印驱动会不会改写自定义纸张尺寸，CUPS 不复现；标签机也未必有 macOS 驱动 |
| 打包 | `package:dir` 出本地 `.app` 自测 | 出 NSIS 安装包（从 Mac 交叉打包要 Wine，不推荐） |

## 部署时要记得的三件事

1. **后端 CORS 要放行桌面源。** 渲染层跑在 `app://local`，对后端是跨源。
   `backend/core/conf.py` 的 `CORS_ALLOWED_ORIGINS` 里加上 `app://local`。
2. **服务器地址是运行期配置**，首次启动要让用户填（写进 `userData/config.json`）。
   不要再走 `VITE_API_BASE` 那条编译期常量。
3. **生产包必须代码签名。** 不签名的话杀软首次扫描新 exe 的开销会落在用户的第一次
   操作上——旧客户端实测：装完首次刷卡 20.4 秒，其中 17.9 秒是杀软在扫 ReadCard.exe。

## 现状：哪些验过、哪些没验

**已实测通过**（WSL2 Ubuntu 26.04 + WSLg，Electron 42.9.3，跑的是真 Electron 进程）：

| 项 | 结果 |
|---|---|
| `tsc --noEmit`（desktop 与 platform 两侧） | 0 错误 |
| 构建产物 | main 29.2 kB · preload 4.0 kB；externals 正确（只 `require("electron")` 与 node 内置） |
| preload 白名单 | `window.desktop` 六个命名空间齐；`ipcRenderer` / `require` / `process` 均**未**泄漏到渲染层 |
| `app://` 协议（开发模式） | 加载 `apps/web/dist` 成功，标题正确 |
| `app://` 协议（**打包模式**） | 走 `process.resourcesPath/renderer` 分支，同样成功 |
| SPA 深链回退 | 落在 `app://local/sign-in` —— 磁盘上没有这个文件，说明回退生效，**TanStack Router 的 browser history 在自定义协议下正常，不需要改成 hash** |
| 配置往返 | 默认值、写入、末尾斜杠削除都对 |
| 设备事件流 | `list → start → 订阅 → simulate → 收到事件`，桩模式自动生效（`resources/ReadCard.exe` 不存在时） |
| 认证失败路径 | 无凭据时抛出「没有可用的登录凭据，请重新登录」，消息干净可读 |
| `print.htmlToPdf` | ok，9.3 kB PDF，141ms，MediaBox `[0 0 169.92 113.04]` |
| `print.html`（无打印机） | `{ ok: false, reason: "Failed to enumerate printers" }` —— 失败是可见状态，没被吞掉 |
| `electron-builder --dir` | 出包成功；`resources/renderer` 26MB 映射正确，`app.asar` 2.3MB |

顺带测出来两件事，都已经改进实现：

1. **`print()` 的 `pageSize` 单位是微米，`printToPDF()` 的是英寸。** 两处传同一个对象，
   PDF 会大 25400 倍（一张巨大的空白页）。
2. **`printToPDF` 应当恒开 `preferCSSPageSize`。** 目标 60×40mm 的实测对比：
   只传 pageSize → 60.367 × 40.217mm（偏大 0.61%）；`preferCSSPageSize` + `@page` →
   59.944 × 39.878mm（偏差 0.09%）；两个都给且有 `@page` → 取准的那个。
   （Chromium 把页面尺寸量化到 1/300 英寸 = 0.24pt，做不到零误差，但能少叠一层换算误差。）

**仍未验证（必须真硬件）**：

- 🔴 **在真标签机上打出一张合格的贴纸。** 剩下的最大不确定性。要看三件事：
  Windows 打印驱动会不会改写自定义纸张尺寸（CUPS 不复现这个风险）·
  二维码在 203dpi 下扫不扫得动 · 有没有莫名多出一页（以前的项目踩过）。
- 🔴 **真读卡。** `ReadCard.exe --serve` 长驻模式**现在还不存在**，需要给既有的 .NET
  助手加一个 `--serve` 分支；在那之前 card-reader 走桩模式。
- 主进程托管认证的完整链路（要有一个能连的后端）。
- NSIS 安装包与自动更新（只在 Linux 上验过 `--dir`）。

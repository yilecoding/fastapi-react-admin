/**
 * 桌面外壳（apps/desktop）与渲染层之间的**唯一契约**。
 *
 * 为什么放在 platform 而不是 apps/desktop：
 * 依赖方向是单向的 `i18n ← ui ← platform ← web/desktop`。契约要被两边同时引用，
 * 只能放在两边共同的下游。放进 apps/desktop 再让 web 反向 import，会把方向掰弯。
 *
 * ⚠️ 这个文件必须**零运行时依赖**（只有 type 和字符串常量）——
 * 它会被 Electron 主进程（Node 环境，没有 React / DOM）一起编译。
 * 往这里加任何 import 之前先想清楚它在主进程里能不能跑。
 */

/** IPC 通道名。集中在这里，避免主进程与 preload 各写一份字符串字面量。 */
export const IPC = {
  appInfo: 'app:info',

  configGet: 'config:get',
  configSet: 'config:set',

  authLogin: 'auth:login',
  authRefresh: 'auth:refresh',
  authLogout: 'auth:logout',
  authRestore: 'auth:restore',

  printListPrinters: 'print:list-printers',
  printHtml: 'print:html',
  printHtmlToPdf: 'print:html-to-pdf',

  deviceList: 'device:list',
  deviceStart: 'device:start',
  deviceStop: 'device:stop',
  deviceSimulate: 'device:simulate',
  /** 主进程 → 渲染层的单向推送通道（设备事件流） */
  deviceEvent: 'device:event',

  updaterCheck: 'updater:check',
  updaterQuitAndInstall: 'updater:quit-and-install',
  /** 主进程 → 渲染层 */
  updaterEvent: 'updater:event',
} as const

// ── 应用信息 ────────────────────────────────────────────────────────────────

/**
 * `process.platform` 的取值。
 *
 * ⚠️ 刻意**不用 `NodeJS.Platform`**。那个类型来自 `@types/node`，而这个文件要
 * 保持环境中立（见文件头）—— 渲染侧的 `packages/platform` 的 lib 只有
 * `ES2022 / DOM`，引用它会直接 `TS2503: Cannot find namespace 'NodeJS'`。
 * 而为了消这个错去给 platform 装 `@types/node`，会把 `process` / `Buffer` /
 * `__dirname` 的类型放进**浏览器代码**里 —— 那些在渲染层运行时并不存在，
 * 编译期放行等于把错误推到线上。
 *
 * 列前三个是我们真正会分支判断的（`darwin` / `win32` / `linux`），
 * `(string & {})` 让其余取值仍然合法、同时**保住前三个的自动补全** ——
 * 直接写 `| string` 会让整个联合塌成 `string`，补全和收窄都没了
 * （原来的 `NodeJS.Platform | string` 就是这个毛病，既报错又没有类型收益）。
 */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | (string & {})

export interface AppInfo {
  version: string
  platform: DesktopPlatform
  /** 是否运行在 kiosk（全屏独占）模式 */
  kiosk: boolean
  /** 打包后为 true；`pnpm --filter desktop dev` 下为 false */
  packaged: boolean
}

// ── 运行期配置 ──────────────────────────────────────────────────────────────

/**
 * 落在 `app.getPath('userData')/config.json`。
 *
 * ⚠️ `serverUrl` 必须是**运行期**配置，不能编译期写死。
 * 渲染层现在的 `API_BASE`（api-client/client.ts）是 `import.meta.env.VITE_API_BASE`，
 * 那是编译期常量——同一个安装包发到不同部署环境就废了。
 */
export interface DesktopConfig {
  /** 后端地址，形如 `http://api.example.com:8000`，**末尾不带斜杠** */
  serverUrl: string
  /** 静默打印用的打印机系统名；空 = 用系统默认打印机 */
  printerName: string
  /** 全屏独占。自助终端场景用 */
  kiosk: boolean
  /** 开机自启 */
  autoLaunch: boolean
  /** electron-updater 的 generic 源，形如 `https://releases.example.com/desktop`；空 = 关闭自动更新 */
  updateUrl: string
}

// ── 认证 ────────────────────────────────────────────────────────────────────

/**
 * 桌面端的 token 由**主进程**托管，渲染层只拿 access token。
 *
 * 三个理由（缺一条都还能凑合，三条叠起来就必须这么做）：
 *  1. refresh token 在后端是 httpOnly cookie，且 `set_cookie` 没传 samesite
 *     → 默认 Lax。渲染层跑在 `app://` 源上时这是跨站，fetch 根本不带这个 cookie，
 *     表现为 access token 一过期就被踢回登录页。主进程自己发请求不受这套规则约束。
 *  2. 渲染层现在把 access token 放 sessionStorage，窗口一关就没
 *     → 终端每次开机都要重登。
 *  3. token 落在终端机器上，应该过 safeStorage（OS 级加密），不该是明文。
 */
export interface AuthTokens {
  accessToken: string
  /** 服务端给的过期时刻，ISO 字符串。渲染层据此决定何时主动 refresh */
  accessTokenExpireTime: string
  sessionUuid?: string
}

export interface AuthLoginInput {
  username: string
  password: string
  captcha?: string
}

// ── 打印 ────────────────────────────────────────────────────────────────────

export interface PrintOptions {
  /** 空 = 用配置里的 printerName，再空 = 系统默认 */
  deviceName?: string
  /**
   * 纸张尺寸，**单位微米**（Electron 的口径）。60mm × 40mm 就是 `{width: 60000, height: 40000}`。
   *
   * ⚠️ 不少标签机驱动只认自己预设的「纸张类型」，会把这里传的自定义尺寸悄悄改写掉
   * ——表现是打出来位移、或者莫名多一页。这条只能上真机验，查文档没用。
   */
  pageSize?: { width: number; height: number }
  landscape?: boolean
  copies?: number
  /** 默认 true。关掉的话贴纸的底色/色块不会打出来 */
  printBackground?: boolean
  /** 渲染超时（毫秒），默认 10000 */
  timeoutMs?: number
}

/**
 * ⚠️ `ok: true` 只代表**已送进打印子系统**，不代表纸出来了——
 * 这和旧客户端 `Spire.Pdf.Print()` 的语义完全一致，别以为换了技术就变强了。
 *
 * 但下面这条纪律必须原样搬过来：**打印失败绝不回写「已打印」**。
 * 旧实现无论成败都回写，导致没打出来的标签被标记成已打印，既对不了账也补不了打。
 */
export interface PrintResult {
  ok: boolean
  /** 失败原因。Chromium 会给 'Invalid printer settings' / 'Print job canceled' 之类 */
  reason?: string
  elapsedMs: number
}

/**
 * ⚠️ 字段按 Electron 的 `getPrintersAsync()` 实际返回来定，**没有** isDefault / status
 * ——那两个字段在旧版本里有过，现在的平台相关信息统一落在 `options` 里。
 * 「系统默认打印机」的判断口径各平台不同，这里不做归一化：
 * 打印时把 deviceName 留空，Electron 自己会挑系统默认的那台。
 */
export interface PdfResult {
  ok: boolean
  reason?: string
  /** 成功时的 PDF 字节。渲染层可以直接塞进 <embed> 预览，或存档 */
  bytes?: Uint8Array
  elapsedMs: number
}

export interface PrinterInfo {
  /** 操作系统认的名字，就是 PrintOptions.deviceName 要填的值 */
  name: string
  /** 打印预览里显示的名字 */
  displayName: string
  description: string
  /** 平台相关的原始字段（Windows 上有 printer-state / printer-location 之类） */
  options: Record<string, unknown>
}

// ── 设备（可插拔适配器）────────────────────────────────────────────────────

/**
 * 设备一律是**事件流**而不是 request/response。
 *
 * 为什么不是「点按钮 → 读一次」：旧客户端每次刷卡起一个 `ReadCard.exe`，
 * 于是首刷要付 20.4 秒（其中 17.9 秒是杀软扫这个 exe），只好再加个 `--warmup`
 * 去把这笔成本藏起来，稳定态仍要 ~1.2 秒。
 * 改成长驻子进程 + 事件流之后这两笔成本一起消失，而且能做到「放卡即读」。
 *
 * 契约按事件流设计，桩实现和真实现就能无缝替换。
 */
export type DeviceStatus = 'stopped' | 'starting' | 'ready' | 'error'

export interface DeviceInfo {
  id: string
  /** 给界面看的名字 */
  label: string
  status: DeviceStatus
  /** status === 'error' 时的原因 */
  error?: string
}

/** 身份证读卡器事件。其他设备各自定义自己的事件类型，在这里并集进 DeviceEvent */
export type CardReaderEvent =
  | { kind: 'card'; idNumber: string; name?: string; raw?: Record<string, unknown> }
  | { kind: 'removed' }
  | { kind: 'error'; code: number; message: string }

export interface DeviceEvent {
  deviceId: string
  /** 主进程盖的时间戳（渲染层不要自己 Date.now()，两边时钟可能不一致） */
  at: number
  payload: CardReaderEvent | Record<string, unknown>
}

// ── 自动更新 ────────────────────────────────────────────────────────────────

export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

// ── 暴露给渲染层的桥 ────────────────────────────────────────────────────────

/**
 * preload 通过 contextBridge 挂到 `window.desktop`。
 * **只有这里列出的东西能过桥**——渲染层永远拿不到 Node、拿不到 ipcRenderer 本体。
 */
export interface DesktopBridge {
  app: {
    info(): Promise<AppInfo>
  }
  config: {
    get(): Promise<DesktopConfig>
    set(patch: Partial<DesktopConfig>): Promise<DesktopConfig>
  }
  auth: {
    /** 主进程发登录请求、扣下 refresh cookie 加密存盘，只把 access token 递回来 */
    login(input: AuthLoginInput): Promise<AuthTokens>
    /** 用存盘的 refresh token 换新的 access token */
    refresh(): Promise<AuthTokens>
    /** 冷启动时恢复会话；没有存盘凭据则返回 null */
    restore(): Promise<AuthTokens | null>
    logout(): Promise<void>
  }
  print: {
    listPrinters(): Promise<PrinterInfo[]>
    /** 渲染一段 HTML 并静默打印。HTML 自带样式，主进程不做任何加工 */
    html(html: string, options?: PrintOptions): Promise<PrintResult>
    /**
     * 同样的渲染管线，但输出 PDF 而不是送打印机。
     *
     * 两个用途：
     *  1. **没有打印机时调版式**。用同一个 pageSize 走同一条渲染路径，
     *     所见即所得地看排版 —— 这是在 Mac 上迭代贴纸样式的正路
     *     （macOS 默认没有 PDF 打印机设备，靠打印列表验不了）。
     *  2. 打印归档。把每张凭条的 PDF 按日期留在 print-cache 里，
     *     用来事后比对版式，这个习惯值得保留。
     */
    htmlToPdf(html: string, options?: PrintOptions): Promise<PdfResult>
  }
  devices: {
    list(): Promise<DeviceInfo[]>
    start(deviceId: string): Promise<DeviceInfo>
    stop(deviceId: string): Promise<DeviceInfo>
    /** 桩设备专用：手动触发一个假事件，方便没有硬件时联调 */
    simulate(deviceId: string, payload?: Record<string, unknown>): Promise<void>
    /** 返回取消订阅函数 */
    on(handler: (event: DeviceEvent) => void): () => void
  }
  updater: {
    check(): Promise<void>
    quitAndInstall(): Promise<void>
    on(handler: (event: UpdaterEvent) => void): () => void
  }
}

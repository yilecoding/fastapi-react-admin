import { BrowserWindow, shell } from "electron"
import fs from "node:fs"
import path from "node:path"

import { readConfig } from "./config"
import { APP_ORIGIN } from "./protocol"

/** 开发时由 scripts/dev.mjs 注入,指向 apps/web 的 vite dev server */
export const DEV_SERVER_URL = process.env.DESKTOP_DEV_SERVER_URL

/**
 * 生产环境的 Windows 安装包不需要这个 —— electron-builder 打包时已经把
 * `build/icon.png` 转成 .ico 塞进 exe 的资源节,任务栏图标跟着 exe 走。
 * 这里要管的是它管不到的场景:开发时跑 `electron .`,以及 Linux 下
 * `package:dir` 出来的本地验证产物 —— 两者都不读 exe 资源,BrowserWindow
 * 不设 icon 就是 Electron 默认的那个气球图标。
 *
 * `build/` 只在仓库里存在,不在 `files` 打包清单中(见 electron-builder.yml),
 * 所以打包产物里这个路径必然不存在 —— existsSync 兜底,而不是让它在生产 exe
 * 里静默画一个空图标。
 */
const DEV_ICON = path.join(__dirname, "../../build/icon.png")

export function createMainWindow(): BrowserWindow {
  const cfg = readConfig()

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    // 先不显示,等首帧就绪再 show —— 否则用户会看到一闪而过的白屏
    show: false,
    ...(fs.existsSync(DEV_ICON) ? { icon: DEV_ICON } : {}),
    kiosk: cfg.kiosk,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      // 这三条是安全底线,任何时候都不要为了图方便关掉其中之一
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 开发时渲染层在 http://localhost,和 app:// 不同源;后端还在第三个源上。
      // 生产环境必须保持 true
      webSecurity: true,
    },
  })

  win.once("ready-to-show", () => win.show())

  // 外链一律交给系统浏览器。让它在应用窗口里打开等于把一个没有地址栏的
  // 浏览器交给用户,自助终端上尤其不行
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = DEV_SERVER_URL ? [DEV_SERVER_URL, APP_ORIGIN] : [APP_ORIGIN]
    if (!allowed.some((prefix) => url.startsWith(prefix))) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: "detach" })
  } else {
    void win.loadURL(`${APP_ORIGIN}/`)
  }

  return win
}

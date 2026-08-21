import { app, BrowserWindow } from "electron"

import type { AppInfo } from "@admin/platform/desktop/contract"

import { readConfig } from "./config"
import { CardReaderAdapter } from "./devices/card-reader"
import { registerDevice, stopAllDevices } from "./devices/registry"
import { registerIpc } from "./ipc"
import { registerAppProtocolHandler, registerAppScheme } from "./protocol"
import { createMainWindow, DEV_SERVER_URL } from "./window"

/**
 * 主进程入口。
 *
 * 这个文件应该保持很短:它只负责生命周期与装配。任何一段超过十几行的逻辑
 * 都该搬到旁边的模块里去 —— 这是模板能被别的项目复用的前提。
 */

// ⚠️ 必须在 app ready 之前调用,晚了直接抛
registerAppScheme()

/** before-quit 要拦一次退出去关设备,用它避免第二次进来又拦一遍 */
let closing = false

// 自助终端只允许一个实例:两个实例会同时去开同一台读卡器,后开的必然失败,
// 而失败信息只会出现在第二个窗口里,现场看到的是「有时候能刷有时候不能」
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // 设备在这里装配。**接新硬件只改这一行**,其余代码不认识任何具体设备
  registerDevice(new CardReaderAdapter())

  void app.whenReady().then(() => {
    const cfg = readConfig()

    if (cfg.autoLaunch && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true, args: [] })
    }

    registerAppProtocolHandler()

    const info = (): AppInfo => ({
      version: app.getVersion(),
      platform: process.platform,
      kiosk: readConfig().kiosk,
      packaged: app.isPackaged,
    })
    registerIpc(info)

    createMainWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })

    if (DEV_SERVER_URL) {
      console.info(`[desktop] 渲染层来自 dev server: ${DEV_SERVER_URL}`)
    }
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", (event) => {
    // 设备必须成对 open/close。这里同步不了 Promise,所以先拦一次退出,
    // 关完设备再真正退 —— 漏掉 close 会把设备句柄留在占用状态,
    // 下次启动的表现是「设备打不开」,而且重启机器才好。
    if (!closing) {
      closing = true
      event.preventDefault()
      void stopAllDevices().finally(() => app.quit())
    }
  })
}

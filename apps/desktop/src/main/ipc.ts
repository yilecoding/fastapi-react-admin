import { BrowserWindow, ipcMain } from "electron"

import { IPC } from "@admin/platform/desktop/contract"
import type { AuthLoginInput, AuthMfaInput, AuthPhoneLoginInput, DesktopConfig, PrintOptions } from "@admin/platform/desktop/contract"

import * as auth from "./auth"
import { readConfig, writeConfig } from "./config"
import { listDevices, onDeviceEvent, simulateDevice, startDevice, stopDevice } from "./devices/registry"
import { listPrinters, printHtml, printHtmlToPdf } from "./print"
import { checkForUpdates, quitAndInstall } from "./updater"

/** 主进程 → 所有窗口的单向广播 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerIpc(appInfo: () => unknown): void {
  ipcMain.handle(IPC.appInfo, () => appInfo())

  ipcMain.handle(IPC.configGet, () => readConfig())
  ipcMain.handle(IPC.configSet, (_e, patch: Partial<DesktopConfig>) => {
    const before = readConfig().serverUrl
    const next = writeConfig(patch)
    // 🔴 换了服务器就删掉上一台的 refresh token（#392 评审跟进）：不删的话下次 restore()
    // 会把 A 的长效凭据当 Cookie 头发给 B —— 填错的、不可信的、或者渲染层被注入改掉的地址
    if (next.serverUrl !== before) auth.clearRefreshToken()
    return next
  })
  // 同步通道：preload 用 sendSync 取，渲染层 API_BASE 与本进程 auth.ts 读同一份（#392）
  ipcMain.on(IPC.configServerUrlSync, (event) => {
    event.returnValue = readConfig().serverUrl
  })

  ipcMain.handle(IPC.authLogin, (_e, input: AuthLoginInput) => auth.login(input))
  ipcMain.handle(IPC.authLoginByPhone, (_e, input: AuthPhoneLoginInput) => auth.loginByPhone(input))
  ipcMain.handle(IPC.authMfaVerify, (_e, input: AuthMfaInput) => auth.mfaVerify(input))
  ipcMain.handle(IPC.authMfaEnroll, (_e, input: AuthMfaInput) => auth.mfaEnroll(input))
  ipcMain.handle(IPC.authRefresh, () => auth.refresh())
  ipcMain.handle(IPC.authRestore, () => auth.restore())
  ipcMain.handle(IPC.authLogout, () => auth.logout())

  ipcMain.handle(IPC.printListPrinters, () => listPrinters())
  ipcMain.handle(IPC.printHtml, (_e, html: string, options?: PrintOptions) =>
    // 注意这里**不 throw**:printHtml 自己把失败编码进返回值。
    // 打印失败必须是渲染层能看到的一等状态,不能变成一个被 catch 吞掉的异常。
    printHtml(html, options)
  )
  ipcMain.handle(IPC.printHtmlToPdf, (_e, html: string, options?: PrintOptions) =>
    printHtmlToPdf(html, options)
  )

  ipcMain.handle(IPC.deviceList, () => listDevices())
  ipcMain.handle(IPC.deviceStart, (_e, id: string) => startDevice(id))
  ipcMain.handle(IPC.deviceStop, (_e, id: string) => stopDevice(id))
  ipcMain.handle(IPC.deviceSimulate, (_e, id: string, payload?: Record<string, unknown>) =>
    simulateDevice(id, payload)
  )
  onDeviceEvent((event) => broadcast(IPC.deviceEvent, event))

  ipcMain.handle(IPC.updaterCheck, () => checkForUpdates((e) => broadcast(IPC.updaterEvent, e)))
  ipcMain.handle(IPC.updaterQuitAndInstall, () => quitAndInstall())
}

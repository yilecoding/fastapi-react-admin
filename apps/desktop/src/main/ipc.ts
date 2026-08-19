import { BrowserWindow, ipcMain } from "electron"

import { IPC } from "@admin/platform/desktop/contract"
import type { AuthLoginInput, DesktopConfig, PrintOptions } from "@admin/platform/desktop/contract"

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
  ipcMain.handle(IPC.configSet, (_e, patch: Partial<DesktopConfig>) => writeConfig(patch))

  ipcMain.handle(IPC.authLogin, (_e, input: AuthLoginInput) => auth.login(input))
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

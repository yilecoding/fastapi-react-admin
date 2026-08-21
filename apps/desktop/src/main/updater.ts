import type { UpdaterEvent } from "@admin/platform/desktop/contract"
import { app } from "electron"

import { readConfig } from "./config"

/**
 * 自动更新。用 electron-updater 的 generic provider —— 服务端只需要一个能列目录的
 * 静态 HTTP 服务(现成的 IIS 就够),不需要 GitHub Releases。
 *
 * 惰性 import:开发模式下根本不加载它,而且没配 updateUrl 时也不必把它拉进内存。
 */

type Emit = (event: UpdaterEvent) => void

let wired = false

async function getUpdater() {
  const { updateUrl } = readConfig()
  if (!updateUrl) return null
  if (!app.isPackaged) return null // 开发模式没有 app-update.yml,强跑只会报一句误导人的错
  const { autoUpdater } = await import("electron-updater")
  autoUpdater.setFeedURL({ provider: "generic", url: updateUrl })
  autoUpdater.autoDownload = true
  // 下载完不要自动重启 —— 自助终端正在给用户办业务时弹重启是事故
  autoUpdater.autoInstallOnAppQuit = true
  return autoUpdater
}

export async function checkForUpdates(emit: Emit): Promise<void> {
  const updater = await getUpdater()
  if (!updater) {
    emit({ kind: "not-available" })
    return
  }
  if (!wired) {
    wired = true
    updater.on("checking-for-update", () => emit({ kind: "checking" }))
    updater.on("update-available", (i) => emit({ kind: "available", version: i.version }))
    updater.on("update-not-available", () => emit({ kind: "not-available" }))
    updater.on("download-progress", (p) => emit({ kind: "progress", percent: p.percent }))
    updater.on("update-downloaded", (i) => emit({ kind: "downloaded", version: i.version }))
    updater.on("error", (e) => emit({ kind: "error", message: e.message }))
  }
  await updater.checkForUpdates()
}

export async function quitAndInstall(): Promise<void> {
  const updater = await getUpdater()
  updater?.quitAndInstall()
}

import type { UpdaterEvent } from "@admin/platform/desktop/contract"
import { app } from "electron"

import { readConfig } from "./config"

/**
 * 自动更新。**两个源，按优先级**：
 *
 * 1. `userData/config.json` 里的 `updateUrl` —— generic provider，服务端只要一个
 *    能列目录的静态 HTTP 服务（现成的 IIS 就够）。交付给内网客户时用这个
 * 2. 没填 `updateUrl` 就用打包时写进 `app-update.yml` 的那个源
 *    （`electron-builder.yml` 的 `publish`，现在指向 GitHub Release）
 *
 * 🔴 以前只支持第 1 条：没配 `updateUrl` 就直接 `return null`，于是从 GitHub
 * Release 装下来的包**永远查不到更新**，而界面上显示的是「已是最新版本」——
 * 一个假阴性，看不出坏了。
 *
 * 惰性 import：开发模式下根本不加载它。
 */

type Emit = (event: UpdaterEvent) => void

let wired = false

async function getUpdater() {
  // 开发模式没有 app-update.yml,强跑只会报一句误导人的错
  if (!app.isPackaged) return null
  /*
   * 🔴 `const { autoUpdater } = await import(...)` 在**正式包里拿到的是 undefined**。
   *
   * electron-updater 是 CommonJS，而主进程产物是 vite 打的 cjs bundle ——
   * 这条路径上 `import()` 回的是 `{ default: { autoUpdater } }`。两边都认才行。
   *
   * ⚠️ **开发模式永远撞不到这个 bug**：上面 `!app.isPackaged` 就早退了，
   * 根本不加载这个模块。正式包里的表现是
   * `Cannot read properties of undefined (reading 'setFeedURL')`。
   * （实测：下游项目的 0.0.x 正式包，2026-08-25）
   */
  const mod = (await import("electron-updater")) as unknown as {
    autoUpdater?: typeof import("electron-updater").autoUpdater
    default?: { autoUpdater?: typeof import("electron-updater").autoUpdater }
  }
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!autoUpdater) return null
  const { updateUrl } = readConfig()
  // 填了就覆盖成内网源；没填就**不动 feed**，用打包时写进 app-update.yml 的那个
  if (updateUrl) autoUpdater.setFeedURL({ provider: "generic", url: updateUrl })
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
  try {
    await updater.checkForUpdates()
  } catch (e) {
    /*
     * 🔴 失败必须是可见状态（根 CLAUDE.md 硬纪律 9）。这里最常见的失败是
     * **包里没有 app-update.yml**（打包时 `publish` 没配、或者用 `--dir` 出的包）——
     * electron-updater 直接抛。让它冒到 IPC 层的话渲染端拿到的是一个 rejected
     * promise，界面上通常什么都不显示；而 emit 一条 error，「检查更新」那一屏
     * 至少能说出原因。
     */
    emit({ kind: "error", message: e instanceof Error ? e.message : String(e) })
  }
}

export async function quitAndInstall(): Promise<void> {
  const updater = await getUpdater()
  /*
   * 🔴 必须显式 `(true, true)` = 静默安装 + 装完自动拉回来。
   *
   * `quitAndInstall()` 的 `isSilent` 默认是 `false`，而我们的 NSIS 是
   * `oneClick: false`（带向导，好处是首次安装能选目录）—— 两者一撞，
   * 拉起来的是**交互式安装向导**：应用退了、新版本没装上、界面上停在
   * 「下一步」等人点。自助终端/无人值守的机器上没人会去点。
   *
   * 实测判据（下游项目 2026-08-25 的落盘日志）：
   *   Install: isSilent: false, isForceRunAfter: true
   *   Update installer has already been triggered. Quitting application.
   * 之后 exe 仍然是旧版本 —— 安装器起来了，停在向导上。
   */
  updater?.quitAndInstall(true, true)
}

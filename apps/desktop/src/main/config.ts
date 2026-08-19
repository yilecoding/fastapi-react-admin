import { app } from "electron"
import fs from "node:fs"
import path from "node:path"

import type { DesktopConfig } from "@admin/platform/desktop/contract"

/**
 * 运行期配置。落在 `app.getPath('userData')/config.json`。
 *
 * 为什么必须是运行期而不是打包期：同一个安装包要发到不同部署环境/不同环境，
 * 后端地址、打印机名、是否 kiosk 都是逐台机器不同的。编译期写死意味着每换一个
 * 部署点就得重新出一个包。
 */

const DEFAULTS: DesktopConfig = {
  serverUrl: "",
  printerName: "",
  kiosk: false,
  autoLaunch: false,
  updateUrl: "",
}

let cache: DesktopConfig | null = null

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json")
}

/** 末尾斜杠会让后面所有 `${serverUrl}/api/...` 拼出双斜杠，统一在入口削掉 */
function normalize(patch: Partial<DesktopConfig>): Partial<DesktopConfig> {
  const out: Partial<DesktopConfig> = { ...patch }
  if (typeof out.serverUrl === "string") out.serverUrl = out.serverUrl.trim().replace(/\/+$/, "")
  if (typeof out.updateUrl === "string") out.updateUrl = out.updateUrl.trim().replace(/\/+$/, "")
  return out
}

export function readConfig(): DesktopConfig {
  if (cache) return cache
  let onDisk: Partial<DesktopConfig> = {}
  try {
    onDisk = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<DesktopConfig>
  } catch {
    // 首次运行文件不存在，或者被人手改坏了 —— 两种情况都退回默认值。
    // 这里**故意不抛**：配置坏了应该能进设置界面改，而不是应用起不来。
  }
  cache = { ...DEFAULTS, ...normalize(onDisk) }
  return cache
}

export function writeConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  const next = { ...readConfig(), ...normalize(patch) }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf8")
  cache = next
  return next
}

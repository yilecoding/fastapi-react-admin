/**
 * 开发时的编排器：watch 构建 main + preload，等 apps/web 的 dev server 起来，
 * 然后拉起 Electron；main/preload 改动后自动重启 Electron。
 *
 * 渲染层不在这里构建 —— 它由 `pnpm --filter web dev` 提供（http://localhost:1125）。
 * 所以完整的开发命令是两条：
 *     pnpm --filter web dev
 *     pnpm --filter @admin/desktop dev
 * 或者直接 `pnpm dev`（turbo 会把 api / web / desktop 一起拉起来）。
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import electronPath from "electron"
import { build } from "vite"

const DEV_SERVER_URL = process.env.DESKTOP_DEV_SERVER_URL ?? "http://localhost:1125"

/**
 * Linux（含 WSL）上的两件适配。放在 dev 脚本里而不是让人记命令行参数 ——
 * 记不住的东西迟早会变成「在我机器上跑不起来」。
 */
function linuxTweaks() {
  const args = []
  if (process.platform !== "linux") return args

  // 1) chrome-sandbox 必须是 root 所有且带 setuid 位，否则 Electron 直接拒绝启动。
  //    npm 装出来的包不具备这个条件（要 sudo chown root + chmod 4755），
  //    开发环境不值得为它动系统权限，退化成 --no-sandbox。
  const sandboxBin = path.join(path.dirname(electronPath), "chrome-sandbox")
  let sandboxUsable = false
  try {
    const st = fs.statSync(sandboxBin)
    sandboxUsable = st.uid === 0 && (st.mode & 0o4000) !== 0
  } catch {
    /* 文件不在就当不可用 */
  }
  if (!sandboxUsable) {
    console.warn("[desktop] chrome-sandbox 未配置 setuid，本次以 --no-sandbox 启动（仅开发环境）")
    args.push("--no-sandbox")
  }

  // 2) WSLg 下 DISPLAY 有时是空的，但 X socket 就在那儿
  if (!process.env.DISPLAY && fs.existsSync("/tmp/.X11-unix/X0")) {
    process.env.DISPLAY = ":0"
    console.info("[desktop] 检测到 WSLg，DISPLAY 自动设为 :0")
  }
  return args
}

const EXTRA_ARGS = [
  ...linuxTweaks(),
  // 需要额外参数（比如 --remote-debugging-port）时从环境变量塞
  ...(process.env.DESKTOP_ELECTRON_ARGS ? process.env.DESKTOP_ELECTRON_ARGS.split(/\s+/) : []),
]

/** @type {import('node:child_process').ChildProcess | null} */
let child = null
let restarting = false

function launchElectron() {
  if (child) {
    // 先摘掉 exit 监听，否则我们主动 kill 也会被当成「Electron 退出了，收工」
    child.removeAllListeners("exit")
    child.kill()
    child = null
  }
  child = spawn(electronPath, [".", ...EXTRA_ARGS], {
    stdio: "inherit",
    env: { ...process.env, DESKTOP_DEV_SERVER_URL: DEV_SERVER_URL, NODE_ENV: "development" },
  })
  child.on("exit", (code) => {
    // 用户自己关掉窗口 → 整个 dev 进程收工，不要留着 watcher 空转
    if (!restarting) process.exit(code ?? 0)
  })
}

function restartElectron() {
  restarting = true
  launchElectron()
  restarting = false
}

/** 每次重新构建完成就回调一次（首次构建也会触发） */
function watchPlugin(name, onBundle) {
  return {
    name: `desktop-dev-${name}`,
    closeBundle() {
      onBundle()
    },
  }
}

async function waitForDevServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  process.stdout.write(`[desktop] 等待渲染层 dev server: ${url} `)
  for (;;) {
    try {
      const res = await fetch(url, { method: "GET" })
      if (res.ok || res.status === 404) {
        process.stdout.write(" ok\n")
        return
      }
    } catch {
      /* 还没起来，继续等 */
    }
    if (Date.now() > deadline) {
      process.stdout.write("\n")
      throw new Error(
        `[desktop] ${timeoutMs / 1000}s 内没等到 ${url}。` +
          `先跑 \`pnpm --filter web dev\`，或用 DESKTOP_DEV_SERVER_URL 指到别的地址。`
      )
    }
    process.stdout.write(".")
    await new Promise((r) => setTimeout(r, 500))
  }
}

let bootstrapped = false
/** main 与 preload 各自首次构建完成后才允许启动 Electron，避免加载到半成品 */
const ready = { main: false, preload: false }

function markReady(which) {
  ready[which] = true
  if (!ready.main || !ready.preload) return
  if (!bootstrapped) {
    bootstrapped = true
    waitForDevServer(DEV_SERVER_URL)
      .then(launchElectron)
      .catch((err) => {
        console.error(String(err.message ?? err))
        process.exit(1)
      })
    return
  }
  console.log("[desktop] 主进程/preload 已重建，重启 Electron")
  restartElectron()
}

await Promise.all([
  build({
    configFile: "vite.main.config.ts",
    build: { watch: {} },
    plugins: [watchPlugin("main", () => markReady("main"))],
    logLevel: "warn",
  }),
  build({
    configFile: "vite.preload.config.ts",
    build: { watch: {} },
    plugins: [watchPlugin("preload", () => markReady("preload"))],
    logLevel: "warn",
  }),
])

// 开发期起 Celery：worker + beat。
//
// 🔴 Windows 上 celery 不支持 `-B`（内嵌 beat）：原来的脚本在 Windows 上直接退出，
// 报「-B option does not work on Windows」—— `pnpm dev` 里 worker 那一格挂掉，而 api / web 照常跑，
// 定时任务和异步通知全都静默不执行（工作台显示「心跳停在 N 小时前」）。
// 所以 Windows 上拆成两个进程，其他平台照旧 `-B`（一个进程、一个窗格）。
//
// PYTHONUTF8=1：系统代码页不是 UTF-8 的 Windows（如繁中 cp950）上，日志里的简体中文
// 会被写成乱码；api 那边同样的问题会直接让启动崩掉（见 apps/api/package.json）。
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../api")
const isWin = process.platform === "win32"
const env = {
  ...process.env,
  PYTHONUTF8: "1",
  CELERY_CUSTOM_WORKER_POOL: "celery_aio_pool.pool:AsyncIOPool",
}
const celery = ["run", "--no-sync", "celery", "-A", "backend.app.task.celery"]

const procs = [
  ["worker", [...celery, "worker", ...(isWin ? [] : ["-B"]), "-l", "info", "--pool=custom"]],
  ...(isWin ? [["beat", [...celery, "beat", "-l", "info"]]] : []),
].map(([name, args]) => {
  const child = spawn("uv", args, { cwd: apiDir, env, stdio: "inherit", shell: isWin })
  child.on("exit", (code) => {
    console.error(`[worker:dev] celery ${name} 退出（code ${code}）`)
    // 一个挂了就整体退出：只剩半套（有 worker 没 beat）比全挂更难发现
    shutdown(code ?? 1)
  })
  return child
})

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const p of procs) if (p.exitCode === null) p.kill()
  process.exitCode = code
}
process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

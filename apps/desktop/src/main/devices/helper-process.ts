import { app } from "electron"
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

/**
 * 原生助手子进程。**硬件一律走子进程,不要在主进程里直接 FFI 调厂商 DLL。**
 *
 * 理由不是省事,是崩溃隔离:厂商 DLL 是阻塞的、也是会崩的,跑在主进程里崩一次
 * 整个客户端就没了;跑在子进程里只是一个非零退出码,界面还能提示「请重新放卡」。
 * Rust 的内存安全**停在 FFI 边界上**,换语言帮不上这个忙 —— 所以这条与技术选型无关。
 *
 * 下面这些细节是从一套既有的 WPF 客户端实现里提炼出来的 —— 那边
 * 已经把这些坑踩平了,一条都不能少。
 */

/** 打包后原生助手在 resources/native;开发时用仓库里的 apps/desktop/resources */
export function nativeDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.resolve(app.getAppPath(), "resources")
}

export function nativeExists(exeName: string): boolean {
  return fs.existsSync(path.join(nativeDir(), exeName))
}

export interface OnceResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 起一次子进程、拿一次结果。适合 `--warmup` 这类一次性动作。
 *
 * 四个必须项:
 *  - **cwd 指到 exe 所在目录**。厂商 DLL 就躺在它旁边,工作目录不对的表现是
 *    「设备打不开」,而不是一个能看懂的报错。
 *  - **两条管道都按 UTF-8 解码**。现场机器实测有 ACP=950/Big5,不显式指定会拿到乱码。
 *  - **两条管道并发抽干再等退出**。execFile 内部就是这么做的,所以这里用它而不是
 *    spawn + 手动 wait —— 后者顺序写反就是经典死锁。
 *  - **超时后强杀**。这个超时必须**大于**助手自己的读卡超时,否则助手会先被杀掉、
 *    跳过它的 close 调用,把设备句柄留在占用状态。
 */
export function runOnce(
  exeName: string,
  args: string[] = [],
  timeoutMs = 8000
): Promise<OnceResult> {
  const cwd = nativeDir()
  const exe = path.join(cwd, exeName)
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((err as unknown as { code: number }).code ?? -1)
            : err
              ? -1
              : 0
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" })
      }
    )
  })
}

/** stdin 被 ignore 掉之后 spawn 的实际返回类型 */
type HelperChild = ChildProcessByStdio<null, Readable, Readable>

export interface LongLivedOptions {
  exeName: string
  args?: string[]
  /** stdout 每收到一行就回调一次(已去掉换行) */
  onLine: (line: string) => void
  /** stderr 是诊断通道,不当结果用 —— 但必须记下来,不能吞 */
  onDiagnostic?: (line: string) => void
  onExit?: (code: number | null) => void
  /** 异常退出后的重启退避上限(毫秒),默认 30s */
  maxBackoffMs?: number
}

/**
 * 长驻助手进程 + 行分隔事件流。**这是推荐的形状。**
 *
 * 既有实现是「每次刷卡起一个进程」,于是首刷要付 20.4 秒(其中 17.9 秒是杀软
 * 扫这个 exe),只好再加个 `--warmup` 把这笔成本藏到启动时;稳定态仍要 ~1.2 秒。
 * 改成常驻之后两笔成本一起消失,而且能做到「放卡即读」,操作员不用先点按钮。
 */
export class LongLivedHelper {
  private child: HelperChild | null = null
  private stopping = false
  private backoffMs = 500
  private restartTimer: NodeJS.Timeout | null = null

  // 不用构造函数参数属性：tsconfig 开了 erasableSyntaxOnly，那是不能被单纯擦除的 TS 语法
  private readonly opts: LongLivedOptions

  constructor(opts: LongLivedOptions) {
    this.opts = opts
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null
  }

  start(): void {
    if (this.running) return
    this.stopping = false

    const cwd = nativeDir()
    const exe = path.join(cwd, this.opts.exeName)
    // stdin 显式 ignore：助手不需要输入，留着一条没人写的管道只会在它退出时
    // 制造 EPIPE 噪音。对应的类型就是 ChildProcessByStdio<null, Readable, Readable>
    const child: HelperChild = spawn(exe, this.opts.args ?? [], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.child = child

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed) this.opts.onLine(trimmed)
    })
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed) this.opts.onDiagnostic?.(trimmed)
    })

    child.on("exit", (code) => {
      this.child = null
      this.opts.onExit?.(code)
      if (this.stopping) return
      // 助手意外退出(设备被拔、驱动崩了)要自愈,但要退避 ——
      // 不退避的话拔掉读卡器会变成每秒重启一次的忙循环,日志瞬间刷爆。
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000)
      this.restartTimer = setTimeout(() => this.start(), delay)
    })

    // 连续跑满 10 秒就认为这次启动是健康的,把退避重置回去
    setTimeout(() => {
      if (this.running) this.backoffMs = 500
    }, 10_000)
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }
}

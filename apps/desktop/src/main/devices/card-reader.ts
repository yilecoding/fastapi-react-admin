import type { CardReaderEvent, DeviceEvent, DeviceInfo, DeviceStatus } from "@admin/platform/desktop/contract"

import { LongLivedHelper, nativeExists } from "./helper-process"
import type { DeviceAdapter } from "./types"

/**
 * 身份证读卡器适配器。
 *
 * 两种模式,按 resources/ 里有没有助手程序自动选:
 *  - **真实模式**:长驻 `ReadCard.exe --serve`,stdout 吐行分隔 JSON。
 *  - **桩模式**:助手不存在时启用,`simulate()` 手动发假事件。没有硬件也能把
 *    整条链路(设备事件 → 渲染层 → 打印)联调通,这正是模板该给的东西。
 *
 * ⚠️ 现有的 `ReadCard.exe` 还是「起一次进程读一次卡」的形状(stdout 只输出证件号
 *    后 6 位、用退出码表达成败)。要用真实模式,得先给它加一个 `--serve`:
 *    开一次设备常驻,每次读到卡就往 stdout 打一行 JSON。改动落在已经跑熟的那份
 *    C# 上,很小 —— 而这里的契约先按目标形状定好,到时候直接接上。
 */

const HELPER_EXE = "ReadCard.exe"

interface HelperLine {
  ev: "card" | "removed" | "error" | "ready"
  id?: string
  name?: string
  code?: number
  message?: string
  [k: string]: unknown
}

export class CardReaderAdapter implements DeviceAdapter {
  readonly id = "card-reader"
  readonly label = "身份证读卡器"

  private status: DeviceStatus = "stopped"
  private error?: string
  private helper: LongLivedHelper | null = null
  private emit: ((event: DeviceEvent) => void) | null = null

  /** resources/ 里没有助手程序就跑桩模式 */
  get stubbed(): boolean {
    return !nativeExists(HELPER_EXE)
  }

  info(): DeviceInfo {
    return {
      id: this.id,
      label: this.stubbed ? `${this.label}（桩）` : this.label,
      status: this.status,
      error: this.error,
    }
  }

  private push(payload: CardReaderEvent): void {
    // 时间戳由主进程盖。渲染层自己 Date.now() 的话,和助手/后端的时钟对不上
    this.emit?.({ deviceId: this.id, at: Date.now(), payload })
  }

  async start(emit: (event: DeviceEvent) => void): Promise<void> {
    this.emit = emit
    if (this.status === "ready" || this.status === "starting") return

    if (this.stubbed) {
      this.status = "ready"
      this.error = undefined
      return
    }

    this.status = "starting"
    this.error = undefined
    this.helper = new LongLivedHelper({
      exeName: HELPER_EXE,
      args: ["--serve"],
      onLine: (line) => {
        let msg: HelperLine
        try {
          msg = JSON.parse(line) as HelperLine
        } catch {
          // 助手打了非 JSON 的东西。当诊断记下来,**不要**当成读卡结果 ——
          // 旧实现就是把一句中文错误当成了身份证号,界面还提示「刷卡成功」。
          console.warn("[card-reader] 非 JSON 输出:", line)
          return
        }
        switch (msg.ev) {
          case "ready":
            this.status = "ready"
            break
          case "card":
            if (msg.id) this.push({ kind: "card", idNumber: msg.id, name: msg.name, raw: msg })
            break
          case "removed":
            this.push({ kind: "removed" })
            break
          case "error":
            this.push({ kind: "error", code: msg.code ?? -1, message: msg.message ?? "未知错误" })
            break
        }
      },
      onDiagnostic: (line) => console.info("[card-reader:stderr]", line),
      onExit: (code) => {
        this.status = "error"
        this.error = `读卡助手退出（code=${code}），正在重试`
      },
    })
    this.helper.start()
  }

  async stop(): Promise<void> {
    this.helper?.stop()
    this.helper = null
    this.status = "stopped"
  }

  /** 桩模式下手动造一张卡。默认给一个校验位正确的测试号 */
  simulate(payload?: Record<string, unknown>): void {
    if (this.status !== "ready") throw new Error("读卡器未启动")
    const idNumber = typeof payload?.idNumber === "string" ? payload.idNumber : "11010119900307391X"
    const name = typeof payload?.name === "string" ? payload.name : "测试用户"
    this.push({ kind: "card", idNumber, name, raw: { simulated: true } })
  }
}

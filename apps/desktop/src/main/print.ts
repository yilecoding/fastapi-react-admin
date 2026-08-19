import { BrowserWindow, webContents } from "electron"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { PdfResult, PrinterInfo, PrintOptions, PrintResult } from "@admin/platform/desktop/contract"

import { readConfig } from "./config"

/**
 * 静默打印。**这是选 Electron 而不是 Tauri 的决定性理由**，所以这个文件值得多写注释。
 *
 * Electron 的 `webContents.print({ silent: true })` 能不弹对话框直接送打印机 —— 但只对
 * **HTML 内容**成立。Chromium 的 PDF 阅读器是扩展实现的，`webContents.print()` 够不着它
 * （electron#27383），所以「加载一个现成 PDF 再静默打」这条路是不通的。
 *
 * 对应到业务上：标签应该由前端渲染成 HTML + CSS `@page`，而不是后端出 PDF 再下发。
 * 顺带的好处是版式可以在 DevTools 里所见即所得地调，而不是改 xlsx 模板、重新部署、
 * 跑到终端机上打一张看看。
 */

/** 打印用的隐藏窗口不要有 preload、不要有 Node，只是个渲染画布 */
function createPrintWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 有些贴纸模板会用 JS 画条码/二维码，留着
      javascript: true,
      // ⚠️ 不能开 offscreen：离屏窗口的 print() 行为不可靠
      offscreen: false,
    },
  })
}

/**
 * 等内容真的可打印了再下命令。
 * `did-finish-load` 只保证 load 事件发生，字体和图片解码可能还没完 ——
 * 抢在那之前打印，二维码会缺一块，或者字体回落成宋体。
 */
const WAIT_FOR_PAINT = `
Promise.all([
  document.fonts ? document.fonts.ready : Promise.resolve(),
  ...Array.from(document.images).map((img) =>
    img.complete ? Promise.resolve() : img.decode().catch(() => undefined)
  ),
]).then(() => true)
`

export async function listPrinters(): Promise<PrinterInfo[]> {
  // 借任一个已有的 webContents 来问系统打印机列表；一个都没有就临时开一个
  const existing = webContents.getAllWebContents()[0]
  const owner = existing ?? createPrintWindow().webContents
  try {
    const printers = await owner.getPrintersAsync()
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      options: (p.options ?? {}) as Record<string, unknown>,
    }))
  } finally {
    if (!existing) {
      const win = BrowserWindow.fromWebContents(owner)
      if (win && !win.isDestroyed()) win.destroy()
    }
  }
}

/**
 * 把 HTML 渲染进一个隐藏窗口，交给 fn 处理，然后无条件收拾干净。
 * 打印与导出 PDF 共用这一条渲染管线 —— 两者必须走同一条路，
 * 否则「在 Mac 上导出的 PDF 看着没问题、到 Windows 打出来不一样」会变成常态。
 */
async function withRenderedPage<T>(
  html: string,
  timeoutMs: number,
  onTimeout: (elapsedMs: number) => T,
  fn: (win: BrowserWindow) => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  // 用临时文件而不是 data: URL。贴纸里嵌一张二维码 PNG 的 data URI 很容易把 URL
  // 撑到 Chromium 的长度上限之上，届时表现是「白页」而不是报错。
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "admin-print-"))
  const tmpFile = path.join(tmpDir, "label.html")
  await fs.writeFile(tmpFile, html, "utf8")

  const win = createPrintWindow()
  try {
    const job = (async () => {
      await win.loadURL(pathToFileURL(tmpFile).toString())
      await win.webContents.executeJavaScript(WAIT_FOR_PAINT, true)
      return await fn(win)
    })()
    const timeout = new Promise<T>((resolve) =>
      setTimeout(() => resolve(onTimeout(Date.now() - startedAt)), timeoutMs)
    )
    return await Promise.race([job, timeout])
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function printHtml(html: string, options: PrintOptions = {}): Promise<PrintResult> {
  const startedAt = Date.now()
  const cfg = readConfig()
  const deviceName = options.deviceName || cfg.printerName || undefined
  const timeoutMs = options.timeoutMs ?? 10_000

  try {
    return await withRenderedPage<PrintResult>(
      html,
      timeoutMs,
      (elapsedMs) => ({
        ok: false,
        reason: `打印超时（${timeoutMs}ms）：内容没能在限定时间内渲染完成`,
        elapsedMs,
      }),
      (win) =>
        new Promise<PrintResult>((resolve) => {
          win.webContents.print(
            {
              silent: true,
              deviceName,
              // 不打背景色的话贴纸上的色块/反白区域会全白 —— 默认必须是 true
              printBackground: options.printBackground ?? true,
              // 标签纸没有页边距可言。留着 Chromium 的默认边距会整体位移，
              // 严重时把内容挤到第二页去（以前的项目踩过同一类问题）
              margins: { marginType: "none" },
              landscape: options.landscape ?? false,
              copies: options.copies ?? 1,
              // ⚠️ print() 的 pageSize 单位是**微米**：60mm × 40mm → 60000 × 40000
              ...(options.pageSize ? { pageSize: options.pageSize } : {}),
            },
            (success, failureReason) => {
              resolve({
                ok: success,
                reason: success ? undefined : failureReason,
                elapsedMs: Date.now() - startedAt,
              })
            }
          )
        })
    )
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startedAt,
    }
  }
}

/** 微米 → 英寸。printToPDF 的 pageSize 单位和 print() 不一样，见下 */
function micronsToInches(microns: number): number {
  return microns / 25_400
}

export async function printHtmlToPdf(html: string, options: PrintOptions = {}): Promise<PdfResult> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 10_000

  try {
    return await withRenderedPage<PdfResult>(
      html,
      timeoutMs,
      (elapsedMs) => ({
        ok: false,
        reason: `导出 PDF 超时（${timeoutMs}ms）`,
        elapsedMs,
      }),
      async (win) => {
        const buffer = await win.webContents.printToPDF({
          printBackground: options.printBackground ?? true,
          landscape: options.landscape ?? false,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          // ⚠️⚠️ 单位陷阱：print() 的 pageSize 是**微米**，printToPDF() 的是**英寸**。
          // 两处直接传同一个对象，导出的 PDF 会大出 25400 倍，表现是「一张巨大的空白页」。
          ...(options.pageSize
            ? {
                pageSize: {
                  width: micronsToInches(options.pageSize.width),
                  height: micronsToInches(options.pageSize.height),
                },
              }
            : {}),
          // ⚠️ 恒为 true，而不是「没给 pageSize 时才 true」。实测（Electron 42 / Skia m148，
          // 目标 60mm × 40mm）：
          //     只传 pageSize                     → 60.367 × 40.217mm（偏大 0.61% / 0.54%）
          //     preferCSSPageSize + @page         → 59.944 × 39.878mm（偏差 0.09% / 0.31%）
          //     两个都给且 HTML 有 @page          → 59.944 × 39.878mm（CSS 赢，取准的那个）
          //     两个都给但 HTML 没有 @page        → 60.367 × 40.217mm（回退到 pageSize）
          // 所以恒开是严格更优：有 @page 就用准的，没有也不会更差。
          // （Chromium 内部把页面尺寸量化到 1/300 英寸 = 0.24pt，上面所有数值都是 0.24 的整数倍，
          //   所以做不到零误差；能做的是别再叠一层多余的换算误差。）
          preferCSSPageSize: true,
        })
        return { ok: true, bytes: new Uint8Array(buffer), elapsedMs: Date.now() - startedAt }
      }
    )
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startedAt,
    }
  }
}

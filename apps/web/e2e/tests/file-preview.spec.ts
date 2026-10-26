import { request } from "@playwright/test"

import type { APIRequestContext, Page, Response } from "@playwright/test"

import { API_BASE, expect, loginToken, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"
import { zipStore } from "../utils/xlsx"

/**
 * 文件预览：渲染器的**资产**真的取到了，而不是退回了兜底。
 *
 * 守的是 `@file-viewer` 2.x → 3.x 升级时实测撞上的那一类失败 —— 预览**看起来是好的**：
 *
 * - pdf.worker 404 → PDF.js 退回主线程照样画出来，控制台只有一条 warning
 * - libarchive 的 worker 404 → 压缩包退回 ZIP/TAR 兼容模式，列表照样出来，
 *   只有 rar / 7z 打不开，界面上一行小字
 *
 * 根因是资源根目录（`viewer.tsx` 里的 `setDefaultFileViewerAssetBaseUrl`）：没设的话
 * renderer 去站点根目录取 `/vendor/...`，而资产发布在 `/file-viewer/vendor/...`。
 * 所以断言不看「画出来没有」（兜底也画得出来），看**资产请求本身**。
 *
 * 样本全部现造（最小 PDF / STORE zip / PCM wav），理由同 `utils/xlsx.ts`：
 * 不提交二进制固件。
 */

type Uploaded = { id: string; original_name: string; size: number }

/** 最小可用的单页 PDF。xref 偏移要算对，否则 PDF.js 会走「修复」路径，测不到正常加载 */
function buildPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

/** 1 秒、8kHz、16bit 单声道的正弦波 */
function buildWav(seconds = 1, rate = 8000): Buffer {
  const samples = seconds * rate
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write("WAVEfmt ", 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // 单声道
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write("data", 36)
  buf.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2)
  }
  return buf
}

/**
 * 记下这一页上 renderer 取的所有 `/vendor/` 资产。
 *
 * 只认 `/vendor/` 下的：那是 copyAssets 发布的 worker / wasm / 字体，
 * 也正是资源根目录设错时会 404 的那一批。
 *
 * ⚠️ 要排除 dev 服务器的模块请求：vite 把包里的 JS 从 `/@fs/…/dist/vendor/…`、
 * `/node_modules/…` 下发，路径里同样带 `/vendor/`，但那是 import 不是资产。
 */
function recordVendorAssets(page: Page) {
  const seen: { url: string; status: number }[] = []
  const onResponse = (res: Response) => {
    const { pathname } = new URL(res.url())
    if (pathname.startsWith("/@") || pathname.includes("/node_modules/")) return
    if (pathname.includes("/vendor/")) seen.push({ url: res.url(), status: res.status() })
  }
  page.on("response", onResponse)
  return seen
}

function expectAssetsHealthy(seen: { url: string; status: number }[], what: string) {
  for (const a of seen) {
    expect(a.status, `${what} 的资产取失败：${a.url}`).toBeLessThan(400)
    expect(new URL(a.url).pathname, `${what} 的资产不在 /file-viewer/ 下 —— 资源根目录没设上`).toMatch(
      /^\/file-viewer\/vendor\//
    )
  }
}

test.describe("文件预览 · 渲染器资产", () => {
  let ctx: APIRequestContext
  let token: string
  const created: string[] = []

  test.beforeAll(async () => {
    ctx = await request.newContext({ baseURL: API_BASE })
    token = (await loginToken(ctx)).token
  })

  test.afterAll(async () => {
    if (created.length > 0) {
      await ctx
        .delete(`${API_BASE}/api/v1/sys/files`, {
          headers: { Authorization: `Bearer ${token}` },
          data: { pks: [...created] },
        })
        .catch(() => {})
    }
    await ctx.dispose()
  })

  async function upload(ext: string, mimeType: string, buffer: Buffer): Promise<Uploaded> {
    // 名字带随机串：同人 + 同名 + 同内容会被秒传复用到上一轮的记录（见 file 分册）
    const name = `e2e-${uniqueCode("PV").toLowerCase()}.${ext}`
    const res = await ctx.post(`${API_BASE}/api/v1/sys/files/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { file: { name, mimeType, buffer } },
    })
    expect(res.ok(), `上传失败：${await res.text()}`).toBeTruthy()
    const file = ((await res.json()) as { data: Uploaded }).data
    created.push(file.id)
    return file
  }

  async function openPreview(page: Page, file: Uploaded) {
    await page.goto(`/system/file?view=list&name=${encodeURIComponent(file.original_name)}`)
    await page.getByTestId(`file-actions-${file.id}`).click()
    await page.getByTestId(`file-preview-${file.id}`).click()
    const dialog = page.getByTestId("file-preview-dialog")
    await expect(dialog).toBeVisible()
    return dialog
  }

  test("PDF：pdf.worker 从 /file-viewer/ 取到，不退回主线程", async ({ authedPage: page }) => {
    const file = await upload("pdf", "application/pdf", buildPdf("e2e pdf"))
    const seen = recordVendorAssets(page)
    const worker = page.waitForResponse((r) => r.url().includes("pdf.worker"))

    const dialog = await openPreview(page, file)
    // 画布出来只说明「画出来了」—— 主线程兜底也画得出来，所以下面还要看 worker 请求
    await expect(dialog.locator("canvas").first()).toBeVisible({ timeout: 20_000 })

    const res = await worker
    expect(res.status(), `pdf.worker 取失败：${res.url()}`).toBeLessThan(400)
    expectAssetsHealthy(seen, "PDF")
  })

  test("压缩包：libarchive 的 worker 起得来（不是 ZIP 兼容模式）", async ({ authedPage: page }) => {
    const file = await upload(
      "zip",
      "application/zip",
      zipStore([
        { name: "inside-a.txt", data: Buffer.from("a") },
        { name: "dir/inside-b.json", data: Buffer.from('{"b":1}') },
      ])
    )
    const seen = recordVendorAssets(page)
    const worker = page.waitForResponse((r) => r.url().includes("libarchive/worker-bundle"))

    const dialog = await openPreview(page, file)
    await expect(dialog.getByText("inside-a.txt").first()).toBeVisible({ timeout: 20_000 })

    const res = await worker
    expect(res.status(), `libarchive worker 取失败：${res.url()}`).toBeLessThan(400)
    expectAssetsHealthy(seen, "压缩包")
  })

  test("音频：media renderer 用 buffer 播得起来（时长读得出来）", async ({ authedPage: page }) => {
    const file = await upload("wav", "audio/wav", buildWav(1))

    const dialog = await openPreview(page, file)
    const audio = dialog.locator("audio")
    await expect(audio).toHaveCount(1, { timeout: 20_000 })
    // duration 读得出来 = 对象 URL 真的喂进了 <audio>、元数据解析成功
    await expect
      // e2e 的 tsconfig 不带 DOM 类型（没有 HTMLAudioElement），只断言要用的那一个字段
      .poll(() => audio.evaluate((el) => (el as unknown as { duration: number }).duration), { timeout: 10_000 })
      .toBeCloseTo(1, 1)
  })

  test("超过上限的音视频只给下载，连字节都不取", async ({ authedPage: page }) => {
    const file = await upload("wav", "audio/wav", buildWav(1))

    // 后端默认只收 20MB 以内的音频，真造一个超限的传不上来 ——
    // 只改列表接口里这一条的 size，让页面以为它有 200MB
    await page.route(/\/api\/v1\/sys\/files\?/, async (route) => {
      const res = await route.fetch()
      const body = (await res.json()) as { data: { items: Uploaded[] } }
      for (const item of body.data.items) if (item.id === file.id) item.size = 200 * 1024 * 1024
      await route.fulfill({ response: res, json: body })
    })
    const downloads: string[] = []
    page.on("request", (r) => {
      if (r.url().includes(`/sys/files/${file.id}/download`)) downloads.push(r.url())
    })

    const dialog = await openPreview(page, file)
    await expect(dialog.getByTestId("preview-media-too-large")).toBeVisible()
    await expect(dialog.locator("audio")).toHaveCount(0)
    expect(downloads, "超限的音视频不该去取字节（预览要整块读进内存）").toEqual([])
  })
})

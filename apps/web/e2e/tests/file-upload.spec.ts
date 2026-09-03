import { request } from "@playwright/test"

import { API_BASE, expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 文件管理：上传闭环 + 「读文件一律走带鉴权的接口」。
 *
 * 整个模块此前零 E2E，而它的两条约束都写在 `pages/file/AGENTS.md` 里，
 * 且**失败方式都不显眼**：
 *
 * 1. `download_url` 是详情模型上的 computed_field。曾经只有上传/详情带它、
 *    列表接口不带 → 前端拼出 `http://127.0.0.1:8000undefined`，
 *    弹窗只说「文件加载失败」，不会告诉你地址是拼错的。
 * 2. 落盘目录 `UPLOAD_DIR` **不在** `STATIC_DIR` 里，就是为了不被
 *    `app.mount('/static', …)` 连带公开 —— 那张表里有别人的文件。
 *    这条一旦被改回去，功能上**一切正常**，只是所有人的文件变成了公开可读。
 *
 * 第二条只能从「没有登录态的那一侧」去证：拿一个干净的 request context
 * （不带 Authorization）去打两个地址，都必须拿不到文件内容。
 */

// ⚠️ `name` 是**落盘名**（原名 + 随机后缀，避免同名互相覆盖），
// `original_name` 才是用户看到的那个。界面显示的、去重认的都是后者 ——
// 按 `name` 去断言会永远对不上（第一版就栽在这）。
type FileDetail = {
  id: string
  name: string
  original_name: string
  path: string
  download_url: string
}

test.describe("文件管理 · 上传与鉴权", () => {
  const created: string[] = []

  test.afterEach(async ({ api }) => {
    if (created.length > 0) await api.del("/api/v1/sys/files", { pks: [...created] }).catch(() => {})
    created.length = 0
  })

  test("上传 → 列表里出现 → 详情带得出 download_url", async ({ authedPage: page, api }) => {
    const name = `e2e-${uniqueCode("F").toLowerCase()}.txt`

    // 默认是网格视图（`search.view ?? 'grid'`），显式切成列表视图
    await page.goto("/system/file?view=list")
    // ⚠️ 等的是**上传按钮**，不是 `file-list` —— 后者只在列表非空时才渲染
    // （空态是另一个分支）。在上传之前断言它，库里恰好有文件时会绿、
    // 干净的库上必红：本地隔离跑绿了、全量跑红，就是这么来的。
    await expect(page.getByTestId("upload-file")).toBeVisible()

    // 真的走 <input type="file">，不是调接口 —— 这条测的就是这一段 UI 链路
    await page.getByTestId("file-input").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(`e2e upload ${name}`),
    })

    // 传完列表里要出现这一条（按文件名找，不依赖分页/总数 —— 见 e2e/AGENTS.md
    // 那条「不要断言默认视图里某条具体数据」的教训，这里的名字是本条测试独有的）
    await expect(page.getByTestId("file-list").getByText(name)).toBeVisible()

    const list = (await api.get(`/api/v1/sys/files?name=${encodeURIComponent(name)}`)) as {
      items: FileDetail[]
    }
    const mine = list.items.find((f) => f.original_name === name)
    expect(mine, "上传成功但接口里查不到这条记录").toBeTruthy()
    created.push(mine!.id)

    const detail = (await api.get(`/api/v1/sys/files/${mine!.id}`)) as FileDetail
    // 🔴 每个读取路径都要这个地址，所以它长在详情模型上。缺了它前端会拼出
    // `…8000undefined`，界面上只说「文件加载失败」
    expect(detail.download_url, "详情必须带 download_url").toBeTruthy()
    expect(detail.download_url).not.toContain("undefined")
  })

  test("🔴 没有登录态时，既下不到文件，也不能从 /static 绕过去", async ({ api }) => {
    const name = `e2e-${uniqueCode("F").toLowerCase()}.txt`
    const body = `secret ${name}`

    // 用带鉴权的客户端传一份，再换一个干净的 context 去读
    const ctx = await request.newContext({ baseURL: API_BASE })
    const token = await (async () => {
      const res = await ctx.post("/api/v1/auth/login/swagger", {
        params: { username: "admin", password: "123456" },
      })
      return ((await res.json()) as { access_token: string }).access_token
    })()
    const up = await ctx.post(`${API_BASE}/api/v1/sys/files/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from(body) } },
    })
    expect(up.ok(), `上传失败：${await up.text()}`).toBeTruthy()
    const uploaded = ((await up.json()) as { data: FileDetail }).data
    created.push(uploaded.id)
    await ctx.dispose()

    const detail = (await api.get(`/api/v1/sys/files/${uploaded.id}`)) as FileDetail

    // 干净的 context：没有 Authorization 头、没有任何 cookie
    const anon = await request.newContext()
    try {
      const viaApi = await anon.get(
        detail.download_url.startsWith("http")
          ? detail.download_url
          : `${API_BASE}${detail.download_url}`
      )
      expect(viaApi.ok(), "下载接口在没有登录态时不该给出文件").toBeFalsy()

      // 🔴 另一条路：直接猜静态地址。`UPLOAD_DIR` 刻意不在 `STATIC_DIR` 下，
      // 挪回去的话功能一切正常，只是所有人的文件都变成公开可读的
      const viaStatic = await anon.get(`${API_BASE}/static/upload/${detail.path}`)
      expect(
        viaStatic.status(),
        "私有附件不能从 /static 裸读到 —— 这条挂了就是越权读文件"
      ).not.toBe(200)
    } finally {
      await anon.dispose()
    }
  })

  test("同内容不同名要存成两条，不能被秒传去重吞掉", async ({ api }) => {
    const stamp = uniqueCode("F").toLowerCase()
    const bytes = Buffer.from(`same bytes ${stamp}`)
    const names = [`e2e-${stamp}-a.txt`, `e2e-${stamp}-b.txt`]

    const ctx = await request.newContext({ baseURL: API_BASE })
    const res = await ctx.post("/api/v1/auth/login/swagger", {
      params: { username: "admin", password: "123456" },
    })
    const token = ((await res.json()) as { access_token: string }).access_token

    for (const name of names) {
      const up = await ctx.post(`${API_BASE}/api/v1/sys/files/upload`, {
        headers: { Authorization: `Bearer ${token}` },
        multipart: { file: { name, mimeType: "text/plain", buffer: bytes } },
      })
      expect(up.ok(), `上传 ${name} 失败：${await up.text()}`).toBeTruthy()
      created.push(((await up.json()) as { data: FileDetail }).data.id)
    }
    await ctx.dispose()

    // 只按 sha256 去重的话，第二次会命中第一条记录 —— 表现是列表里仍然显示
    // 旧名字、按新名字**搜不到**（`pages/file/AGENTS.md` 里实测过的那条）
    for (const name of names) {
      const list = (await api.get(`/api/v1/sys/files?name=${encodeURIComponent(name)}`)) as {
        items: FileDetail[]
      }
      expect(
        list.items.some((f) => f.original_name === name),
        `按 ${name} 搜不到 —— 去重把用户起的名字丢了`
      ).toBeTruthy()
    }
    expect(new Set(created).size, "同内容不同名应该是两条独立记录").toBe(2)
  })
})

import { describe, expect, it } from "vitest"

import { DEV_API_BASE, resolveApiBase } from "./base-url"

/**
 * #392：release 构建把 `VITE_API_BASE` 置空，打包的桌面端里渲染层的 `API_BASE` 恒为 `''`，
 * 业务请求全打到 `app://local/api/v1/...`（协议处理器回 index.html），
 * 而主进程的登录读的是 `config.json` 的 `serverUrl` —— 两边不是同一个后端。
 */
describe("API 地址解析", () => {
  it("桌面端：用主进程那份 serverUrl，哪怕构建时 VITE_API_BASE 是空串", () => {
    expect(resolveApiBase("", { serverUrl: "https://admin.example.com" })).toBe("https://admin.example.com")
  })

  it("桌面端：构建时写了地址也以运行期配置为准（同一个包要能连不同环境）", () => {
    expect(resolveApiBase("https://build-time.example.com", { serverUrl: "https://runtime.example.com" })).toBe(
      "https://runtime.example.com"
    )
  })

  it("桌面端没配服务器地址：返回空串，交给登录页引导填写，不回落到开发地址", () => {
    expect(resolveApiBase(undefined, { serverUrl: "" })).toBe("")
  })

  it("末尾斜杠削掉，避免拼出 //api", () => {
    expect(resolveApiBase(undefined, { serverUrl: "https://admin.example.com/ " })).toBe("https://admin.example.com")
  })

  it("桌面端 config.json 被手改成不完整的地址：当没配，让登录页引导填写，不拿去拼相对路径（#392 评审跟进）", () => {
    // 不带协议的值会被 fetch 按 app://local 解析 —— 正是 #392 的症状（200 + index.html）
    expect(resolveApiBase(undefined, { serverUrl: "192.168.1.10:8088" })).toBe("")
    expect(resolveApiBase(undefined, { serverUrl: "https://admin.example.com/?env=prod" })).toBe("")
  })

  it("浏览器：生产同源构建的空串保留（不是 undefined 就不回落）", () => {
    expect(resolveApiBase("", null)).toBe("")
  })

  it("浏览器：没配环境变量回落到开发地址", () => {
    expect(resolveApiBase(undefined, null)).toBe(DEV_API_BASE)
  })

  it("老版本外壳的桥上没有 serverUrl 字段：按浏览器那条走，不炸", () => {
    expect(resolveApiBase("https://x.example.com", {})).toBe("https://x.example.com")
  })
})

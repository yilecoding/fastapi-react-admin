import { describe, expect, it } from "vitest"

import { embeddedSrc, embeddedUrl, externalUrl, httpUrl, serverBaseUrl } from "./http-url"

describe("HTTP(S) 外链", () => {
  it.each([
    [
      "https://example.com/help?q=1#intro",
      "https://example.com/help?q=1#intro",
    ],
    ["  HTTP://localhost:8088/help  ", "http://localhost:8088/help"],
    ["https://例子.测试/", "https://xn--fsqu00a.xn--0zwm56d/"],
  ])("放行完整地址 %s", (raw, expected) => {
    expect(httpUrl(raw)).toBe(expected)
  })

  it.each([
    "file://///attacker/share/x.exe",
    "ms-msdt:probe",
    "search-ms:probe",
    "custom-handler://probe",
    "javascript:alert(1)",
    "data:text/html,probe",
    "mailto:probe@example.com",
    "//example.com",
    "/help",
    "",
    "https://",
    "https:example.com",
    "https:///example.com",
    "https://example.com:99999",
    "ht\ntps://example.com",
    "https://exam\tple.com",
    "https://example.com\\path",
  ])("拒绝非网页协议或畸形地址 %s", (raw) => {
    expect(httpUrl(raw)).toBeNull()
  })
})

describe("桌面系统浏览器外开", () => {
  it.each([
    [
      "MAILTO:a@example.com?SUBJECT=Hello&body=First%0D%0ASecond&cc=b@example.com&bcc=c@example.com",
      "mailto:a@example.com?SUBJECT=Hello&body=First%0D%0ASecond&cc=b@example.com&bcc=c@example.com",
    ],
    [
      "mailto:a@example.com?subject=Hello%20world&body=A%26attach%3Dfile",
      "mailto:a@example.com?subject=Hello%20world&body=A%26attach%3Dfile",
    ],
  ])("允许大小写协议与标准邮件参数 %s", (raw, expected) => {
    expect(externalUrl(raw)).toBe(expected)
  })

  it.each([
    "mailto:a@example.com?attach=//host/share/x",
    "mailto:a@example.com?ATTACH=file:///tmp/x",
    "mailto:a@example.com?%61ttach=//host/share/x",
    "mailto:a@example.com?subject=hello&attachment=x",
    "mailto:a@example.com?subject=Hi%0D%0AAttach%3Ax",
    "mailto:a@example.com?cc=b@example.com%0abcc:c@example.com",
    "mailto:a@example.com%0d%0aAttach:x",
    "mailto:a@example.com%5cevil",
    "mailto:a@example.com?body=%00",
    "mailto://host/a@example.com",
  ])("拒绝附件参数与邮件头注入 %s", (raw) => {
    expect(externalUrl(raw)).toBeNull()
  })

  it("允许 mailto，同时保留 HTTP(S) 并拒绝 tel 和危险协议", () => {
    expect(externalUrl("mailto:a@example.com")).toBe("mailto:a@example.com")
    expect(externalUrl("https://example.com/help")).toBe(
      "https://example.com/help"
    )
    expect(externalUrl("tel:+88612345678")).toBeNull()
    expect(externalUrl("javascript:alert(1)")).toBeNull()
    expect(externalUrl("mailto:")).toBeNull()
    expect(externalUrl("mailto:a@example.com\\evil")).toBeNull()
  })
})

describe("内嵌菜单地址", () => {
  it("按 Web 根地址解析，桌面开发和生产都不加载相对地址", () => {
    expect(embeddedSrc("/help?q=1#top", "https://admin.example")).toBe(
      "https://admin.example/help?q=1#top"
    )
    expect(embeddedSrc("/help", "app://local", true)).toBeNull()
    expect(embeddedSrc("/help", "http://localhost:8888", true)).toBeNull()
    expect(embeddedSrc("/help", "null")).toBeNull()
    expect(embeddedSrc("https://example.com/help", "null", true)).toBe(
      "https://example.com/help"
    )
    expect(
      embeddedSrc("//attacker.example", "https://admin.example")
    ).toBeNull()
  })

  it.each(["/help", "/help?q=1#top", "/api/docs/"])(
    "允许同源路径 %s",
    (raw) => {
      expect(embeddedUrl(raw)).toBe(raw)
    }
  )

  it("保留完整网页地址", () => {
    expect(embeddedUrl("https://example.com/help")).toBe(
      "https://example.com/help"
    )
  })

  it.each([
    "//attacker.example/path",
    "help",
    "\\\\attacker.example",
    "/help\\evil",
  ])("拒绝非同源路径 %s", (raw) => expect(embeddedUrl(raw)).toBeNull())
})

/**
 * 桌面端的服务器地址（#392 评审跟进）：渲染层按 `${API_BASE}${path}` 拼请求，
 * 带查询串 / 片段的地址会把路径拼进查询串里（打到站点根、拿回 HTML），
 * 带账号密码的地址 Chromium 的 fetch 直接拒绝构造请求 —— 都要在入口挡住。
 */
describe("桌面端服务器地址", () => {
  it.each([
    ["https://admin.example.com", "https://admin.example.com"],
    [" https://admin.example.com/ ", "https://admin.example.com"],
    ["http://192.168.1.10:8088", "http://192.168.1.10:8088"],
    ["https://example.com/admin/", "https://example.com/admin"],
    ["HTTPS://Admin.Example.com", "https://admin.example.com"],
  ])("放行 %s", (raw, expected) => expect(serverBaseUrl(raw)).toBe(expected))

  it.each([
    "",
    "admin.example.com",
    "192.168.1.10:8088",
    "file:///etc/passwd",
    "https://admin.example.com/?env=prod",
    "https://admin.example.com/#x",
    "https://u:p@admin.example.com",
    "https://u@admin.example.com",
  ])("拒绝 %s", (raw) => expect(serverBaseUrl(raw)).toBeNull())
})

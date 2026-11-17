import { describe, expect, it } from "vitest"

import { embeddedUrl, externalUrl, httpUrl } from "./http-url"

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

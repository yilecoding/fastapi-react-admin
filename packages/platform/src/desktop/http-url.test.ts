import { describe, expect, it } from "vitest"

import { httpUrl } from "./http-url"

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

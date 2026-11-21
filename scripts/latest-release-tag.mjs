#!/usr/bin/env node
// 打印远端 origin 上最高的正式版 tag（vX.Y.Z），没有就打印空。给 ci.yml「迁移链：从最近一个 release 升到当前」取基线。
//
// 🔴 「读不到远端」和「确实没有 tag」必须分开（#393）。原来是
// `TAG=$(git ls-remote … | head -1 || true)`：ls-remote 瞬时失败时 TAG 也是空，走进「没有 release tag（fork？），跳过」，
// 那一轮 CI 里漏写迁移的唯一真守卫静默跳过、显示绿。现在读失败重试几次，还不行就非零退出、不打印任何东西。
//
// 只认正式版：预发布（v1.1.0-rc.1）不算 —— 用户是从正式版升上来的。按数字比（v1.10.0 > v1.9.3）。
import { execFileSync } from "node:child_process"

const retrySeconds = Number(process.env.LATEST_TAG_RETRY_SECONDS ?? 5)
const attempts = 3

let out
for (let i = 1; ; i++) {
  try {
    out = execFileSync(
      "git",
      ["ls-remote", "--tags", "--refs", "origin", "v*"],
      {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    break
  } catch (e) {
    const why = String(e.stderr || e.message).trim()
    if (i >= attempts) {
      console.error(`::error::读不到远端的 tag（试了 ${attempts} 次）：${why}`)
      process.exit(1)
    }
    console.error(`读远端 tag 失败，${retrySeconds} 秒后重试：${why}`)
    await new Promise((r) => setTimeout(r, retrySeconds * 1000))
  }
}

const versions = out
  .split("\n")
  .map((line) => /\trefs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/.exec(line))
  .filter(Boolean)
  .map((m) => ({
    tag: m[1],
    parts: [Number(m[2]), Number(m[3]), Number(m[4])],
  }))
  .sort(
    (a, b) =>
      b.parts[0] - a.parts[0] ||
      b.parts[1] - a.parts[1] ||
      b.parts[2] - a.parts[2]
  )

if (versions.length) console.log(versions[0].tag)

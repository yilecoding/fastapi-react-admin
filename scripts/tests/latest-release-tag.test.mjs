import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// ci.yml「迁移链：从最近一个 release 升到当前」取基线 tag 用（#393）。
// 原来是 `git ls-remote … | head -1 || true`：远端读失败和「fork 没有 tag」走同一个分支，守卫静默跳过、显示绿。
const script = fileURLToPath(
  new URL("../latest-release-tag.mjs", import.meta.url)
)

function repo(t) {
  const root = mkdtempSync(path.join(tmpdir(), "fra-latest-tag-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  }
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  git("init", "--initial-branch=main")
  git("config", "user.name", "Tag test")
  git("config", "user.email", "tag@example.invalid")
  git("commit", "--allow-empty", "-m", "A")
  git("init", "--bare", "remote.git")
  git("remote", "add", "origin", path.join(root, "remote.git"))
  git("push", "-q", "origin", "main")
  const run = () =>
    spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...env, LATEST_TAG_RETRY_SECONDS: "0" },
      encoding: "utf8",
    })
  return { git, run, root }
}

test("取最高的正式版：按数字比，不按字符串比；预发布和别的 tag 不算", (t) => {
  const { git, run } = repo(t)
  for (const tag of [
    "v1.2.0",
    "v1.9.3",
    "v1.10.0",
    "v1.11.0-rc.1",
    "v2.0.0-beta",
    "vnext",
    "release-9",
  ]) {
    git("tag", tag)
  }
  git("push", "-q", "origin", "--tags")
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, "v1.10.0\n")
})

test("确实没有 tag（fork）→ 成功、输出空", (t) => {
  const { run } = repo(t)
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, "")
})

test("只有预发布 → 也是「没有正式版」，输出空", (t) => {
  const { git, run } = repo(t)
  git("tag", "v1.0.0-rc.1")
  git("push", "-q", "origin", "--tags")
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, "")
})

test("远端读不到 → 失败，绝不输出空串冒充「没有 tag」", (t) => {
  const { git, run, root } = repo(t)
  git("remote", "set-url", "origin", path.join(root, "missing.git"))
  const r = run()
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, "")
  assert.match(r.stderr, /读不到/)
})

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// release.yml 的「tag 的提交在 main 上，且 CI 已经绿了」闸门（#232 / #393）。
// 用一个假的 `gh` 顶替 GitHub API：compare 接口回什么、CI 运行一轮轮回什么，由场景文件决定。
const script = fileURLToPath(new URL("../release-gate.mjs", import.meta.url))
const SHA = "a".repeat(40)

function setup(t, scenario) {
  const root = mkdtempSync(path.join(tmpdir(), "fra-release-gate-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, "scenario.json"), JSON.stringify(scenario))
  writeFileSync(path.join(root, "calls"), "")
  // 假 gh：只认 `gh api <路径>`，按路径回场景里的 JSON；runs 接口每调一次往后取一条
  const fake = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const dir = ${JSON.stringify(root)}
const s = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))
const [cmd, route] = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls'), route + '\\n')
if (cmd !== 'api') process.exit(2)
if (route.includes('/compare/')) {
  if (s.compare === 'error') { console.error('HTTP 502'); process.exit(1) }
  process.stdout.write(JSON.stringify({ status: s.compare })); process.exit(0)
}
if (route.includes('/actions/workflows/ci.yml/runs')) {
  const f = path.join(dir, 'runs-i')
  const i = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0
  fs.writeFileSync(f, String(i + 1))
  const run = s.runs[Math.min(i, s.runs.length - 1)]
  if (run === 'error') { console.error('HTTP 502'); process.exit(1) }
  process.stdout.write(JSON.stringify({ workflow_runs: run ? [run] : [] })); process.exit(0)
}
process.exit(3)
`
  const gh = path.join(root, "gh")
  writeFileSync(gh, fake)
  chmodSync(gh, 0o755)
  const output = path.join(root, "output")
  return function run(tag, sha = SHA) {
    writeFileSync(output, "")
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        GITHUB_REF_NAME: tag,
        GITHUB_SHA: sha,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_OUTPUT: output,
        RELEASE_GATE_POLL_SECONDS: "0",
        RELEASE_GATE_MAX_POLLS: "4",
        RELEASE_GATE_REGISTER_POLLS: "2",
      },
      encoding: "utf8",
    })
    return {
      ...result,
      output: readFileSync(output, "utf8"),
      calls: readFileSync(path.join(root, "calls"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean),
    }
  }
}

const green = {
  status: "completed",
  conclusion: "success",
  html_url: "https://ci/1",
}
const red = {
  status: "completed",
  conclusion: "failure",
  html_url: "https://ci/1",
}
const running = {
  status: "in_progress",
  conclusion: null,
  html_url: "https://ci/1",
}

test("正式版：提交在 main 上且 CI 绿 → 放行，prerelease=false", (t) => {
  const run = setup(t, { compare: "behind", runs: [green] })
  const r = run("v1.2.3")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.output, "prerelease=false\n")
})

test("预发布：提交在 main 上且 CI 绿 → 放行，prerelease=true", (t) => {
  const run = setup(t, { compare: "identical", runs: [green] })
  const r = run("v1.2.3-rc.1")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.output, "prerelease=true\n")
})

// 🔴 #393 之前预发布 tag 在这两种情况下都 exit 0（「预发布 tag，放行」），
// 草稿里照样有 latest.yml，维护者点了发布就成了桌面端的自动更新
for (const tag of ["v1.2.3", "v1.2.3-rc.1", "v1.2.3-x"]) {
  test(`${tag}：提交不在 main 上 → 拦，且不再去查 CI`, (t) => {
    const run = setup(t, { compare: "diverged", runs: [green] })
    const r = run(tag)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /不在 main 上/)
    assert.equal(r.output, "")
    assert.ok(!r.calls.some((c) => c.includes("/runs")), r.calls.join(","))
  })

  test(`${tag}：CI 红 → 拦`, (t) => {
    const run = setup(t, { compare: "behind", runs: [red] })
    const r = run(tag)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /failure/)
    assert.equal(r.output, "")
  })
}

test("main 领先的提交（ahead）也不算在 main 上", (t) => {
  const run = setup(t, { compare: "ahead", runs: [green] })
  assert.notEqual(run("v1.2.3-rc.1").status, 0)
})

test("CI 还在跑 → 等它跑完再判", (t) => {
  const run = setup(t, { compare: "behind", runs: [running, running, green] })
  const r = run("v1.2.3-rc.1")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.calls.filter((c) => c.includes("/runs")).length, 3)
})

test("CI 一直没跑完 → 等满次数后拦", (t) => {
  const run = setup(t, { compare: "behind", runs: [running] })
  const r = run("v1.2.3-rc.1")
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /还没跑完/)
})

test("CI 没登记 → 等几轮，还没有就拦", (t) => {
  const run = setup(t, { compare: "behind", runs: [null] })
  const r = run("v1.2.3-rc.1")
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /找不到/)
  assert.equal(r.calls.filter((c) => c.includes("/runs")).length, 2)
})

test("CI 晚登记 → 登记上之后照常判", (t) => {
  const run = setup(t, { compare: "behind", runs: [null, green] })
  assert.equal(run("v1.2.3").status, 0)
})

test("GitHub API 出错 → 拦，不当成放行", (t) => {
  let run = setup(t, { compare: "error", runs: [green] })
  assert.notEqual(run("v1.2.3-rc.1").status, 0)
  run = setup(t, { compare: "behind", runs: ["error"] })
  assert.notEqual(run("v1.2.3-rc.1").status, 0)
})

for (const tag of [
  "1.2.3",
  "v1.2",
  "v1.2.3.4",
  "v1.2.3-",
  "v1.2.3-rc 1",
  "v1.2.3;id",
  "main",
]) {
  test(`不像版本号的 tag「${tag}」→ 拦，且不调 API`, (t) => {
    const run = setup(t, { compare: "behind", runs: [green] })
    const r = run(tag)
    assert.notEqual(r.status, 0)
    assert.equal(r.output, "")
    assert.deepEqual(r.calls, [])
  })
}

test("SHA 不是 40 位 → 拦", (t) => {
  const run = setup(t, { compare: "behind", runs: [green] })
  assert.notEqual(run("v1.2.3", "abc1234").status, 0)
})

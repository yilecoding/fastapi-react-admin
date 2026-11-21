#!/usr/bin/env node
// release.yml 的闸门：tag 指向的提交必须在 main 上、且 main 上那一轮 CI 全绿，才建草稿、出安装包（#232）。
//
// 🔴 预发布 tag（v1.2.0-rc.1）也一样拦（#393）。原来带 `-` 的 tag 在这里只警告不拦，
// 于是任意分支任意提交打个 `v1.1.0-x` 都能出包、把 latest.yml 传进草稿 —— 维护者点了发布，
// 走默认更新源的桌面端就会升到一份没评审、没过 CI 的构建。试发布流水线本身用 workflow_dispatch（不碰 Release、不签名）。
//
// 输出（GITHUB_OUTPUT）：prerelease=true|false，给「建草稿」那一步决定带不带 --prerelease。
// 只在闸门放行时才写 —— 失败时什么都不输出，下游拿不到一个「看起来像放行」的值。
//
// 环境变量：GITHUB_REF_NAME / GITHUB_SHA / GITHUB_REPOSITORY / GITHUB_OUTPUT（Actions 自带）；
// RELEASE_GATE_POLL_SECONDS（默认 30）· RELEASE_GATE_MAX_POLLS（默认 150，即 75 分钟，#374）·
// RELEASE_GATE_REGISTER_POLLS（默认 10：CI 没登记时最多等 5 分钟）只给测试调小用。
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

const env = process.env
const pollSeconds = Number(env.RELEASE_GATE_POLL_SECONDS ?? 30)
const maxPolls = Number(env.RELEASE_GATE_MAX_POLLS ?? 150)
const registerPolls = Number(env.RELEASE_GATE_REGISTER_POLLS ?? 10)

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function api(route) {
  // 不用 `gh api --jq`：解析放在这里，测试只需要一个回 JSON 的假 gh。
  // gh 非零退出 → execFileSync 抛错 → 进程非零退出，绝不当成放行
  return JSON.parse(
    execFileSync("gh", ["api", route], { encoding: "utf8", timeout: 60_000 })
  )
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))

const tag = env.GITHUB_REF_NAME ?? ""
const sha = env.GITHUB_SHA ?? ""
const repo = env.GITHUB_REPOSITORY ?? ""
// 和 build job「定版本号」那一步同一条正则
const m = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag)
if (!m) fail(`tag 不像版本号：${tag}（要 v1.2.3 或 v1.2.3-rc.1）`)
if (!/^[a-f0-9]{40}$/.test(sha)) fail(`GITHUB_SHA 不是完整提交号：${sha}`)
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`GITHUB_REPOSITORY 不对：${repo}`)
const prerelease = Boolean(m[2])

// compare main...SHA：SHA 是 main 的祖先（或就是 main）时 status 是 behind / identical
const rel = api(`repos/${repo}/compare/main...${sha}`).status
if (rel !== "behind" && rel !== "identical") {
  fail(`tag 指向的 ${sha} 不在 main 上（${rel}）：先合进 main 再打 tag`)
}
console.log(`提交在 main 上（${rel}）`)

for (let i = 1; i <= maxPolls; i++) {
  const run = api(
    `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`
  ).workflow_runs?.[0]
  // 合并后马上推 tag 时，push 触发的那轮 CI 可能还没登记 —— 先等，等满了还没有才算真找不到
  if (!run) {
    if (i >= registerPolls) fail(`找不到 ${sha} 在 main 上的 CI 运行`)
    console.log(`CI 还没登记，${pollSeconds} 秒后再看…`)
    await sleep(pollSeconds)
    continue
  }
  if (run.status === "completed") {
    if (run.conclusion !== "success")
      fail(`这个提交的 CI 结论是 ${run.conclusion}：${run.html_url}`)
    console.log(`CI 绿：${run.html_url}`)
    if (env.GITHUB_OUTPUT)
      appendFileSync(env.GITHUB_OUTPUT, `prerelease=${prerelease}\n`)
    console.log(
      prerelease ? `${tag} 是预发布，草稿会标 prerelease` : `${tag} 是正式版`
    )
    process.exit(0)
  }
  console.log(`CI 还在跑（${run.status}），${pollSeconds} 秒后再看…`)
  await sleep(pollSeconds)
}
fail(`等了 ${maxPolls} 轮 CI 还没跑完`)

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// release.yml / ci.yml 里那几处闸门的接线（#393）。脚本本身的行为在 release-gate / latest-release-tag 两份测试里，
// 这里只核对「workflow 真的调了它、没有绕开它」—— 接线断了脚本测试照样全绿。
const read = (p) =>
  readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8")
const release = read(".github/workflows/release.yml")
const ci = read(".github/workflows/ci.yml")

test("签名证书只在过了闸门的 tag 构建里注入，workflow_dispatch 试跑拿不到", () => {
  const uses = [
    ...release.matchAll(
      /^\s*([A-Z_]+):\s*\$\{\{(.*secrets\.(?:CSC_|APPLE_).*)\}\}\s*$/gm
    ),
  ]
  assert.equal(uses.length, 5, "五个签名 / 公证 secret 都应在「出安装包」里")
  for (const [, name, expr] of uses) {
    assert.match(
      expr.trim(),
      new RegExp(
        `^github\\.event_name == 'push' && secrets\\.${name} \\|\\| ''$`
      ),
      `${name} 没按事件门控：${expr}`
    )
  }
  // 门控只在「push 就等于过了闸门」时成立：build 在 push 下必须依赖 prepare 成功
  assert.match(
    release,
    /if: always\(\) && \(needs\.prepare\.result == 'success' \|\| github\.event_name == 'workflow_dispatch'\)/
  )
})

test("prepare 用可测的闸门脚本，草稿按它的输出标 prerelease", () => {
  assert.match(
    release,
    /id: gate\n\s+env:\n(?:\s+.*\n)*?\s+run: node scripts\/release-gate\.mjs/
  )
  assert.doesNotMatch(release, /预发布 tag，放行/)
  assert.match(release, /steps\.gate\.outputs\.prerelease/)
  assert.match(release, /--prerelease/)
})

test("迁移链守卫取基线 tag 时，远端读失败不能落进「没有 tag，跳过」", () => {
  assert.match(
    ci,
    /TAG=\$\(node \.\.\/\.\.\/scripts\/latest-release-tag\.mjs\)/
  )
  assert.doesNotMatch(ci, /ls-remote --tags[^\n]*\|\| true/)
})

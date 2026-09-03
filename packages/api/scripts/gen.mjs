#!/usr/bin/env node
/**
 * 从后端**离线**导出 OpenAPI，再生成 `src/schema.d.ts`。
 *
 * 🔴 **不需要起服务。** 原来这条是
 * `openapi-typescript http://127.0.0.1:8000/openapi -o src/schema.d.ts` ——
 * 两个毛病：
 *   1. **端口是错的**：后端 dev 跑在 **8088**（`apps/api/package.json` 的 `dev`），
 *      `:8000` 上什么都没有。谁跑这条都只会拿到 `ECONNREFUSED`，
 *      而报错完全不提「端口写错了」
 *   2. 要求先起服务 —— 而生成契约这件事和运行时无关，`app.openapi()`
 *      不碰数据库
 *
 * 现在直接 import FastAPI 的 app 拿 spec。代价是这个 JS 包要知道 python venv
 * 的位置 —— 和 `pnpm hooks:install`（`apps/api/.venv/bin/prek`）同一个既有模式。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const pkgDir = resolve(import.meta.dirname, '..')
const apiDir = resolve(pkgDir, '../../apps/api')
const python = join(apiDir, '.venv/bin/python')

// stdout 里混着后端启动期的日志（插件探测那几行），所以让 python 把 JSON
// 写进文件、不走管道 —— 混在一起解析会失败，而失败信息看不出是日志的锅
const tmp = mkdtempSync(join(tmpdir(), 'gen-api-'))
const specFile = join(tmp, 'openapi.json')

try {
  execFileSync(
    python,
    ['-c', `import json; from backend.main import app; open(${JSON.stringify(specFile)}, 'w').write(json.dumps(app.openapi()))`],
    { cwd: apiDir, stdio: ['ignore', 'inherit', 'inherit'] },
  )
  execFileSync(
    'npx',
    ['openapi-typescript', specFile, '-o', join(pkgDir, 'src/schema.d.ts')],
    { cwd: pkgDir, stdio: 'inherit' },
  )
  console.log('\n✅ src/schema.d.ts 已更新')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../check-main-head.mjs', import.meta.url))

test('publication follows the remote main, including after a later push', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'fra-main-head-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
  }
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Publication test')
  git('config', 'user.email', 'publication@example.invalid')
  git('commit', '--allow-empty', '-m', 'A')
  const first = git('rev-parse', 'HEAD')
  git('clone', '--bare', '.', 'remote.git')
  git('remote', 'add', 'origin', path.join(root, 'remote.git'))
  const output = path.join(root, 'output')
  function check(sha) {
    writeFileSync(output, '')
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...env, GITHUB_SHA: sha, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    })
    return { ...result, output: readFileSync(output, 'utf8') }
  }

  let result = check(first)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, 'current=true\n')

  git('commit', '--allow-empty', '-m', 'B')
  const second = git('rev-parse', 'HEAD')
  git('push', 'origin', 'main')
  // Leave both the checkout and cached remote ref at A, as in an earlier workflow.
  git('checkout', '--detach', first)
  git('update-ref', 'refs/remotes/origin/main', first)
  result = check(first)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, 'current=false\n')
  result = check(second)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, 'current=true\n')
  assert.equal(git('rev-parse', 'origin/main'), first)

  // Failure to read main must never grant publication.
  git('--git-dir=remote.git', 'update-ref', '-d', 'refs/heads/main')
  result = check(second)
  assert.notEqual(result.status, 0)
  assert.equal(result.output, '')
  git('remote', 'set-url', 'origin', path.join(root, 'missing.git'))
  result = check(second)
  assert.notEqual(result.status, 0)
  assert.equal(result.output, '')
  result = check('invalid-sha')
  assert.notEqual(result.status, 0)
  assert.equal(result.output, '')
})

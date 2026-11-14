#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

// Query the remote at publication time: a rerun's checkout and origin/main may both be stale.
const { GITHUB_SHA, GITHUB_OUTPUT } = process.env
if (!GITHUB_SHA || !/^[a-f0-9]{40}$/.test(GITHUB_SHA) || !GITHUB_OUTPUT) {
  throw new Error('GITHUB_SHA (full commit SHA) and GITHUB_OUTPUT are required')
}

const remote = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], {
  encoding: 'utf8',
  timeout: 30_000,
}).trim()
const match = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(remote)
if (!match) throw new Error('Cannot determine the current origin/main commit')

const current = match[1] === GITHUB_SHA
appendFileSync(GITHUB_OUTPUT, `current=${current}\n`)
console.log(
  current
    ? `Current main commit ${GITHUB_SHA}: publication allowed`
    : `Stale commit ${GITHUB_SHA} (main is ${match[1]}): skip latest / Pages publication`,
)

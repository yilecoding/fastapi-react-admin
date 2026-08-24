#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const COMPOSE_FILE = resolve(ROOT, "docker-compose.prod.yml")
const ENV_FILE = resolve(
  ROOT,
  "apps/api/deploy/backend/docker-compose/.env.server"
)

const command = process.argv[2] ?? "up"
const allowedCommands = new Set(["config", "build", "up", "down", "logs"])

function fail(message) {
  console.error(`生产部署前置检查失败：${message}`)
  process.exit(1)
}

function checkEnvFile() {
  if (!existsSync(ENV_FILE)) {
    fail(
      `找不到 ${ENV_FILE.replace(`${ROOT}/`, "")}。先执行：\n` +
        "  cp apps/api/deploy/backend/docker-compose/.env.server.example " +
        "apps/api/deploy/backend/docker-compose/.env.server"
    )
  }

  if (process.platform !== "win32") {
    const mode = statSync(ENV_FILE).mode & 0o777
    if ((mode & 0o077) !== 0) {
      fail(
        `${ENV_FILE.replace(`${ROOT}/`, "")} 权限为 ${mode.toString(8)}，` +
          "生产环境应限制为 600（chmod 600 <file>）"
      )
    }
  }

  const contents = readFileSync(ENV_FILE, "utf8")
  const activeConfig = contents
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
  if (/CHANGE_ME/i.test(activeConfig)) {
    fail(`${ENV_FILE.replace(`${ROOT}/`, "")} 仍包含 CHANGE_ME 占位值`)
  }
}

if (!allowedCommands.has(command)) {
  fail(`不支持的命令 ${command}，可用命令：${[...allowedCommands].join(", ")}`)
}

checkEnvFile()

const args = ["compose", "-f", COMPOSE_FILE, command]
if (command === "up") args.push("-d")
if (command === "logs") args.push("-f", "--tail=200")

const result = spawnSync("docker", args, {
  cwd: ROOT,
  stdio: "inherit",
})

if (result.error) {
  fail(`无法执行 docker：${result.error.message}`)
}
process.exit(result.status ?? 1)

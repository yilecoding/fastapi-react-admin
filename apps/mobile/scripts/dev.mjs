#!/usr/bin/env node
/**
 * `pnpm mobile:dev` 的入口 —— 它存在的唯一理由是**给你一个真的能连的地址**。
 *
 * 直接跑 `expo start` 在这台机器上给不出：Metro 会从网卡列表里挑一个 **docker
 * bridge**（这里有 8 个）打印成 `exp://172.24.0.1:8081` —— 那个地址在 WSL 里、
 * 在 NAT 后面、还是 docker 内部网桥，三重不可达。
 *
 * 两种设备，地址不一样，脚本自己判断：
 *
 * A) **宿主机（Windows）上的模拟器** —— 默认。
 *    Android 模拟器里的 `10.0.2.2` 是**宿主机的 loopback**；而 WSL2 默认
 *    `localhostForwarding=true`，Windows 的 localhost 会转进 WSL。
 *    所以 `10.0.2.2:8081` → Windows loopback → WSL 的 Metro，整条通。
 *    后端同理走 `10.0.2.2:8088`，**后端可以继续只绑 127.0.0.1**。
 *
 * B) **WSL 里的模拟器 / USB 真机** —— 检测到 adb 有设备时自动切。
 *    走 `adb reverse` + `127.0.0.1`，全程留在 WSL 内部。
 *
 * 🔴 **两种模式都不往局域网开口。** WSL2 是 NAT 的，只有 Windows 宿主够得着 ——
 *    这正是当初否掉 `networkingMode=mirrored` 和 `netsh portproxy` 想保住的性质
 *    （那台机器上跑着 fba_mssql:1433 和 fba_redis:6380）。
 *
 * 用的不是标准 AVD（MuMu / 雷电 / 夜神那类，`10.0.2.2` 不一定成立）时：
 *   MOBILE_HOST=<能连到的地址> pnpm mobile:dev
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Metro 端口固定 **8800**，不用 Expo 默认的 8081。
 *
 * 8081 在这台机器上太容易撞（RN 生态里到处是它，随手起的进程都抢），而撞了之后
 * Expo 的默认行为是**默默漂到 8082** —— 漂了之后这份脚本打印的地址就是错的，
 * 「地址看着有、就是不通」比直接连不上难查得多。挑一个没人抢的号，
 * 再配下面那段占用检查（不漂、直接报 pid），这类问题就绝迹了。
 */
const METRO_PORT = process.env.RCT_METRO_PORT ?? '8800'
/** Android 模拟器里指向宿主机 loopback 的固定别名 */
const HOST_LOOPBACK = '10.0.2.2'

function sh(cmd) {
  try {
    return execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function findAdb() {
  for (const sdk of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(homedir(), 'Android', 'sdk'),
    path.join(homedir(), 'Android', 'Sdk'),
  ].filter(Boolean)) {
    const p = path.join(sdk, 'platform-tools', 'adb')
    if (existsSync(p)) return { adb: p, sdk }
  }
  const p = sh('command -v adb')
  return p ? { adb: p, sdk: null } : { adb: null, sdk: null }
}

function localDevices(adb) {
  if (!adb) return []
  return sh(`"${adb}" devices`)
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0])
}

// ── 端口先检查，别让它悄悄漂到 8082 ────────────────────────────────────────────
// 漂了之后下面打印的地址就是错的，而这**比连不上更难查**：地址看着有、就是不通。
const holder = sh(`ss -ltnp 2>/dev/null | grep ':${METRO_PORT} ' | grep -oP 'pid=\\K[0-9]+' | head -1`)
if (holder) {
  console.error(
    [
      '',
      `❌ 端口 ${METRO_PORT} 被 pid ${holder} 占着（多半是上一次没关干净的 Metro）。`,
      `   先关掉：kill ${holder}`,
      '   —— 刻意不自动往下一个端口漂：漂了之后上面打印的地址就是错的，比连不上更难查。',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const { adb, sdk } = findAdb()
const devices = localDevices(adb)
const override = process.env.MOBILE_HOST
const host = override ?? (devices.length > 0 ? '127.0.0.1' : HOST_LOOPBACK)
const apiBase = process.env.EXPO_PUBLIC_API_BASE ?? `http://${host}:8088`

// B 模式：设备在 WSL 里，把端口转进去
if (!override && devices.length > 0) {
  for (const serial of devices) {
    for (const p of [METRO_PORT, '8088']) {
      try {
        execFileSync(adb, ['-s', serial, 'reverse', `tcp:${p}`, `tcp:${p}`], { stdio: 'ignore' })
      } catch {
        console.log(`⚠️  ${serial}: adb reverse tcp:${p} 失败`)
      }
    }
  }
  console.log(`\n📱 WSL 内设备：${devices.join(', ')}（已 adb reverse ${METRO_PORT} / 8088）`)
}

// 🔴 换成 WSL 自己的 IP 时，**后端也得跟着改绑**。
// `pnpm --filter api dev` 绑的是 `127.0.0.1`，从 WSL 的 eth0 地址上打不进去 ——
// 表现是 bundle 加载得动、但一登录就 `Network request failed`，
// 看着像后端挂了。这是这条路上唯一一个不明显的地方。
const needsApiRebind = host !== HOST_LOOPBACK && host !== '127.0.0.1'

console.log(
  [
    '',
    '┌─────────────────────────────────────────────',
    `│  在模拟器/Expo Go 里填这个地址：`,
    `│      exp://${host}:${METRO_PORT}`,
    `│  App 打的后端：${apiBase}`,
    '└─────────────────────────────────────────────',
    devices.length === 0 && !override
      ? `   （按「宿主机上的模拟器」算的。连不上就换一个：\n    MOBILE_HOST=<别的地址> pnpm mobile:dev —— 候选见 AGENTS.md「设备」一节）`
      : '',
    needsApiRebind
      ? `   🔴 用的不是宿主机 loopback，**后端要换成 \`pnpm --filter api dev:host\`**\n      （绑 0.0.0.0）。还用 \`dev\` 的话 bundle 加载得动、一登录就 Network request failed。`
      : '',
    '',
  ]
    .filter(Boolean)
    .join('\n'),
)

const env = { ...process.env, EXPO_PUBLIC_API_BASE: apiBase }
// 让 Metro 用我们算出来的地址，而不是自己去网卡列表里挑（见文件头）
env.EXPO_PACKAGER_HOSTNAME = host
env.REACT_NATIVE_PACKAGER_HOSTNAME = host
if (sdk) {
  env.ANDROID_HOME ??= sdk
  env.ANDROID_SDK_ROOT ??= sdk
  env.PATH = `${path.join(sdk, 'platform-tools')}:${env.PATH}`
}

// 🔴 **刻意不自动追加 `--android`。** 试过，是个坏设计：设备刚开机时 package
// 服务还没起（`cmd: Can't find service: package`），`--android` 会让 expo
// **整个进程退出** —— 一个瞬时的设备状态变成了「dev server 起不来」。
const args = ['expo', 'start', '--port', METRO_PORT, ...process.argv.slice(2)]

// cwd 钉在 apps/mobile：从仓库根直接 `node apps/mobile/scripts/dev.mjs` 时，
// `npx expo` 会在根目录找不到本地 expo → **去 npm 上装一个最新的**
// （实测打出 `will be installed: expo@57.0.19`，而工程是 56）。
// 那是一次很吵但指向完全错误的失败。
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
spawn('npx', args, { stdio: 'inherit', env, cwd: pkgDir }).on('exit', (code) => process.exit(code ?? 0))

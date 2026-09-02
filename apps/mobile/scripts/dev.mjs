#!/usr/bin/env node
/**
 * `pnpm mobile:dev` 的入口。
 *
 * 直接跑 `expo start` 在这个仓库里有**三处会静默地不对**，所以套了这一层：
 *
 * 1. **Metro 会挑一个 docker bridge 当地址。** 这台机器上有 8 个 docker bridge，
 *    Metro 从网卡列表里挑一个打印成 `exp://172.24.0.1:8081` —— 三重不可达。
 *    这里强制 `--localhost`，配 `adb reverse`，模拟器和 USB 真机都通。
 * 2. **后端那个口没人转。** Metro 的 8081 是 expo 自己 reverse 的，但 App 要打的
 *    dev API（默认 `127.0.0.1:8088`）没人管 —— 表现是 App 能起来、所有请求
 *    `Network request failed`，看着像后端挂了。
 * 3. **`adb` 不在 PATH 上、`ANDROID_HOME` 也没设。** 于是 `expo start --android`
 *    连设备都找不到，报的错不提这件事。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const SDK_CANDIDATES = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(homedir(), 'Android', 'sdk'),
  path.join(homedir(), 'Android', 'Sdk'),
].filter(Boolean)

function findAdb() {
  for (const sdk of SDK_CANDIDATES) {
    const p = path.join(sdk, 'platform-tools', 'adb')
    if (existsSync(p)) return { adb: p, sdk }
  }
  try {
    const p = execFileSync('sh', ['-c', 'command -v adb'], { encoding: 'utf8' }).trim()
    if (p) return { adb: p, sdk: null }
  } catch {
    // 没装就是没装
  }
  return { adb: null, sdk: null }
}

function devices(adb) {
  try {
    return execFileSync(adb, ['devices'], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.endsWith('\tdevice'))
      .map((l) => l.split('\t')[0])
  } catch {
    return []
  }
}

/** dev API 的端口 —— 只有指向本机 loopback 时才需要 reverse */
function apiPort() {
  const base = process.env.EXPO_PUBLIC_API_BASE ?? 'http://127.0.0.1:8088'
  try {
    const u = new URL(base)
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return null
  }
}

const { adb, sdk } = findAdb()
const found = adb ? devices(adb) : []
const port = apiPort()

if (!adb) {
  console.log(
    [
      '',
      '⚠️  找不到 adb（试过 ANDROID_HOME / ANDROID_SDK_ROOT / ~/Android/sdk / PATH）。',
      '   Metro 照常起，但没法把端口转进设备 —— 设备上会连不上 Metro 和后端。',
      '',
    ].join('\n'),
  )
} else if (found.length === 0) {
  console.log(
    [
      '',
      '⚠️  没有连上的设备/模拟器，端口转发这一步跳过了。',
      '   Metro 照常起，但**设备连不上**（这台机器上手机走局域网到不了 WSL，',
      '   见 apps/mobile/AGENTS.md「设备」一节）。',
      '',
      '   起 WSL 里的模拟器：',
      `     ${sdk ?? '$ANDROID_HOME'}/emulator/emulator -avd fra_mobile -no-window -no-audio -accel off &`,
      '   开机后重新跑这条命令即可（冷启动约 9 分钟，因为没有 KVM 权限）。',
      '',
    ].join('\n'),
  )
} else {
  for (const serial of found) {
    const fwd = ['8081', ...(port ? [port] : [])]
    for (const p of fwd) {
      try {
        execFileSync(adb, ['-s', serial, 'reverse', `tcp:${p}`, `tcp:${p}`], { stdio: 'ignore' })
      } catch {
        console.log(`⚠️  ${serial}: adb reverse tcp:${p} 失败`)
      }
    }
    console.log(`✅ ${serial} 已转发 ${fwd.join(' / ')}`)

    // 🔴 慢机器上 `pm` 会**返回空输出或报 `Can't find service: package`**，
    // 而不是一个能区分的错误 ——「没装 App」和「系统还没起完」长得一模一样。
    // 这里只探一下并提示，不阻塞。
    try {
      execFileSync(adb, ['-s', serial, 'shell', 'cmd', 'package', 'list', 'packages'], { stdio: 'ignore' })
    } catch {
      console.log(`   ⏳ ${serial} 的 package 服务还没起完，稍等一会儿再在 TUI 里按 a`)
    }
  }
}

// 🔴 **刻意不自动追加 `--android`。** 试过，是个坏设计：设备刚开机时
// package 服务还没起（`cmd: Can't find service: package`），`--android`
// 会让 expo **整个进程退出**——一个瞬时的设备状态变成了「dev server 起不来」。
// 端口转发（上面那步）才是这层要解决的事；开 App 交给 TUI 里按 `a`。
//
// `--localhost`：不要让 Metro 去网卡列表里挑地址（见文件头第 1 条）
const args = ['expo', 'start', '--localhost', ...process.argv.slice(2)]

const env = { ...process.env }
if (sdk) {
  env.ANDROID_HOME ??= sdk
  env.ANDROID_SDK_ROOT ??= sdk
  env.PATH = `${path.join(sdk, 'platform-tools')}:${env.PATH}`
}

spawn('npx', args, { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 0))

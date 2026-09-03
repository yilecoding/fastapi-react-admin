#!/usr/bin/env node
/**
 * `pnpm --filter @admin/mobile apk` —— 打一个可直接安装的 release APK。
 *
 * 为什么要这层：
 *
 * 1. **`android/` 是 gitignore 的**（CNG：原生工程可再生，不进版本库）。
 *    不在的话先 `expo prebuild`。
 * 2. **`local.properties` 要指 SDK**，而它也不进版本库。
 * 3. 🔴 **`EXPO_PUBLIC_API_BASE` 必须在这里显式给成生产地址。**
 *    那是**构建期替换的字符串** —— 不给的话默认值是
 *    `http://127.0.0.1:8088`（dev 的值），装到手机上第一个请求就连不上，
 *    而报错只说「连不上服务器」。App 里能改地址（设置 → 服务器），
 *    但一个装上就连不通的包不该发出去。
 * 4. 打完把 APK 拷到 Windows 的下载目录 —— WSL 里的路径手机拿不到。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ANDROID = path.join(ROOT, 'android')

/** 生产站。设置屏可以改，这只是装上之后的默认值 */
const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://fra.wubunan.com'

function sdkDir() {
  for (const d of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(homedir(), 'Android', 'sdk'),
    path.join(homedir(), 'Android', 'Sdk'),
  ].filter(Boolean)) {
    if (existsSync(path.join(d, 'platform-tools'))) return d
  }
  return null
}

const sdk = sdkDir()
if (!sdk) {
  console.error('\n❌ 找不到 Android SDK（试过 ANDROID_HOME / ANDROID_SDK_ROOT / ~/Android/sdk）。\n')
  process.exit(1)
}

/**
 * 🔴 **把 shell 的代理环境变量翻译成 JVM 的系统属性。**
 *
 * 这台机器上有 `http_proxy=http://172.17.96.1:18080`（指向 Windows 宿主）。
 * **`curl` 认 `http_proxy`/`https_proxy`，JVM 不认** —— Java 只看
 * `-Dhttp.proxyHost` / `-Dhttps.proxyHost` 这类系统属性。
 *
 * 于是 gradle wrapper 去直连，10 秒超时，报的是
 *
 *     Downloading https://…/gradle-9.3.1-bin.zip failed: timeout (10000ms)
 *
 * **一个字不提代理**，而同一个 URL `curl` 是 200 —— 看着像「gradle 的服务器挂了」。
 * 我第一轮就据此误判成 307 跳转被墙，换了镜像，照样超时。
 *
 * 翻译过去之后 wrapper 下载和 gradle 自己的依赖解析（Maven）都走代理。
 */
function proxyJvmArgs() {
  const args = []
  for (const scheme of ['http', 'https']) {
    const raw = process.env[`${scheme}_proxy`] ?? process.env[`${scheme.toUpperCase()}_PROXY`]
    if (!raw) continue
    try {
      const u = new URL(raw)
      args.push(`-D${scheme}.proxyHost=${u.hostname}`, `-D${scheme}.proxyPort=${u.port || '80'}`)
    } catch {
      // 格式不对就当没配
    }
  }
  const no = process.env.no_proxy ?? process.env.NO_PROXY
  if (no && args.length) {
    // Java 的 nonProxyHosts 用 `|` 分隔、`*` 通配 —— 和 shell 的逗号分隔不一样
    const hosts = no
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
      .map((h) => (h.startsWith('.') ? `*${h}` : h))
      .join('|')
    args.push(`-Dhttp.nonProxyHosts=${hosts}`, `-Dhttps.nonProxyHosts=${hosts}`)
  }
  return args
}

const jvmProxy = proxyJvmArgs()
if (jvmProxy.length) console.log(`› 代理透传给 JVM：${jvmProxy.slice(0, 2).join(' ')}`)

const env = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  EXPO_PUBLIC_API_BASE: API_BASE,
  // wrapper 下载走这个
  GRADLE_OPTS: [process.env.GRADLE_OPTS, ...jvmProxy].filter(Boolean).join(' '),
}

if (!existsSync(ANDROID)) {
  console.log('› android/ 不在（它是 gitignore 的），先 prebuild…')
  const r = spawnSync('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// local.properties 也不进版本库，每次确保它在
writeFileSync(path.join(ANDROID, 'local.properties'), `sdk.dir=${sdk}\n`)

/**
 * gradle 发行版换成腾讯镜像 —— 这是**加速**，不是修 bug。
 * （真正卡住第一轮的是上面那个代理问题；`services.gradle.org` 那个 307
 * 本身没问题，我一开始误判成它被墙了。）
 *
 * ⚠️ 这一步**必须在脚本里做**：`android/` 是 gitignore 的、每次 prebuild
 * 重新生成，改完也进不了版本库，下一次 `--clean` 就回到原样。
 */
const wrapperProps = path.join(ANDROID, 'gradle', 'wrapper', 'gradle-wrapper.properties')
if (existsSync(wrapperProps)) {
  const before = readFileSync(wrapperProps, 'utf8')
  const after = before.replace(
    /distributionUrl=.*?gradle-([\d.]+)-(bin|all)\.zip/,
    (_m, v, kind) => `distributionUrl=https\\://mirrors.cloud.tencent.com/gradle/gradle-${v}-${kind}.zip`,
  )
  if (after !== before) {
    writeFileSync(wrapperProps, after)
    console.log('› gradle 发行版换成腾讯镜像（services.gradle.org 的 307 跳转在这个网络下连不上）')
  }
}

// gradle daemon 解析 Maven 依赖时也要走代理。`GRADLE_OPTS` 只作用于 wrapper 那个
// JVM，daemon 是另一个进程 —— 所以还要写进 gradle.properties 的 systemProp.*
if (jvmProxy.length) {
  const gp = path.join(ANDROID, 'gradle.properties')
  const lines = existsSync(gp) ? readFileSync(gp, 'utf8').split('\n') : []
  const kept = lines.filter((l) => !l.startsWith('systemProp.http'))
  for (const a of jvmProxy) {
    const [k, v] = a.replace(/^-D/, '').split('=')
    kept.push(`systemProp.${k}=${v}`)
  }
  writeFileSync(gp, kept.join('\n').replace(/\n+$/, '') + '\n')
}

console.log(`\n› 打包中，后端默认地址 = ${API_BASE}`)
console.log('  （首次跑要下 Gradle 和 Android 构建依赖，几百 MB，慢）\n')

const r = spawnSync('./gradlew', ['assembleRelease', '--console=plain'], {
  cwd: ANDROID,
  stdio: 'inherit',
  env,
})
if (r.status !== 0) process.exit(r.status ?? 1)

const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!existsSync(apk)) {
  console.error('\n❌ gradle 说成功了，但找不到 APK：' + apk)
  process.exit(1)
}
const mb = (statSync(apk).size / 1024 / 1024).toFixed(1)

// 拷到 Windows 的下载目录 —— WSL 里的路径手机拿不到
let copied = null
for (const d of ['/mnt/c/Users']) {
  if (!existsSync(d)) continue
  try {
    const users = execFileSync('ls', [d], { encoding: 'utf8' }).split('\n').filter(Boolean)
    for (const u of users) {
      const dl = path.join(d, u, 'Downloads')
      if (existsSync(dl)) {
        const dest = path.join(dl, 'fra-mobile.apk')
        copyFileSync(apk, dest)
        copied = dest
        break
      }
    }
  } catch {
    // 拿不到就算了，下面会打 WSL 里的路径
  }
}

console.log(
  [
    '',
    '┌─────────────────────────────────────────────',
    `│  ✅ APK 打好了（${mb} MB）`,
    `│  ${copied ?? apk}`,
    '└─────────────────────────────────────────────',
    copied ? '   拖到模拟器窗口里就装，或 PowerShell: adb install -r fra-mobile.apk' : '',
    `   装上后默认连 ${API_BASE}，要改去 设置 → 服务器`,
    '',
  ]
    .filter(Boolean)
    .join('\n'),
)

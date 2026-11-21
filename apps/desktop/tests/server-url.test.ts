import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

/**
 * #392：渲染层的 API_BASE 要和主进程 auth.ts 读同一份 serverUrl。
 * 链路是 主进程 `config:server-url-sync`（同步通道）→ preload `sendSync` → `window.desktop.serverUrl`。
 * Electron API 用 mock，未在打包产物里跑。
 */

function load(relative: string, imports: Record<string, unknown>) {
  const filename = path.resolve(import.meta.dirname, relative)
  const js = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports: Record<string, unknown> = {}
  vm.runInNewContext(js, {
    exports,
    URL,
    require: (name: string) => {
      assert.ok(name in imports, name)
      return imports[name]
    },
  })
  return exports
}

const contract = load("../../../packages/platform/src/desktop/contract.ts", {})
const IPC = contract.IPC as Record<string, string>

function loadPreload(sendSync: (channel: string) => unknown) {
  let exposed: Record<string, unknown> | undefined
  load("../src/preload/index.ts", {
    electron: {
      contextBridge: {
        exposeInMainWorld: (_key: string, value: Record<string, unknown>) => {
          exposed = value
        },
      },
      ipcRenderer: { sendSync, invoke: async () => undefined, on() {}, off() {} },
    },
    "@admin/platform/desktop/contract": contract,
  })
  assert.ok(exposed)
  return exposed
}

test("preload 在加载时同步取 serverUrl 挂到桥上", () => {
  const channels: string[] = []
  const bridge = loadPreload((channel) => {
    channels.push(channel)
    return "https://admin.example.com"
  })
  assert.equal(bridge.serverUrl, "https://admin.example.com")
  assert.deepEqual(channels, [IPC.configServerUrlSync])
})

test("主进程同步通道返回的值取不到 / 不是字符串：当没配，不让渲染层拿到 undefined", () => {
  assert.equal(loadPreload(() => undefined).serverUrl, "")
  assert.equal(
    loadPreload(() => {
      throw new Error("no handler")
    }).serverUrl,
    ""
  )
})

test("主进程的同步通道读的是 config.json 那份 serverUrl（与 auth.ts 同源）", () => {
  const syncHandlers: Record<string, (event: { returnValue?: unknown }) => void> = {}
  const ipc = load("../src/main/ipc.ts", {
    electron: {
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: {
        handle() {},
        on: (channel: string, fn: (event: { returnValue?: unknown }) => void) => {
          syncHandlers[channel] = fn
        },
      },
    },
    "@admin/platform/desktop/contract": contract,
    "./auth": {},
    "./config": { readConfig: () => ({ serverUrl: "https://runtime.example.com" }), writeConfig() {} },
    "./devices/registry": { onDeviceEvent() {} },
    "./print": {},
    "./updater": {},
  }) as { registerIpc: (info: () => unknown) => void }
  ipc.registerIpc(() => ({}))
  const handler = syncHandlers[IPC.configServerUrlSync]
  assert.ok(handler, "缺少 serverUrl 的同步通道")
  const event: { returnValue?: unknown } = {}
  handler(event)
  assert.equal(event.returnValue, "https://runtime.example.com")
})

function loadConfig(onDisk = "{}") {
  const written: string[] = []
  const urlModule = load("../../../packages/platform/src/desktop/http-url.ts", {})
  const config = load("../src/main/config.ts", {
    electron: { app: { getPath: () => "/tmp/desktop-config-test" } },
    "node:fs": {
      readFileSync: () => onDisk,
      mkdirSync() {},
      writeFileSync: (_p: string, data: string) => written.push(data),
    },
    "node:path": path,
    "@admin/platform/desktop/http-url": urlModule,
  }) as {
    readConfig: () => { serverUrl: string }
    writeConfig: (patch: Record<string, unknown>) => { serverUrl: string }
  }
  return { config, written }
}

test("writeConfig 拒绝非 HTTP(S) 的 serverUrl，合法地址削掉末尾斜杠", () => {
  const { config, written } = loadConfig()
  assert.throws(() => config.writeConfig({ serverUrl: "file:///etc/passwd" }))
  assert.throws(() => config.writeConfig({ serverUrl: "admin.example.com" }))
  // 渲染层按 `${serverUrl}${path}` 拼：查询串 / 片段会吞掉路径，账号密码会让 fetch 直接拒绝（#392 评审跟进）
  assert.throws(() => config.writeConfig({ serverUrl: "https://admin.example.com/?env=prod" }))
  assert.throws(() => config.writeConfig({ serverUrl: "https://admin.example.com/#x" }))
  assert.throws(() => config.writeConfig({ serverUrl: "https://u:p@admin.example.com" }))
  assert.equal(written.length, 0)
  assert.equal(config.writeConfig({ serverUrl: " https://admin.example.com/ " }).serverUrl, "https://admin.example.com")
  // 清空是允许的：回到「未配置」，登录页重新引导
  assert.equal(config.writeConfig({ serverUrl: "" }).serverUrl, "")
})

test("config.json 里手改坏的 serverUrl 读出来当没配，不交给渲染层和登录去拼相对地址（#392 评审跟进）", () => {
  // 没有协议 → 渲染层 fetch 按 app://local 解析，拿回 index.html；主进程 Node fetch 直接抛
  assert.equal(loadConfig(JSON.stringify({ serverUrl: "192.168.1.10:8088" })).config.readConfig().serverUrl, "")
  assert.equal(
    loadConfig(JSON.stringify({ serverUrl: "https://admin.example.com/" })).config.readConfig().serverUrl,
    "https://admin.example.com"
  )
})

function loadIpcWithConfig(initial: string) {
  const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {}
  let current = { serverUrl: initial, kiosk: false }
  const cleared: number[] = []
  const ipc = load("../src/main/ipc.ts", {
    electron: {
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: {
        handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
          handlers[channel] = fn
        },
        on() {},
      },
    },
    "@admin/platform/desktop/contract": contract,
    "./auth": { clearRefreshToken: () => cleared.push(1) },
    "./config": {
      readConfig: () => current,
      writeConfig: (patch: Record<string, unknown>) => {
        current = { ...current, ...patch }
        return current
      },
    },
    "./devices/registry": { onDeviceEvent() {} },
    "./print": {},
    "./updater": {},
  }) as { registerIpc: (info: () => unknown) => void }
  ipc.registerIpc(() => ({}))
  const set = (patch: Record<string, unknown>) => handlers[IPC.configSet]!({}, patch)
  return { set, cleared }
}

test("换了服务器就删掉上一台的 refresh token，不把它当 Cookie 发给新地址（#392 评审跟进）", () => {
  const { set, cleared } = loadIpcWithConfig("https://a.example.com")
  set({ serverUrl: "https://b.example.com" })
  assert.equal(cleared.length, 1, "换服务器后旧凭据还在：下次 restore 会把 A 的 refresh token 发给 B")
})

test("服务器地址没变（或只改了别的配置）不动登录凭据", () => {
  const { set, cleared } = loadIpcWithConfig("https://a.example.com")
  set({ serverUrl: "https://a.example.com" })
  set({ kiosk: true })
  assert.equal(cleared.length, 0)
})

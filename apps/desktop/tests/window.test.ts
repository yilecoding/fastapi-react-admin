import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

function loadWindow(devServer?: string) {
  const opened: string[] = []
  const warnings: string[] = []
  let openHandler: (event: { url: string }) => { action: string }
  let navigateHandler: (
    event: { preventDefault: () => void },
    url: string
  ) => void
  let rejectOpen = false
  class BrowserWindow {
    webContents = {
      setWindowOpenHandler(fn: typeof openHandler) {
        openHandler = fn
      },
      on(_event: string, fn: typeof navigateHandler) {
        navigateHandler = fn
      },
      openDevTools() {},
    }
    once() {}
    loadURL() {
      return Promise.resolve()
    }
  }
  function load(relative: string, imports: Record<string, unknown>) {
    const filename = path.resolve(import.meta.dirname, relative)
    const js = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
    const exports = {}
    vm.runInNewContext(js, {
      exports,
      URL,
      __dirname: path.dirname(filename),
      process: { env: { DESKTOP_DEV_SERVER_URL: devServer } },
      console: { warn: (message: string) => warnings.push(message) },
      require: (name: string) => {
        assert.ok(name in imports, name)
        return imports[name]
      },
    })
    return exports
  }
  const urlModule = load(
    "../../../packages/platform/src/desktop/http-url.ts",
    {}
  )
  const main = load("../src/main/window.ts", {
    electron: {
      BrowserWindow,
      shell: {
        openExternal: (url: string) => {
          opened.push(url)
          return rejectOpen
            ? Promise.reject(new Error("sensitive URL"))
            : Promise.resolve()
        },
      },
    },
    "node:fs": { existsSync: () => false },
    "node:path": path,
    "@admin/platform/desktop/http-url": urlModule,
    "./config": { readConfig: () => ({ kiosk: false }) },
    "./protocol": { APP_ORIGIN: "app://local" },
  }) as { createMainWindow: () => unknown }
  main.createMainWindow()
  return {
    opened,
    warnings,
    rejectNextOpen() {
      rejectOpen = true
    },
    newWindow(url: string) {
      return openHandler({ url }).action
    },
    navigate(url: string) {
      let prevented = false
      navigateHandler(
        {
          preventDefault() {
            prevented = true
          },
        },
        url
      )
      return prevented
    },
  }
}

test("both external entry points block system protocols and malformed URLs", () => {
  const win = loadWindow()
  for (const url of [
    "file://///attacker/share/x.exe",
    "ms-msdt:probe",
    "search-ms:probe",
    "custom://probe",
    "javascript:alert(1)",
    "data:text/html,probe",
    "mailto:a@example.com",
    "https://",
    "https:///example.com",
    "//example.com",
  ]) {
    assert.equal(win.newWindow(url), "deny")
    assert.equal(win.navigate(url), true)
  }
  assert.equal(win.opened.length, 0)
  assert.equal(win.warnings.length, 20)
})

test("both entry points open HTTP(S), deny child windows, and preserve app navigation", () => {
  const win = loadWindow("http://localhost:8888")
  assert.equal(win.newWindow("https://example.com/help"), "deny")
  assert.equal(win.navigate("http://example.com/help"), true)
  assert.deepEqual(win.opened, [
    "https://example.com/help",
    "http://example.com/help",
  ])
  for (const url of [
    "app://local/menu",
    "app://local/sign-in",
    "http://localhost:8888/menu",
  ]) {
    assert.equal(win.navigate(url), false)
  }
  assert.equal(win.navigate("http://localhost:8888.attacker.example/"), true)
  assert.equal(win.navigate("http://localhost:8888@attacker.example/"), true)
  assert.equal(win.navigate("app://local.attacker.example/"), true)
  assert.equal(win.opened.length, 3)
})

test("external-open rejection is handled without logging URL secrets", async () => {
  const win = loadWindow()
  win.rejectNextOpen()
  win.newWindow("https://example.com/?token=private")
  await Promise.resolve()
  assert.equal(win.warnings.length, 1)
  assert.equal(win.warnings[0].includes("private"), false)
})

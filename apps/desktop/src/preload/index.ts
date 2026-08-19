import { contextBridge, ipcRenderer } from "electron"

import { IPC } from "@admin/platform/desktop/contract"
import type {
  AuthLoginInput,
  DesktopBridge,
  DesktopConfig,
  DeviceEvent,
  PrintOptions,
  UpdaterEvent,
} from "@admin/platform/desktop/contract"

/**
 * 渲染层与主进程之间**唯一**的通道。
 *
 * 纪律:这里是白名单,不是转发器。绝不要暴露 `ipcRenderer` 本体或者一个
 * `invoke(channel, ...args)` 万能函数 —— 那等于把 contextIsolation 白开。
 * 渲染层能做什么,完全由下面这个对象的形状决定。
 */

/** 把 (event, payload) 形状的监听包成只给 payload 的订阅,并返回取消函数 */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

/**
 * 统一的 invoke。
 *
 * 为什么不直接用 ipcRenderer.invoke：主进程 handler 抛出的错误，Electron 会包一层
 * `Error invoking remote method 'auth:refresh': Error: ` 前缀再送到渲染层。渲染层若把
 * err.message 直接显给用户，看到的就是这串噪音 —— 而 auth 这类错误（「登录已过期，
 * 请重新登录」）本来就是给人看的。实测确认过这个前缀存在，这里剥掉它。
 */
const REMOTE_PREFIX = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message.replace(REMOTE_PREFIX, ""))
  }
}

const bridge: DesktopBridge = {
  app: {
    info: () => call(IPC.appInfo),
  },
  config: {
    get: () => call(IPC.configGet),
    set: (patch: Partial<DesktopConfig>) => call(IPC.configSet, patch),
  },
  auth: {
    login: (input: AuthLoginInput) => call(IPC.authLogin, input),
    refresh: () => call(IPC.authRefresh),
    restore: () => call(IPC.authRestore),
    logout: () => call(IPC.authLogout),
  },
  print: {
    listPrinters: () => call(IPC.printListPrinters),
    html: (html: string, options?: PrintOptions) => call(IPC.printHtml, html, options),
    htmlToPdf: (html: string, options?: PrintOptions) =>
      call(IPC.printHtmlToPdf, html, options),
  },
  devices: {
    list: () => call(IPC.deviceList),
    start: (id: string) => call(IPC.deviceStart, id),
    stop: (id: string) => call(IPC.deviceStop, id),
    simulate: (id: string, payload?: Record<string, unknown>) =>
      call(IPC.deviceSimulate, id, payload),
    on: (handler: (event: DeviceEvent) => void) => subscribe(IPC.deviceEvent, handler),
  },
  updater: {
    check: () => call(IPC.updaterCheck),
    quitAndInstall: () => call(IPC.updaterQuitAndInstall),
    on: (handler: (event: UpdaterEvent) => void) => subscribe(IPC.updaterEvent, handler),
  },
}

contextBridge.exposeInMainWorld("desktop", bridge)

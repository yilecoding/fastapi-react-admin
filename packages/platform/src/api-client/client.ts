import { createApiClient, resolveEnvelope, type Method } from '@admin/api'

import { tokenStore } from './token-store'

export const API_BASE = import.meta.env?.VITE_API_BASE ?? 'http://127.0.0.1:8088'

/**
 * 发给后端的界面语言。由 app 的 i18n 层通过 `setApiLanguage()` 注入
 * （`apps/web/src/i18n.ts`）—— platform 不该知道有哪些语言，
 * 它只负责把当前语言发出去。为什么必须发，见 `@admin/api` 的 `ApiClientConfig`。
 */
let uiLanguage = 'zh-CN'
export function setApiLanguage(lang: string): void {
  uiLanguage = lang
}

/*
 * 🔴 **传输层不在这里了 —— 信封判定、401 单飞刷新、Accept-Language 全在
 * `@admin/api` 的 `createApiClient` 里，与移动端共用一份。**
 * 这里只注入 web 特有的四件事：地址来自 Vite 环境变量、token 存在
 * localStorage（`tokenStore`）、语言来自上面那个注入点。
 * 想改重试/错误判定逻辑，去改那个包，不要在这里补一份。
 */
const client = createApiClient({
  getBaseUrl: () => API_BASE,
  getToken: () => tokenStore.get(),
  setToken: (t) => tokenStore.set(t),
  clearToken: () => tokenStore.clear(),
  getLanguage: () => uiLanguage,
})

export const { setSessionExpiredHandler, endSession } = client

export const api = {
  GET: <T>(path: string, init?: Record<string, unknown>) => client.GET<T>(path, init),
  POST: <T>(path: string, init?: Record<string, unknown>) => client.POST<T>(path, init),
  PUT: <T>(path: string, init?: Record<string, unknown>) => client.PUT<T>(path, init),
  DELETE: <T>(path: string, init?: Record<string, unknown>) => client.DELETE<T>(path, init),
  PATCH: <T>(path: string, init?: Record<string, unknown>) => client.PATCH<T>(path, init),
}

/**
 * 上传单个文件，返回拆过包封的裸 data。
 *
 * 🔴 **成败判定必须过 `resolveEnvelope`。** `sendRaw` 只看 `!res.ok`，
 * 而 FBA 的 `response_base.fail()` 是 HTTP 200 + `code: 400` ——
 * 这里原来直接取 `body.data`，被拒的上传会静默返回 `null`，
 * 调用方拿到一个「成功了但没有文件」的结果。
 * 现在 `/sys/files/upload` 恰好总走 `success()`，所以还没炸过，
 * 但下一个接了这条的接口就会。
 */
export async function uploadFile<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData()
  form.append(field, file)
  const res = await client.sendRaw('POST', path, form, 'application/json')
  const body: unknown = await res.json().catch(() => null)
  const outcome = resolveEnvelope<T>(res, body)
  if (!outcome.ok) throw outcome.error
  return outcome.data
}

/**
 * 取原始字节。给文件预览器用 —— 它要 ArrayBuffer，而这个请求必须带
 * Authorization 头（后端 `/static/upload` 那个无鉴权直链已经撤掉了）。
 */
export async function fetchBytes(path: string): Promise<ArrayBuffer> {
  const res = await client.sendRaw('GET', path, undefined, '*/*')
  return res.arrayBuffer()
}

/** 分页结构在 `@admin/api` 里，这里 re-export 保持调用点不变 */
export type { PageData } from '@admin/api'
export type { Method }

import createOpenApiClient from 'openapi-fetch'

import type { paths } from './schema'
import { ApiError, isEnvelope } from './errors'
import { tokenStore } from './token-store'

export const API_BASE = import.meta.env?.VITE_API_BASE ?? 'http://127.0.0.1:8000'

const raw = createOpenApiClient<paths>({ baseUrl: API_BASE, credentials: 'include' })

// ─── 401 单飞刷新 ──────────────────────────────────────────────────────────────
// 并发请求同时收到 401 时，只允许一次 /auth/refresh 在途，其余排队等它的结果。
// 没有这层，token 过期瞬间会打出 N 个 refresh 请求，后端会话表和 Redis 都会被打乱。

let refreshing: Promise<boolean> | null = null

/** 会话失效时的回调（由 auth 层注入，用于清状态 + 跳登录页） */
let onSessionExpired: (() => void) | null = null
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn
}

/**
 * 主动结束会话，走与 401 完全相同的收尾路径（清 token → 清缓存 → 跳登录页）。
 *
 * 用于「我们**知道**服务端已经把 token 作废了」的场景，典型是改密码：
 * `user_service.update_password` 会 `delete_by_prefix` 掉该用户的
 * access / refresh / 用户缓存三组 key。不主动收场的话，用户会在下一个
 * 请求 401 时被莫名其妙弹回登录页 —— 看起来像 bug，其实是预期行为。
 */
export function endSession() {
  tokenStore.clear()
  onSessionExpired?.()
}

async function refreshToken(): Promise<boolean> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      // refresh token 在 httpOnly cookie 里，靠 credentials:'include' 自动带上
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Accept-Language': uiLanguage },
      })
      if (!res.ok) return false
      const body = (await res.json()) as { code: number; data?: { access_token?: string } }
      const next = body?.data?.access_token
      if (!next) return false
      tokenStore.set(next)
      return true
    } catch {
      return false
    } finally {
      // 交给微任务队列，确保同批次的等待者都拿到同一个结果后再复位
      queueMicrotask(() => {
        refreshing = null
      })
    }
  })()
  return refreshing
}

// ─── 统一请求入口 ──────────────────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/**
 * 发给后端的界面语言。由 app 的 i18n 层通过 `setApiLanguage()` 注入。
 *
 * ⚠️ 不能不发这个头、让浏览器自己决定。后端有 i18n 中间件
 * （`middleware/i18n_middleware.py`）按 `Accept-Language` 切换响应 `msg`，
 * 实测后果：
 *   - 英文浏览器 → 中文界面里混进英文接口消息
 *   - 日文/法文等**未映射**语言 → `I18n.t()` 走 KeyError 分支，把 key 换成
 *     `error.language_not_found`，于是**所有** `msg` 都变成
 *     「当前语言包未初始化或不存在」—— 错误提示全废
 */
let uiLanguage = 'zh-CN'

/**
 * 由 app 的 i18n 层注入（`apps/web/src/i18n.ts`）。
 * platform 不该知道有哪些语言 —— 它只负责把当前语言发出去。
 */
export function setApiLanguage(lang: string): void {
  uiLanguage = lang
}

function authHeaders(): Record<string, string> {
  const t = tokenStore.get()
  return {
    'Accept-Language': uiLanguage,
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

/**
 * 发一个请求，并**拆掉 FBA 的 `{code,msg,data}` 包封**，
 * 让业务代码永远拿到裸 data。
 */
async function send<T>(method: Method, path: string, init: Record<string, unknown> = {}, retry = true): Promise<T> {
  const fn = (raw as unknown as Record<string, (p: string, i: unknown) => Promise<unknown>>)[method]
  const merged = {
    ...init,
    headers: { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) },
  }

  const result = (await fn(path, merged)) as {
    data?: unknown
    error?: unknown
    response: Response
  }
  const { data, error, response } = result

  if (error !== undefined || !response.ok) {
    const body = (error ?? data) as unknown
    const bizCode = isEnvelope(body) ? body.code : response.status
    const msg = isEnvelope(body) ? body.msg : response.statusText

    // 401 → 单飞刷新后重放一次；刷新失败则判定会话结束
    if (response.status === 401 && retry) {
      const ok = await refreshToken()
      if (ok) return send<T>(method, path, init, false)
      tokenStore.clear()
      onSessionExpired?.()
    }
    throw new ApiError(response.status, bizCode, msg, isEnvelope(body) ? body.data : body)
  }

  // 拆包：业务代码不该看见 code/msg
  return (isEnvelope(data) ? (data.data as T) : (data as T))
}

export const api = {
  GET: <T>(path: string, init?: Record<string, unknown>) => send<T>('GET', path, init),
  POST: <T>(path: string, init?: Record<string, unknown>) => send<T>('POST', path, init),
  PUT: <T>(path: string, init?: Record<string, unknown>) => send<T>('PUT', path, init),
  DELETE: <T>(path: string, init?: Record<string, unknown>) => send<T>('DELETE', path, init),
  PATCH: <T>(path: string, init?: Record<string, unknown>) => send<T>('PATCH', path, init),
}

// ─── 非 JSON 传输：multipart 上传 / 原始字节下载 ────────────────────────────────
//
// 这两条走裸 `fetch` 而不是上面的 `send()`，因为 openapi-fetch 会把 body 当 JSON
// 序列化、把响应当 JSON 解析 —— 对 FormData 和 ArrayBuffer 都是错的。
// 但 401 单飞刷新、Accept-Language、Authorization 这些必须共用，所以复用 authHeaders()
// 和 refreshToken()，不要在业务层自己 new 一个 fetch。

async function sendRaw(method: Method, path: string, body: BodyInit | undefined, accept: string, retry = true) {
  const headers = { ...authHeaders(), Accept: accept }
  // ⚠️ 绝对不要给 FormData 手写 Content-Type —— multipart 的 boundary 是浏览器
  // 生成并塞进 header 的，手写一个不带 boundary 的 'multipart/form-data'
  // 会让后端解析不出任何字段（表现为「文件不能为空」）
  const res = await fetch(`${API_BASE}${path}`, { method, body, headers, credentials: 'include' })

  if (!res.ok) {
    if (res.status === 401 && retry) {
      const ok = await refreshToken()
      if (ok) return sendRaw(method, path, body, accept, false)
      tokenStore.clear()
      onSessionExpired?.()
    }
    // 错误响应仍然是 FBA 的 JSON 包封，尽量把 msg 捞出来给用户看
    let msg = res.statusText
    let bizCode: number | string = res.status
    try {
      const parsed: unknown = await res.json()
      if (isEnvelope(parsed)) {
        msg = parsed.msg
        bizCode = parsed.code
      }
    } catch {
      // 不是 JSON（例如反代返回的 HTML 错误页）就保留 statusText
    }
    throw new ApiError(res.status, bizCode, msg)
  }
  return res
}

/** 上传单个文件，返回拆过包封的裸 data */
export async function uploadFile<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData()
  form.append(field, file)
  const res = await sendRaw('POST', path, form, 'application/json')
  const body: unknown = await res.json()
  return (isEnvelope(body) ? (body.data as T) : (body as T))
}

/**
 * 取原始字节。给文件预览器用 —— 它要 ArrayBuffer，而这个请求必须带
 * Authorization 头（后端 `/static/upload` 那个无鉴权直链已经撤掉了）。
 */
export async function fetchBytes(path: string): Promise<ArrayBuffer> {
  const res = await sendRaw('GET', path, undefined, '*/*')
  return res.arrayBuffer()
}

/** FBA 的分页返回结构，直接喂 TanStack Table 的服务端分页 */
export type PageData<T> = {
  items: T[]
  total: number
  page: number
  size: number
  total_pages: number
  links: { first: string; last: string; next: string | null; prev: string | null }
}

import { createApiClient, resolveEnvelope, type Method } from '@admin/api'
import type { paths } from '@admin/api/schema'

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
const client = createApiClient<paths>({
  getBaseUrl: () => API_BASE,
  getToken: () => tokenStore.get(),
  setToken: (t) => tokenStore.set(t),
  clearToken: () => tokenStore.clear(),
  getLanguage: () => uiLanguage,
})

export const { setSessionExpiredHandler, endSession } = client

/**
 * ⚠️ **web 端目前用的是「松」的类型面：路径是 `string`、返回类型靠调用点手写 `<T>`。**
 *
 * `@admin/api` 已经有一套从 `schema.d.ts` 推断的严类型面（`ApiMethods<paths>`，
 * 见那个包的 `types.ts`），移动端**已经切过去了**。web 端没切，是因为有三处
 * **结构性**障碍，不是「还没抄完」：
 *
 * | 障碍 | 位置 | 为什么不是机械改动 |
 * |---|---|---|
 * | 仪表盘拼动态路径 | `pages/dashboard/api.ts` 的 `` `${path}?${q}` `` | 字面量路径类型对运行时字符串不成立 |
 * | 约 20 个页面的查询串是函数拼的 | `?${qs(p)}` / `?${scopeQs(p)}` / `?${buildQuery(...)}` | 要改成 `params.query` 就得把那 20 个构造器逐个重设计（它们还顺手做了丢空值、格式化日期等事） |
 *
 * ⚠️ 曾经还有第三条「列表页引擎的路径是运行时配置」（`_shared` 下那个只读列表工厂
 * 的 `cfg.endpoint`）—— 那个文件**零调用方**，已经删了。休眠代码的代价就是
 * 这个：它让一次架构评估多报了一条根本不存在的障碍。
 *
 * 🔴 **所以这里刻意保留一层转发 + 一次 `as`。** 转发会把 `Paths` 的泛型擦掉 ——
 * 那正是「松」的含义，但代价是**路径写错、字段名写错都没有信号**。
 * 谁要动这块：切换的正确顺序是先解掉上面三条，再把 `api` 换成 `client` 本身。
 */
type LooseMethod = (path: string, init?: Record<string, unknown>) => Promise<unknown>
const loose = client as unknown as Record<Method, LooseMethod>

export const api = {
  GET: <T>(path: string, init?: Record<string, unknown>) => loose.GET(path, init) as Promise<T>,
  POST: <T>(path: string, init?: Record<string, unknown>) => loose.POST(path, init) as Promise<T>,
  PUT: <T>(path: string, init?: Record<string, unknown>) => loose.PUT(path, init) as Promise<T>,
  DELETE: <T>(path: string, init?: Record<string, unknown>) => loose.DELETE(path, init) as Promise<T>,
  PATCH: <T>(path: string, init?: Record<string, unknown>) => loose.PATCH(path, init) as Promise<T>,
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

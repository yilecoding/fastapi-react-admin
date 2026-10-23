import { ApiError, createApiClient, type Method, type RefreshOutcome, type UploadOptions } from '@admin/api'
import type { paths } from '@admin/api/schema'

import { clientIdleSeconds } from '../auth/activity'
import { tryDesktop } from '../desktop'
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

/**
 * 桌面端的刷新交给主进程（`apps/desktop/src/main/auth.ts`）。
 *
 * 🔴 渲染层跑在 `app://local` 下，对后端是跨站请求，浏览器不带 `SameSite=Lax` 的 refresh cookie ——
 * 默认的 cookie 刷新走不通（主进程 `auth.ts` 的注释里记着当时的现象：access 一过期就 401、refresh 也 401）。
 * #138 之前 access token 活 1 天，表现成「每天要重登一次」；改成 30 分钟之后会变成每半小时被踢一次。
 * 主进程自己发请求、手动带 Cookie 头，不受这套规则约束
 */
async function desktopRefresh(): Promise<RefreshOutcome> {
  const result = await tryDesktop()!.auth.refresh()
  if (result.ok) return { kind: 'ok', token: result.tokens.accessToken }
  if (result.terminal) return { kind: 'ended', end: { reason: result.reason, message: result.message } }
  return { kind: 'transient', error: new ApiError(0, 0, result.message) }
}

/*
 * 🔴 **传输层不在这里了 —— 信封判定、401 单飞刷新、Accept-Language 全在
 * `@admin/api` 的 `createApiClient` 里，与移动端共用一份。**
 * 这里只注入 web 特有的几件事：地址来自 Vite 环境变量、token 只在内存（`tokenStore`）、
 * 语言来自上面那个注入点、空闲秒数来自 `auth/activity.ts`、桌面端换一种刷新方式。
 * 想改重试/错误判定逻辑，去改那个包，不要在这里补一份。
 */
const client = createApiClient<paths>({
  getBaseUrl: () => API_BASE,
  getToken: () => tokenStore.get(),
  setToken: (t) => tokenStore.set(t),
  clearToken: () => tokenStore.clear(),
  getLanguage: () => uiLanguage,
  getClientIdle: () => clientIdleSeconds(),
  refresh: tryDesktop() ? desktopRefresh : undefined,
})

export const { setSessionExpiredHandler, endSession, restoreSession } = client

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
export async function uploadFile<T>(path: string, file: File, field = 'file', options?: UploadOptions): Promise<T> {
  const form = new FormData()
  form.append(field, file)
  // 走 `sendUpload`（XHR）：有上传进度、可取消；信封判定、401 刷新都在 `@admin/api` 里做
  return client.sendUpload<T>(path, form, options)
}

/** 一个 multipart 表单（文件 + 别的字段一起），同 `uploadFile` 走 XHR */
export async function uploadForm<T>(path: string, form: FormData, options?: UploadOptions): Promise<T> {
  return client.sendUpload<T>(path, form, options)
}

/** 传一段裸字节（分片上传的一片），同样有进度、可取消 */
export async function uploadBlob<T>(path: string, blob: Blob, options?: UploadOptions): Promise<T> {
  return client.sendUpload<T>(path, blob, { method: 'PUT', ...options })
}

/**
 * 取原始字节。给文件预览器用 —— 它要 ArrayBuffer，而这个请求必须带
 * Authorization 头（后端 `/static/upload` 那个无鉴权直链已经撤掉了）。
 */
export async function fetchBytes(path: string): Promise<ArrayBuffer> {
  const res = await client.sendRaw('GET', path, undefined, '*/*')
  return res.arrayBuffer()
}

/**
 * 取一个要存成文件的响应：字节 + **后端起的文件名**（`Content-Disposition`）。
 *
 * 导出文件、导入模板、错误报告的名字都是后端按当前语言起的（「部门导入模板.xlsx」）。
 * 前端自己再写一份就是两份翻译各说各的 —— 所以名字从响应头里读，读不到才用调用方给的兜底。
 *
 * ⚠️ 跨源时（开发期 8888 → 8088、桌面端 `app://local`）这个头要后端在
 * `CORS_EXPOSE_HEADERS` 里列出来，否则 `headers.get()` 拿到的是 `null` —— 不报错，
 * 只是静静地用了兜底名
 */
export async function fetchFile(path: string): Promise<{ buffer: ArrayBuffer; filename: string | null; type: string | null }> {
  const res = await client.sendRaw('GET', path, undefined, '*/*')
  return {
    buffer: await res.arrayBuffer(),
    filename: filenameOf(res.headers.get('content-disposition')),
    type: res.headers.get('content-type'),
  }
}

/**
 * 从 `Content-Disposition` 里取文件名。后端写的是 RFC 6266 两段式：
 * `attachment; filename="ascii.xlsx"; filename*=UTF-8''%E9%83%A8%E9%97%A8.xlsx` ——
 * 优先 `filename*`（带中文的那个），没有才退回 ASCII 的 `filename`
 */
export function filenameOf(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      // 编码坏了就退回 ASCII 那一段
    }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)
  return plain ? plain[1].replace(/\\(.)/g, '$1') : null
}

/** 分页结构在 `@admin/api` 里，这里 re-export 保持调用点不变 */
export type { PageData } from '@admin/api'
export type { Method }

import { ApiError, createApiClient, NETWORK_STATUS } from '@admin/api'
import { currentLanguage, t } from '@admin/i18n'

import { serverStore } from '@/lib/server'
import { tokenStore } from '@/lib/token-store'

/**
 * 移动端的 API 客户端 —— **只是 `@admin/api` 的一次实例化**。
 *
 * 信封判定（HTTP 200 + `code: 400`）、401 单飞刷新、`Accept-Language`、
 * 错误类型、分页结构、生成的接口类型**全在那个包里，和 web 端共用一份**。
 * 这里只注入移动端特有的四件事：
 *
 * | 注入项 | 移动端 | web 端 |
 * |---|---|---|
 * | 地址 | `serverStore`（SecureStore，**运行时可改**） | `import.meta.env.VITE_API_BASE` |
 * | token | `tokenStore`（SecureStore + 内存镜像） | `sessionStorage` |
 * | 语言 | `currentLanguage()` 直接读 | app 层 `setApiLanguage()` 注入 |
 * | 网络错误文案 | 下面那层 i18n 包装 | 直接抛 |
 *
 * ⚠️ 这份文件曾经**自己复制了一份**传输层（拆包 + 刷新 + 头），代价是
 * 「HTTP 200 + code 400 被当成成功」那个坑两端各有一份、改一边不修另一边。
 * **不要再往这里抄逻辑** —— 要改判定去改 `packages/api/src/client.ts`。
 */
const client = createApiClient({
  getBaseUrl: () => serverStore.current(),
  getToken: () => tokenStore.get(),
  setToken: (token) => tokenStore.set(token),
  clearToken: () => tokenStore.clear(),
  // 🔴 必须跟界面语言同步。写死过 `'zh-CN'`：切成英文界面后接口报错还是中文
  getLanguage: () => currentLanguage(),
})

export const setSessionExpiredHandler = client.setSessionExpiredHandler

/**
 * 网络错误的文案本地化。
 *
 * 共享包不能 import `@admin/i18n`（它要保持零 workspace 依赖），而 RN 的网络
 * 失败只有一句笼统的 `Network request failed`、不提是连不上还是 DNS 还是 TLS。
 * 移动端尤其需要把**地址**摆出来 —— 地址是用户自己能改的，看不到它就完全
 * 没有线索。所以在这一层把 `isNetwork` 的错误重新包一遍。
 */
function localize(err: unknown): unknown {
  if (err instanceof ApiError && err.isNetwork) {
    return new ApiError(
      NETWORK_STATUS,
      NETWORK_STATUS,
      t('连不上服务器（{{base}}）：{{reason}}', { base: serverStore.current(), reason: err.message }),
      err.detail,
    )
  }
  return err
}

async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (err) {
    throw localize(err)
  }
}

/**
 * ⚠️ 签名是**移动端形状**：body 直接当第二个参数传，不用包成 `{ body }`。
 * 底层 openapi-fetch 收的是 init 对象，这里替调用点转一次 —— 13 个调用点
 * 都长这样，没必要为了贴合底层而改一遍。
 */
export const api = {
  GET: <T>(path: string) => wrap(client.GET<T>(path)),
  POST: <T>(path: string, body?: unknown) => wrap(client.POST<T>(path, body === undefined ? {} : { body })),
  PUT: <T>(path: string, body?: unknown) => wrap(client.PUT<T>(path, body === undefined ? {} : { body })),
  DELETE: <T>(path: string, body?: unknown) => wrap(client.DELETE<T>(path, body === undefined ? {} : { body })),
}

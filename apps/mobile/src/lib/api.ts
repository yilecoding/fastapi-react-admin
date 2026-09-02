import { ApiError, createApiClient, NETWORK_STATUS } from '@admin/api'
import type { paths } from '@admin/api/schema'
import { currentLanguage, t } from '@admin/i18n'

import { serverStore } from '@/lib/server'
import { tokenStore } from '@/lib/token-store'

/**
 * 移动端的 API 客户端 —— **只是 `@admin/api` 的一次实例化**。
 *
 * 信封判定（HTTP 200 + `code: 400`）、401 单飞刷新、`Accept-Language`、
 * 错误类型、分页结构、**以及从 `schema.d.ts` 推断出来的全部类型**
 * 都在那个包里，和 web 端共用一份。这里只注入移动端特有的四件事：
 *
 * | 注入项 | 移动端 | web 端 |
 * |---|---|---|
 * | 地址 | `serverStore`（SecureStore，**运行时可改**） | `import.meta.env.VITE_API_BASE` |
 * | token | `tokenStore`（SecureStore + 内存镜像） | `sessionStorage` |
 * | 语言 | `currentLanguage()` 直接读 | app 层 `setApiLanguage()` 注入 |
 * | 网络错误文案 | `onNetworkError` 注入 i18n | 直接抛 |
 *
 * 🔴 **移动端用的是严类型面：路径、查询参数名、请求体、返回字段全部由
 * `schema.d.ts` 推出来。** 写错就是编译错误。
 * web 端还在松类型面上（`packages/platform/src/api-client/client.ts` 里
 * 记着三条结构性障碍）。
 *
 * ⚠️ **不要在外面再包一层函数转发这几个方法** —— 包一层就把泛型擦成
 * `Promise<unknown>`，推断白做（网络错误的文案本来是包在外面的，
 * 正是为此改成了 `onNetworkError` 注入点）。
 */
export const api = createApiClient<paths>({
  getBaseUrl: () => serverStore.current(),
  getToken: () => tokenStore.get(),
  setToken: (token) => tokenStore.set(token),
  clearToken: () => tokenStore.clear(),
  // 🔴 必须跟界面语言同步。写死过 `'zh-CN'`：切成英文界面后接口报错还是中文
  getLanguage: () => currentLanguage(),
  /*
   * 网络错误的文案本地化。共享包不能 import `@admin/i18n`（要保持零 workspace
   * 依赖），而 RN 的网络失败只有一句笼统的 `Network request failed`、不提是
   * 连不上还是 DNS 还是 TLS。移动端尤其需要把**地址**摆出来 ——
   * 地址是用户自己能改的，看不到它就完全没有线索。
   */
  onNetworkError: (err) =>
    new ApiError(
      NETWORK_STATUS,
      NETWORK_STATUS,
      t('连不上服务器（{{base}}）：{{reason}}', { base: serverStore.current(), reason: err.message }),
      err.detail,
    ),
})

export const setSessionExpiredHandler = api.setSessionExpiredHandler

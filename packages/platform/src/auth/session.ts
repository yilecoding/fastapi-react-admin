import type { QueryClient } from '@tanstack/react-query'

import { api } from '../api-client/client'
import { tokenStore } from '../api-client/token-store'
import { useTabStore } from '../shell/tab-store'
import { authKeys } from './queries'

/**
 * 换身份要清掉的**客户端**状态。
 *
 * 🔴 标签页存在 sessionStorage（`admin:tabs`），而「退出登录再登录另一个账号」
 * **不换 session** —— 于是上一个人开过的 tab 会完整地出现在下一个人的标签条上，
 * 包括他没有权限的那些页面。而 `TabOutlet` 是按 `routeId` 直接从 page-registry
 * 挂组件的，不经过路由 `beforeLoad`，所以恢复出来的 `activeKey` 指向的那一页
 * 在首帧是 `visible` 的 —— 它真的会挂载、真的会取数（实测打出过
 * `GET /sys/configs/all`）。见 issue #29。
 *
 * ⚠️ 为什么放在 `auth/` 这一层而不是各个调用方：换身份的入口有三个
 * （退出菜单、登录页、401 会话失效后重新登录），放调用方就是三处都要记得，
 * 漏一个这个 bug 就复发，而它的表现（标签条上多几个点了跳 403 的 tab）
 * 不像 bug，像「历史遗留」。这里是唯一一处必经之地。
 *
 * ⚠️ 偏好设置（`admin:prefs`，localStorage）**刻意不清** —— 主题 / 圆角 /
 * 标签条外观是「这台机器上我想看到什么」，换人登录也不该被重置。
 */
function clearClientSessionState() {
  useTabStore.getState().reset()
}

export type LoginParam = {
  username: string
  password: string
  uuid?: string
  captcha?: string
}

type LoginResult = {
  access_token: string
  access_token_expire_time: string
  session_uuid: string
  password_expire_days_remaining: number | null
  user: unknown
}

export async function login(qc: QueryClient, param: LoginParam) {
  const res = await api.POST<LoginResult>('/api/v1/auth/login', { body: param })
  tokenStore.set(res.access_token)
  // 「在线用户」页要靠它认出当前会话那一行，免得管理员把自己踢下线
  tokenStore.setSessionUuid(res.session_uuid)
  // 换了身份，整份服务端状态都要重取 —— 不能只失效 me
  qc.removeQueries({ queryKey: authKeys.all })
  // 上一个账号残留的标签页在这里清掉。**必须在 login 里也清**，不能只靠 logout：
  // 401 会话失效那条链（`setSessionExpiredHandler`）根本不走 logout
  clearClientSessionState()
  return res
}

export async function logout(qc: QueryClient) {
  try {
    await api.POST('/api/v1/auth/logout')
  } finally {
    tokenStore.clear()
    // 清全部缓存，避免下一个登录的人看到上一个人的数据
    qc.clear()
    // 标签条要当场空掉，而不是等下一次登录才清 —— 退出后停在登录页时，
    // 上一个人开过哪些页面不该还留在浏览器里
    clearClientSessionState()
  }
}

export function isAuthenticated() {
  return tokenStore.get() !== null
}

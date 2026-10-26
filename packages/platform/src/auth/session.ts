import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@admin/api'

import { api, endSession, restoreSession } from '../api-client/client'
import { tokenStore } from '../api-client/token-store'
import { tryDesktop } from '../desktop'

/** 会话结束的原因码与提示文案（和移动端共用的那一份在 `@admin/api`）。登录页从这里取，不直接依赖那个包 */
export { isSessionEndReason, SESSION_END_MESSAGE, type SessionEndReason } from '@admin/api'
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

/**
 * 这个标签页自己在登出：服务端撤销会话后会经 socket 推 `session:ended` 回来，
 * 那条推送不该再触发一遍「会话结束」的收尾（`handleSessionEnded`）
 */
let endingLocally = false

/**
 * 桌面端：登录请求由主进程发（它扣下 refresh cookie 加密存盘，见 `apps/desktop/src/main/auth.ts`）。
 * 主进程抛的是普通 Error（IPC 只带得过 message），包成 ApiError —— 登录页只认 ApiError，
 * 认不出就会把服务端的原话（「用户名或密码有误」）换成一句笼统的「登录失败」
 */
async function desktopLogin(param: LoginParam): Promise<string> {
  try {
    const tokens = await tryDesktop()!.auth.login(param)
    return tokens.accessToken
  } catch (err) {
    throw new ApiError(400, 400, err instanceof Error ? err.message : String(err))
  }
}

async function desktopLoginByPhone(param: PhoneLoginParam): Promise<string> {
  try {
    const tokens = await tryDesktop()!.auth.loginByPhone(param)
    return tokens.accessToken
  } catch (err) {
    throw new ApiError(400, 400, err instanceof Error ? err.message : String(err))
  }
}

export async function login(qc: QueryClient, param: LoginParam) {
  const token = tryDesktop()
    ? await desktopLogin(param)
    : (await api.POST<LoginResult>('/api/v1/auth/login', { body: param })).access_token
  afterLogin(qc, token)
}

export type PhoneCaptchaParam = { phone: string; uuid?: string; captcha?: string }
export type PhoneLoginParam = { phone: string; code: string }

/**
 * 手机验证码登录：发码（issue #168 第二步）。匿名接口，桌面端也直接走渲染层的 api 客户端 ——
 * 只有「换会话」那一步要主进程接管（它要扣下 refresh cookie），发码不涉及会话。
 * 图形验证码开着时要带 uuid + captcha，服务端校验后**消费掉**，发完要重新拉一张。
 */
export async function sendPhoneCaptcha(param: PhoneCaptchaParam) {
  await api.POST<null>('/api/v1/auth/phone/captcha', { body: param })
}

/** 手机验证码登录：换会话。收尾和密码登录同一段 */
export async function loginByPhone(qc: QueryClient, param: PhoneLoginParam) {
  const token = tryDesktop()
    ? await desktopLoginByPhone(param)
    : (await api.POST<LoginResult>('/api/v1/auth/phone/login', { body: param })).access_token
  afterLogin(qc, token)
}

function afterLogin(qc: QueryClient, token: string) {
  // 会话 ID 在 token 的载荷里（`tokenStore.getSessionUuid`），不用另存
  tokenStore.set(token)
  endingLocally = false
  // 换了身份，整份服务端状态都要重取 —— 不能只失效 me
  qc.removeQueries({ queryKey: authKeys.all })
  // 上一个账号残留的标签页在这里清掉。**必须在 login 里也清**，不能只靠 logout：
  // 401 会话失效那条链（`setSessionExpiredHandler`）根本不走 logout
  clearClientSessionState()
}

export async function logout(qc: QueryClient) {
  endingLocally = true
  try {
    // 桌面端只有主进程手里有 refresh token；它只带 cookie 登出，后端按 cookie 认会话
    const desktop = tryDesktop()
    if (desktop) await desktop.auth.logout()
    else await api.POST('/api/v1/auth/logout')
  } finally {
    tokenStore.clear()
    // 清全部缓存，避免下一个登录的人看到上一个人的数据
    qc.clear()
    // 标签条要当场空掉，而不是等下一次登录才清 —— 退出后停在登录页时，
    // 上一个人开过哪些页面不该还留在浏览器里
    clearClientSessionState()
  }
}

/**
 * 服务端推来「你的会话结束了」（socket 的 `session:ended`，#138）：被管理员踢、被新登录挤掉、
 * 同一个浏览器的另一个标签页登出了 ……
 *
 * 先试一次静默恢复再收尾：同一个浏览器里另一个标签页**重新登录了**的话，cookie 已经指向
 * 新会话，这个标签页换一枚 token 接着用就行。恢复出来的是**另一个人**（换账号登录）就不能接着用 ——
 * 页面上全是上一个人的数据。
 *
 * @param reason 后端的原因码，登录页据此出提示
 */
export async function handleSessionEnded(reason: string | null): Promise<void> {
  if (endingLocally) return
  const before = tokenStore.getUserId()
  const outcome = await restoreSession()
  if (outcome.kind === 'ok' && tokenStore.getUserId() === before) return
  endSession({ reason, message: null })
}

export function isAuthenticated() {
  return tokenStore.get() !== null
}

/** 心跳（`auth/activity.ts` 的 `useSessionHeartbeat` 在用户最近有操作时定时调）。模块级常量，引用稳定 */
export const sendHeartbeat = () => api.POST('/api/v1/auth/heartbeat')


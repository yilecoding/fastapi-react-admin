import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@admin/api'

import { api, endSession, restoreSession } from '../api-client/client'
import { tokenStore } from '../api-client/token-store'
import { tryDesktop } from '../desktop'
import type { AuthLoginOutcome } from '../desktop/contract'

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

/** 登录第一步过了、还差动态码（#181）。这时没有 access token，也没有 refresh cookie */
export type MfaChallenge = { mfaToken: string; mfaSetup: boolean }

type RawChallenge = { mfa_required: true; mfa_token: string; mfa_setup: boolean }

function challengeOf(res: LoginResult | RawChallenge): MfaChallenge | null {
  return 'mfa_required' in res ? { mfaToken: res.mfa_token, mfaSetup: res.mfa_setup } : null
}

export type MfaSetupInfo = { totp_secret: string; otpauth_uri: string }

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
async function desktopCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new ApiError(400, 400, err instanceof Error ? err.message : String(err))
  }
}

/** 桌面端第一步：令牌直接收下；要二次验证就把挑战原样交给登录页 */
async function desktopFirstStep(qc: QueryClient, run: () => Promise<AuthLoginOutcome>): Promise<MfaChallenge | null> {
  const outcome = await desktopCall(run)
  if (outcome.kind === 'mfa') return { mfaToken: outcome.mfaToken, mfaSetup: outcome.mfaSetup }
  afterLogin(qc, outcome.tokens.accessToken)
  return null
}

/**
 * 密码登录。返回 `null` = 已登录；返回挑战 = 开了（或被强制开）二次验证，登录页接着做第二步（#181）
 */
export async function login(qc: QueryClient, param: LoginParam): Promise<MfaChallenge | null> {
  const desktop = tryDesktop()
  if (desktop) return desktopFirstStep(qc, () => desktop.auth.login(param))
  const res = await api.POST<LoginResult | RawChallenge>('/api/v1/auth/login', { body: param })
  const challenge = challengeOf(res)
  if (!challenge) afterLogin(qc, (res as LoginResult).access_token)
  return challenge
}

export type PhoneCaptchaParam = { phone: string; uuid?: string; captcha?: string }
/** 短信验证码字段叫 `captcha` 不叫 `code`：后端按这个键名把它从操作日志里脱掉（`OPERA_LOG_REDACT_KEYS`） */
export type PhoneLoginParam = { phone: string; captcha: string }

/**
 * 手机验证码登录：发码（issue #168 第二步）。匿名接口，桌面端也直接走渲染层的 api 客户端 ——
 * 只有「换会话」那一步要主进程接管（它要扣下 refresh cookie），发码不涉及会话。
 * 图形验证码开着时要带 uuid + captcha，服务端校验后**消费掉**，发完要重新拉一张。
 */
export async function sendPhoneCaptcha(param: PhoneCaptchaParam) {
  await api.POST<null>('/api/v1/auth/phone/captcha', { body: param })
}

/** 手机验证码登录：换会话。收尾和密码登录同一段；同样可能要二次验证 */
export async function loginByPhone(qc: QueryClient, param: PhoneLoginParam): Promise<MfaChallenge | null> {
  const desktop = tryDesktop()
  if (desktop) return desktopFirstStep(qc, () => desktop.auth.loginByPhone(param))
  const res = await api.POST<LoginResult | RawChallenge>('/api/v1/auth/phone/login', { body: param })
  const challenge = challengeOf(res)
  if (!challenge) afterLogin(qc, (res as LoginResult).access_token)
  return challenge
}

/**
 * 二次验证：登录第二步（动态码或恢复码）。
 * 动态码字段叫 `otp`：后端按这个键名把它从操作日志里脱掉（`OPERA_LOG_REDACT_KEYS`）
 */
export async function verifyMfa(qc: QueryClient, mfaToken: string, otp: string): Promise<void> {
  const desktop = tryDesktop()
  const token = desktop
    ? (await desktopCall(() => desktop.auth.mfaVerify({ mfaToken, otp }))).accessToken
    : (await api.POST<LoginResult>('/api/v1/auth/mfa/verify', { body: { mfa_token: mfaToken, otp } })).access_token
  afterLogin(qc, token)
}

/** 被强制、还没绑：取绑定用的密钥和二维码（匿名接口，不涉及会话，桌面端也直接走渲染层） */
export function fetchMfaSetup(mfaToken: string): Promise<MfaSetupInfo> {
  return api.POST<MfaSetupInfo>('/api/v1/auth/mfa/setup', { body: { mfa_token: mfaToken } })
}

/**
 * 被强制、还没绑：输对一次动态码 = 绑定完成并登录。
 * 🔴 返回恢复码 + 一个 `finish`：**登录页先把恢复码给人看、等他点了「已保存」再 finish 进系统** ——
 * 直接 afterLogin 的话路由守卫立刻把人带走，恢复码就再也看不到了
 */
export async function enrollMfa(mfaToken: string, otp: string): Promise<{ recoveryCodes: string[]; finish: (qc: QueryClient) => void }> {
  const desktop = tryDesktop()
  if (desktop) {
    const { tokens, recoveryCodes } = await desktopCall(() => desktop.auth.mfaEnroll({ mfaToken, otp }))
    return { recoveryCodes, finish: (qc) => afterLogin(qc, tokens.accessToken) }
  }
  const res = await api.POST<LoginResult & { recovery_codes: string[] }>('/api/v1/auth/mfa/enroll', {
    body: { mfa_token: mfaToken, otp },
  })
  return { recoveryCodes: res.recovery_codes, finish: (qc) => afterLogin(qc, res.access_token) }
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


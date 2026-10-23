import { app, safeStorage } from "electron"
import fs from "node:fs"
import path from "node:path"

import type { AuthLoginInput, AuthRefreshResult, AuthTokens } from "@admin/platform/desktop/contract"

import { readConfig } from "./config"

/**
 * 桌面端认证：**refresh token 由主进程托管**，渲染层只拿 access token。
 *
 * 这不是为了好看，是三个具体问题逼出来的：
 *
 * 1. 后端的 refresh token 在 httpOnly cookie 里，而 `set_cookie` 没传 samesite
 *    （backend/app/admin/service/auth_service.py），Starlette 默认 `SameSite=Lax`。
 *    渲染层跑在 `app://local` 源上时，对后端就是跨站，fetch 压根不会带这个 cookie。
 *    表现是：access token 一过期就 401，refresh 也 401，用户被踢回登录页。
 *    主进程自己发 HTTP 请求不经过浏览器那套 SameSite 规则，手动收发 Cookie 头即可。
 *
 * 2. 渲染层的 access token 只在内存里（api-client/token-store.ts，#138），
 *    窗口一关就没了 —— 不托管 refresh token 的话，终端机每天开机都要重新登录一次。
 *
 * 3. 凭据落在终端机器上，应该过 safeStorage（走 OS 的 DPAPI / Keychain），
 *    不该是明文 JSON。
 */

const ENDPOINTS = {
  login: "/api/v1/auth/login",
  refresh: "/api/v1/auth/refresh",
  logout: "/api/v1/auth/logout",
} as const

/** 后端 `settings.COOKIE_REFRESH_TOKEN_KEY` 的默认值 */
const REFRESH_COOKIE_NAME = "fba_refresh_token"

function credentialFile(): string {
  return path.join(app.getPath("userData"), "credentials.bin")
}

function saveRefreshToken(token: string): void {
  fs.mkdirSync(path.dirname(credentialFile()), { recursive: true })
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(credentialFile(), safeStorage.encryptString(token))
    return
  }
  // 拿不到 OS 级加密（少见，但 Linux 上没有 keyring 时会这样）。
  // ⚠️ 明写前缀标记为明文，而不是假装加密了 —— 出事时能一眼看出来。
  fs.writeFileSync(credentialFile(), Buffer.from("PLAINTEXT:" + token, "utf8"))
}

function loadRefreshToken(): string | null {
  try {
    const buf = fs.readFileSync(credentialFile())
    const asText = buf.toString("utf8")
    if (asText.startsWith("PLAINTEXT:")) return asText.slice("PLAINTEXT:".length)
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export function clearRefreshToken(): void {
  try {
    fs.rmSync(credentialFile(), { force: true })
  } catch {
    /* 删不掉也不该影响登出流程 */
  }
}

function baseUrl(): string {
  const { serverUrl } = readConfig()
  if (!serverUrl) throw new Error("尚未配置服务器地址，请先在设置里填写后端地址")
  return serverUrl
}

/** 从响应头里挑出 refresh cookie 的值。Node 20+ 的 undici 提供 getSetCookie() */
function extractRefreshCookie(res: Response): string | null {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
  for (const line of all) {
    const [pair] = line.split(";")
    const idx = pair.indexOf("=")
    if (idx > 0 && pair.slice(0, idx).trim() === REFRESH_COOKIE_NAME) {
      return pair.slice(idx + 1).trim()
    }
  }
  return null
}

interface Envelope<T> {
  code?: number
  msg?: string
  data?: T
}

interface RawTokens {
  access_token: string
  access_token_expire_time: string
  session_uuid?: string
}

async function unwrap(res: Response): Promise<RawTokens> {
  const body = (await res.json()) as Envelope<RawTokens> & Partial<RawTokens>
  // 后端统一包了 {code, msg, data}；但直接返回裸对象的路径也兼容一下
  const data = body.data ?? (body as unknown as RawTokens)
  if (!res.ok || !data?.access_token) {
    // ⚠️ 把服务端原话透出去，不要在这里替它编一句「登录失败」。
    // 服务端的校验规则（密码强度、验证码、账号锁定）只有它自己说得清。
    throw new Error(body.msg || `请求失败（HTTP ${res.status}）`)
  }
  return data
}

function toTokens(raw: RawTokens): AuthTokens {
  return {
    accessToken: raw.access_token,
    accessTokenExpireTime: raw.access_token_expire_time,
    sessionUuid: raw.session_uuid,
  }
}

export async function login(input: AuthLoginInput): Promise<AuthTokens> {
  const res = await fetch(`${baseUrl()}${ENDPOINTS.login}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // 会话策略按端分（#138）。渲染层不知道自己跑在桌面端里，由主进程补上
    body: JSON.stringify({ ...input, client: "desktop" }),
  })
  const raw = await unwrap(res)
  const refresh = extractRefreshCookie(res)
  if (refresh) saveRefreshToken(refresh)
  return toTokens(raw)
}

/**
 * 用存盘的 refresh token 换新的 access token。
 *
 * 只有 401 / 403 才删存盘凭据（会话真的结束了）；网络不通、5xx 只是这一次没刷成，
 * 凭据留着 —— 以前任何失败都当成过期，后端重启那几秒里刷新的终端全被踢回登录页（#138）。
 * 结果用返回值带回去而不是抛异常：IPC 只带得过 Error 的 message，原因码会丢。
 */
export async function refresh(): Promise<AuthRefreshResult> {
  const token = loadRefreshToken()
  if (!token) return { ok: false, terminal: true, reason: null, message: "没有可用的登录凭据，请重新登录" }
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${ENDPOINTS.refresh}`, {
      method: "POST",
      // 手动带 Cookie —— 这正是绕开 SameSite 的地方
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${token}` },
      // 短于后端的宽限期（30 秒）：响应丢了之后的重试要落在宽限期里，否则会被判成盗用
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return { ok: false, terminal: false, reason: null, message: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401 || res.status === 403) {
    clearRefreshToken()
    const body = (await res.json().catch(() => null)) as Envelope<{ reason?: string } | null> | null
    return {
      ok: false,
      terminal: true,
      reason: typeof body?.data?.reason === "string" ? body.data.reason : null,
      message: body?.msg || "登录已过期，请重新登录",
    }
  }
  try {
    const raw = await unwrap(res)
    // 后端每次 refresh 会轮换 refresh token，必须把新的存回去，否则下一次必失败
    const rotated = extractRefreshCookie(res)
    if (rotated) saveRefreshToken(rotated)
    return { ok: true, tokens: toTokens(raw) }
  } catch (err) {
    return { ok: false, terminal: false, reason: null, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 冷启动恢复会话。没有凭据是 `terminal` 且不带原因码，让界面安静地走登录页 */
export async function restore(): Promise<AuthRefreshResult> {
  return refresh()
}

/**
 * 登出。
 *
 * 🔴 这里**只带 cookie、不带 `Authorization`** —— access token 在渲染层的
 * 内存里，主进程手上没有。这依赖后端 `auth_service.logout()` 能从
 * **refresh cookie** 里认出会话（`{会话ID}.{secret}`，secret 对得上才算数，#138）。
 *
 * 后端曾经只认 access token（第一句 `get_token(request)` 拿不到 Bearer 就 `return`），
 * 于是这个请求是**彻底的空操作**：本地凭据删了、界面也回到登录页，而服务端三个 key
 * 一个没删，那个会话的 refresh token 还能再活 7 天。两边都看不出异常。
 * 回归测试钉在 `test_auth.py::test_logout_works_with_only_the_refresh_cookie`。
 */
export async function logout(): Promise<void> {
  const token = loadRefreshToken()
  clearRefreshToken()
  if (!token) return
  try {
    await fetch(`${baseUrl()}${ENDPOINTS.logout}`, {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${token}` },
    })
  } catch {
    // 网络不通也要让本地登出成功 —— 凭据已经删了，这才是用户要的结果
  }
}

/**
 * access token 的存放：**只在内存里**（#138）。
 *
 * refresh token 在 httpOnly cookie 里（桌面端由主进程托管），前端碰不到也不该碰。
 * 页面加载 / 新开标签页时这里是空的，路由守卫先用 refresh cookie 静默换一枚
 * （`restoreSession`，见 `auth/guards.ts`），换不到再去登录页。
 *
 * 为什么不再放 sessionStorage：
 *  - 每个标签页一份 sessionStorage，新开的标签页里没有 token，守卫又只看它 ——
 *    于是 Ctrl+点开一个菜单就要重新登录一遍
 *  - access token 只活 30 分钟，放进存储也续不了命，只是多一个能被脚本读走的地方
 *
 * 会话 ID 不再单独存，从 token 的载荷里读（`session_uuid`）：#138 之前这里另存了一份，
 * 而后端每刷新一次就换一个 ID，存着的那份从第一次刷新起就是错的 —— 在线用户页认不出
 * 当前会话、socket 把正连着的会话标成离线。现在会话 ID 整个会话不变，读 token 就够了。
 */
let token: string | null = null

type Claims = { session_uuid?: string; sub?: string }

/** 读 JWT 的载荷（不验签，验签是服务端的事；这里只取自己签发给自己的两个字段） */
function claimsOf(value: string | null): Claims | null {
  const part = value?.split('.')[1]
  if (!part) return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Claims
  } catch {
    return null
  }
}

export const tokenStore = {
  get(): string | null {
    return token
  },
  set(value: string | null) {
    token = value
  },
  /** 当前会话 ID（「在线用户」页靠它认出自己那一行，免得管理员把自己踢下线） */
  getSessionUuid(): string | null {
    return claimsOf(token)?.session_uuid ?? null
  },
  /** 当前用户 ID（字符串，雪花 ID 不能过 Number —— 硬纪律 6） */
  getUserId(): string | null {
    return claimsOf(token)?.sub ?? null
  },
  clear() {
    token = null
  },
}

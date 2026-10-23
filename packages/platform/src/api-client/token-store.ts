/**
 * access token 的存放。
 *
 * refresh token 在 httpOnly cookie 里（后端 `auth_service.py` 用 `response.set_cookie` 下发），
 * 前端碰不到也不该碰 —— 我们只管 access token。
 *
 * 顺带存 **session_uuid**：登录接口会连同 token 一起下发，
 * 「在线用户」页要靠它认出哪一行是当前这个浏览器的会话（不然会把自己踢下线）。
 * 会话 ID 从登录到登出不变（#138，后端 `common/security/session.py`），刷新只换令牌不换它。
 * ⚠️ #138 之前这句注释是**假的**：那时每刷新一次后端就换一个 session_uuid，而这里存的还是登录时那个 ——
 * 在线用户页认不出当前会话、socket 把正连着的会话标成离线（实测：刷新前后 ID 不同）。
 */
const KEY = 'admin:access-token'
const SESSION_KEY = 'admin:session-uuid'

let memory: string | null = null
let sessionMemory: string | null = null

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用，内存态仍然有效 */
  }
}

export const tokenStore = {
  get(): string | null {
    if (memory !== null) return memory
    memory = read(KEY)
    return memory
  },
  set(token: string | null) {
    memory = token
    write(KEY, token)
  },
  /** 当前浏览器会话的 session_uuid（登录时下发；未登录或旧会话为 null） */
  getSessionUuid(): string | null {
    if (sessionMemory !== null) return sessionMemory
    sessionMemory = read(SESSION_KEY)
    return sessionMemory
  },
  setSessionUuid(uuid: string | null) {
    sessionMemory = uuid
    write(SESSION_KEY, uuid)
  },
  clear() {
    this.set(null)
    this.setSessionUuid(null)
  },
}

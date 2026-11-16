import * as SecureStore from 'expo-secure-store'

/**
 * 「本地已经登出、但服务端还没确认」的服务器地址（#319）。
 *
 * 🔴 **移动端的 refresh token 在 RN 的 cookie jar 里，而那个 jar 跨冷启动持久、我们手上没有删它的接口。**
 * 只有登出接口的响应（`Set-Cookie` 清空）能删掉它。原来登出失败（断网 / 服务器不可达）被吞掉、只清了
 * SecureStore 里的 access token —— 下次冷启动见到「没有 token」就去 `restoreSession()`，
 * `/auth/refresh` 带着那个还活着的 cookie 成功，**原用户被静默登回去**。共用的手机上就是把账号留给了下一个人。
 *
 * 所以登出时**先**落这个标记，服务端确认了再删：
 * - 冷启动见到当前地址在标记里 → 不做静默恢复，补发一次登出
 * - 在这台服务器上重新登录成功 → 删标记（新登录已经把 cookie 换掉了）
 *
 * ⚠️ 按**服务器地址**记，不是一个布尔：cookie jar 按主机分，换了服务器之后补发的登出打到新服务器上，
 * 撤不掉旧服务器的会话；以后切回旧地址冷启动，照样要拦住那次静默恢复。
 *
 * 和 token 一样存 SecureStore：读写失败时宁可多拦一次恢复（让人重新登录），也不让 App 起不来。
 */
const KEY = 'admin.logout_pending'

let cached = new Set<string>()

async function persist(): Promise<void> {
  try {
    if (cached.size) await SecureStore.setItemAsync(KEY, JSON.stringify([...cached]))
    else await SecureStore.deleteItemAsync(KEY)
  } catch {
    // 落盘失败：本次进程里内存那份照样生效，只是冷启动后少一层保护
  }
}

export const logoutPending = {
  /** 冷启动时调用一次 */
  async hydrate(): Promise<void> {
    try {
      const raw = await SecureStore.getItemAsync(KEY)
      const list: unknown = raw ? JSON.parse(raw) : []
      cached = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      cached = new Set()
    }
  },

  has(base: string): boolean {
    return cached.has(base)
  },

  async add(base: string): Promise<void> {
    cached.add(base)
    await persist()
  },

  async remove(base: string): Promise<void> {
    if (!cached.delete(base)) return
    await persist()
  },
}

import * as SecureStore from 'expo-secure-store'

/**
 * access token 的存放处。
 *
 * 🔴 **必须是 `expo-secure-store`，不能是 `AsyncStorage`。**
 * AsyncStorage 在 Android 上就是一个明文 SQLite 文件、iOS 上是明文 plist ——
 * root / 越狱设备上直接可读，备份也会带走。SecureStore 走的是 Android Keystore /
 * iOS Keychain。这条和 web 端不一样：web 上 token 在 `sessionStorage`，
 * 关掉标签页就没了；移动端 App 会长期驻留，落盘的东西必须当长期资产看待。
 *
 * ⚠️ **refresh token 不在这里** —— 它在 httpOnly cookie 里，由 RN 自带的
 * cookie jar 管（实测确认：`POST /auth/refresh` 不带任何头就能刷成功，
 * 见 AGENTS.md 的实测 2）。**不要照搬 `apps/desktop/src/main/auth.ts` 那套
 * 「自己读 Set-Cookie 再手工带 Cookie 头」** —— 在 RN 上那是多余的一份状态，
 * 两份状态不同步的失败是静默的（刷新成功但用的是旧 token）。
 */
const KEY = 'admin.access_token'

/**
 * 内存里再存一份。
 *
 * SecureStore 的读是**异步**的，而每个请求都要拿一次 token —— 每次都 await
 * 一趟 Keystore 会把请求延迟拉高，而且更麻烦的是它让「有没有登录」这件事
 * 变成异步的，UI 会闪一下未登录态。所以：启动时读一次进内存，之后以内存为准，
 * 写的时候两边一起写。
 */
let cached: string | null = null

export const tokenStore = {
  /** 冷启动时调用一次，把落盘的 token 读回内存 */
  async hydrate(): Promise<string | null> {
    try {
      cached = await SecureStore.getItemAsync(KEY)
    } catch {
      // Keystore 偶发不可用（换锁屏密码、恢复备份）时读不出来 —— 当作没登录，
      // 而不是让整个 App 起不来
      cached = null
    }
    return cached
  },

  get(): string | null {
    return cached
  },

  async set(token: string): Promise<void> {
    cached = token
    try {
      await SecureStore.setItemAsync(KEY, token)
    } catch {
      // 落盘失败不影响本次会话，只是下次冷启动要重新登录
    }
  },

  async clear(): Promise<void> {
    cached = null
    try {
      await SecureStore.deleteItemAsync(KEY)
    } catch {
      // 同上
    }
  },
}

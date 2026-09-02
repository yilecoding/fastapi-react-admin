import * as SecureStore from 'expo-secure-store'

/**
 * 记住的用户名 —— 对齐 web 端登录页那个「记住账号」勾选框
 * （web 用 `localStorage`，key 也叫这个）。
 *
 * ⚠️ 只存**用户名**，不存密码。这里用 SecureStore 不是因为用户名敏感，
 * 而是因为这个工程本来就没装 AsyncStorage —— 为一个短字符串再拖一个存储层不值得。
 */
const KEY = 'admin:remember-username'

export const remembered = {
  async get(): Promise<string> {
    try {
      return (await SecureStore.getItemAsync(KEY)) ?? ''
    } catch {
      return ''
    }
  },
  async set(username: string | null): Promise<void> {
    try {
      if (username) await SecureStore.setItemAsync(KEY, username)
      else await SecureStore.deleteItemAsync(KEY)
    } catch {
      // 存不下不影响登录，只是下次要重新敲一遍账号
    }
  },
}

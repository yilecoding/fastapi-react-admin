import * as SecureStore from 'expo-secure-store'

/**
 * 记住的用户名 —— 对齐 web 端登录页那个「记住账号」勾选框
 * （web 用 `localStorage`，key 也叫这个）。
 *
 * ⚠️ 只存**用户名**，不存密码。这里用 SecureStore 不是因为用户名敏感，
 * 而是因为这个工程本来就没装 AsyncStorage —— 为一个短字符串再拖一个存储层不值得。
 */
/**
 * 🔴 **key 里不能有冒号。** expo-secure-store 的校验是
 * `isValidKey = /^[\w.-]+$/`，而 `getItemAsync` / `setItemAsync` /
 * `deleteItemAsync` 三个都先跑 `ensureValidKey` —— 冒号让它们**全部 throw**。
 *
 * 而这个文件里三处都包在静默的 `catch {}` 里（那是为「Keystore 偶发不可用」
 * 设计的），所以原来的 `'admin:remember-username'` 表现为：
 * 「记住账号」永远存不进去，而 `get()` 返回 `''` 又让登录页那个 effect
 * 执行 `setRemember('' !== '')` —— 勾选框**每次启动都自己取消**，
 * 尽管初值写的是 `useState(true)`。
 *
 * 本项目其余几个 key（`admin.access_token` / `admin.api_base` /
 * `admin.language` / `admin.appearance`）都用点，只有这个当初抄了 web 端
 * `localStorage` 的冒号风格。
 */
const KEY = 'admin.remember-username'

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

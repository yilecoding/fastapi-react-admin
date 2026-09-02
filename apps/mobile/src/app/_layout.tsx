import '@/styles/global.css'

import { JetBrainsMono_400Regular, JetBrainsMono_500Medium, useFonts } from '@expo-google-fonts/jetbrains-mono'
import { PortalHost } from '@rn-primitives/portal'
import { Stack } from 'expo-router'
import { ThemeProvider } from 'expo-router/react-navigation'
import { StatusBar } from 'expo-status-bar'
import * as React from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useUniwind } from 'uniwind'

import { appearanceStore } from '@/lib/appearance'
import { setupI18n } from '@/lib/i18n'
import { NAV_THEME } from '@/lib/theme'
import { SessionProvider, useSession } from '@/lib/session'

export {
  // 让 expo-router 接住 layout 抛出的错误 —— 否则是白屏（根 CLAUDE.md 硬纪律 9）
  ErrorBoundary,
} from 'expo-router'

export default function RootLayout() {
  const { theme } = useUniwind()
  // 🔴 等宽字**没载完之前不要渲染**。RN 里 fontFamily 指向一个还没注册的字族
  // 是**静默回落到系统字体**的（不报错），于是首帧那些眉标会先是系统 mono、
  // 再跳成 JetBrains Mono —— 一次很明显的抖动。
  const [fontsReady] = useFonts({ JetBrainsMono_400Regular, JetBrainsMono_500Medium })

  // ⚠️ uniwind 自己不持久化主题：`setTheme()` 只改当前会话，重启就回到跟随系统。
  // 所以偏好要自己存、冷启动喂回去（`src/lib/appearance.ts`）
  React.useEffect(() => {
    void appearanceStore.hydrate()
  }, [])

  // 🔴 i18n 必须在渲染任何用到 `t()` 的东西**之前**跑完，所以和字体一样卡住首帧。
  // 语言偏好存在 SecureStore 里、读是异步的，拿不到同步初值。
  const [i18nReady, setI18nReady] = React.useState(false)
  React.useEffect(() => {
    void setupI18n().then(() => setI18nReady(true))
  }, [])

  if (!fontsReady || !i18nReady) return null

  return (
    <ThemeProvider value={NAV_THEME[theme ?? 'light']}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <SessionProvider>
        <AuthGate />
      </SessionProvider>
      <PortalHost />
    </ThemeProvider>
  )
}

/**
 * 认证闸门。
 *
 * 🔴 **用「渲染哪一棵树」而不是「跳转」来切换登录态。**
 * 常见写法是在 effect 里 `router.replace('/login')` —— 那样会有一帧渲染出
 * 已登录的界面（用户信息还是 null，于是各处崩或闪），而且返回键能退回去。
 * 这里两棵树互斥挂载，未登录时**登录屏之外的路由根本不存在**，
 * 没有中间态可漏。
 *
 * 代价是 `(app)` 那棵树里的屏在登出瞬间会整棵卸载 —— 这正是我们要的。
 */
function AuthGate() {
  const { status } = useSession()

  if (status === 'loading') {
    return (
      <View className="bg-background flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'authed'}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'anonymous'}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  )
}

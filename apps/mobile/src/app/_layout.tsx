import '@/styles/global.css'

import { PortalHost } from '@rn-primitives/portal'
import { Stack } from 'expo-router'
import { ThemeProvider } from 'expo-router/react-navigation'
import { StatusBar } from 'expo-status-bar'
import { ActivityIndicator, View } from 'react-native'
import { useUniwind } from 'uniwind'

import { NAV_THEME } from '@/lib/theme'
import { SessionProvider, useSession } from '@/lib/session'

export {
  // 让 expo-router 接住 layout 抛出的错误 —— 否则是白屏（根 CLAUDE.md 硬纪律 9）
  ErrorBoundary,
} from 'expo-router'

export default function RootLayout() {
  const { theme } = useUniwind()

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

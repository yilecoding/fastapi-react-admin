import '@/styles/global.css'

import { JetBrainsMono_400Regular, JetBrainsMono_500Medium, useFonts } from '@expo-google-fonts/jetbrains-mono'
import { PortalHost } from '@rn-primitives/portal'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { ThemeProvider } from 'expo-router/react-navigation'
import { StatusBar } from 'expo-status-bar'
import * as React from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useUniwind } from 'uniwind'

import { appearanceStore } from '@/lib/appearance'
import { setupI18n } from '@/lib/i18n'
import { Toaster } from '@/components/ui/toast'
import { QueryProvider } from '@/lib/query'
import { useNavTheme } from '@/lib/theme'
import { SessionProvider, useSession } from '@/lib/session'

export {
  // 让 expo-router 接住 layout 抛出的错误 —— 否则是白屏（根 CLAUDE.md 硬纪律 9）
  ErrorBoundary,
} from 'expo-router'

/*
 * 🔴 **把原生 splash 压住，否则首帧是一段白屏。**
 *
 * 下面那句 `if (!ready) return null` 是必须的（字族没注册就用会静默回落
 * 系统字体、i18n 没好 `t()` 会原样返回 key）。但原生 splash
 * **默认在 JS bundle 一加载完就自己隐藏**，于是那段等待期露出来的是
 * `return null` 的空视图 —— 冷启动看到的是「紫色图标闪一下 → 白屏一会儿 →
 * 界面」。`expo-splash-screen` 这个依赖一直装着、`app.json` 里也配了插件，
 * 但**从来没有人 import 它**，所以那两行 API 从没被调用过。
 *
 * ⚠️ 必须在模块作用域调用（组件第一次渲染之前就要生效），
 * 并且 `catch` 掉 —— 它在 splash 已经隐藏时会 reject，那不是错误。
 */
void SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const { theme } = useUniwind()
  const navTheme = useNavTheme()
  // 🔴 等宽字**没载完之前不要渲染**。RN 里 fontFamily 指向一个还没注册的字族
  // 是**静默回落到系统字体**的（不报错），于是首帧那些眉标会先是系统 mono、
  // 再跳成 JetBrains Mono —— 一次很明显的抖动。
  //
  // ⚠️ 但**载失败也要放行**（`fontError`）。压住 splash 之后，「永远不 ready」
  // 从「白屏」升级成了「启动画面永远不结束」—— 那看起来是卡死，连错都看不到。
  // 字体回落成系统字只是丑一点。
  const [fontsReady, fontError] = useFonts({ JetBrainsMono_400Regular, JetBrainsMono_500Medium })

  // ⚠️ uniwind 自己不持久化主题：`setTheme()` 只改当前会话，重启就回到跟随系统。
  // 所以偏好要自己存、冷启动喂回去（`src/lib/appearance.ts`）
  React.useEffect(() => {
    void appearanceStore.hydrate()
  }, [])

  // 🔴 i18n 必须在渲染任何用到 `t()` 的东西**之前**跑完，所以和字体一样卡住首帧。
  // 语言偏好存在 SecureStore 里、读是异步的，拿不到同步初值。
  const [i18nReady, setI18nReady] = React.useState(false)
  React.useEffect(() => {
    // 同上：起不来也放行。`t()` 会原样返回 key，而这个项目的 key 就是中文原文，
    // 所以界面是可用的（只是切不了英文）。**不要在这里 return 一个永久等待。**
    void setupI18n()
      .catch(() => {})
      .finally(() => setI18nReady(true))
  }, [])

  const ready = (fontsReady || fontError !== null) && i18nReady

  // 就绪之后才放开 splash。放在 effect 里而不是渲染中途 ——
  // 隐藏是个副作用，渲染期调用会在 StrictMode 下跑两遍
  React.useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {})
  }, [ready])

  if (!ready) return null

  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      {/* 🔴 QueryProvider 要在 SessionProvider **外面**：`useUnread()` 之类的
          查询按 `useSession()` 的状态 `enabled`，所以 session 是它的输入；
          反过来套的话 session 里的东西读不到 QueryClient */}
      <QueryProvider>
        <SessionProvider>
          <AuthGate />
        </SessionProvider>
      </QueryProvider>
      <PortalHost />
      {/* 🔴 `Toaster` 走 `<Portal>`，所以要在 `PortalHost` **之后**挂 ——
          它渲染进那个容器，天然盖在所有屏之上。只能挂一个，挂两个每条 toast 会显示两遍 */}
      <Toaster />
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

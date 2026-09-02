import { Stack } from 'expo-router'
import { StyleSheet } from 'react-native'
import { useCSSVariable } from 'uniwind'

import { UnreadProvider } from '@/lib/notifications'

/**
 * 已登录那棵树的**外层 Stack**。
 *
 * 🔴 **tabs 必须套在一层 Stack 里，不能让 `(app)` 直接是 Tabs。**
 * 否则「通知」「编辑资料」这种不该占 tab 位的屏没地方放 ——
 * `(app)/` 下每多一个文件就自动多一个 tab。用 `href: null` 藏得掉，
 * 但那样它仍在 tab 导航器内，**没有返回键、标题也要自己接**。
 *
 * 现在的形状：Stack 里第一屏是 `(tabs)`（自己不出 header），
 * 其余屏推在 tab 之上，天然带返回键、盖住 tab 栏 —— 这是移动端的常规做法。
 */
export default function AppLayout() {
  const node = useCSSVariable('--color-node')
  const line = useCSSVariable('--color-line')
  const ink = useCSSVariable('--color-ink')
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

  return (
    <UnreadProvider>
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: 'minimal',
          // 导航头和 tab 栏用同一块 node 色，底边是发丝线 —— 全 App 只有这一种「面」
          headerStyle: { backgroundColor: str(node) },
          headerTintColor: str(ink),
          headerTitleStyle: { fontSize: 16, fontWeight: '600', color: str(ink) },
          headerShadowVisible: false,
          contentStyle: { borderTopColor: str(line), borderTopWidth: StyleSheet.hairlineWidth },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="notifications" options={{ title: '通知' }} />
        <Stack.Screen name="profile/edit" options={{ title: '编辑资料' }} />
        <Stack.Screen name="profile/password" options={{ title: '修改密码' }} />
      </Stack>
    </UnreadProvider>
  )
}

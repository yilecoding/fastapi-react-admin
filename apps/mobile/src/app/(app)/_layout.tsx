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
  const card = useCSSVariable('--color-card')
  const line = useCSSVariable('--color-border')
  const fg = useCSSVariable('--color-foreground')
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

  return (
    <UnreadProvider>
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: 'minimal',
          // 导航头和 tab 栏用卡片色 + 发丝底边，和内容区的 background 区分开
          headerStyle: { backgroundColor: str(card) },
          headerTintColor: str(fg),
          headerTitleStyle: { fontSize: 16, fontWeight: '600', color: str(fg) },
          headerShadowVisible: false,
          contentStyle: { borderTopColor: str(line), borderTopWidth: StyleSheet.hairlineWidth },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="notifications" options={{ title: '通知' }} />
        <Stack.Screen name="settings" options={{ title: '设置' }} />
        <Stack.Screen name="server" options={{ title: '服务器地址' }} />
        <Stack.Screen name="timezone" options={{ title: '显示时区' }} />
        <Stack.Screen name="profile/edit" options={{ title: '编辑资料' }} />
        <Stack.Screen name="profile/password" options={{ title: '修改密码' }} />
      </Stack>
    </UnreadProvider>
  )
}

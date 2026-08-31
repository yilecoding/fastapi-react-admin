import '@/styles/global.css'

import { PortalHost } from '@rn-primitives/portal'
import { Stack } from 'expo-router'
import { ThemeProvider } from 'expo-router/react-navigation'
import { StatusBar } from 'expo-status-bar'
import { useUniwind } from 'uniwind'

import { NAV_THEME } from '@/lib/theme'

export {
  // 让 expo-router 接住 layout 抛出的错误 —— 否则是白屏（根 CLAUDE.md 硬纪律 9）
  ErrorBoundary,
} from 'expo-router'

export default function RootLayout() {
  const { theme } = useUniwind()

  return (
    <ThemeProvider value={NAV_THEME[theme ?? 'light']}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <Stack />
      <PortalHost />
    </ThemeProvider>
  )
}

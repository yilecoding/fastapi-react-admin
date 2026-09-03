import { LinearGradient } from 'expo-linear-gradient'
import * as React from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCSSVariable } from 'uniwind'

import { TenonMark } from '@/components/tenon-mark'
import { Text } from '@/components/ui/text'
import { BRAND } from '@/lib/brand'

/**
 * 品牌头 —— 顶部一块淡紫渐变，收着榫卯标记 + wordmark，下面接屏内容。
 *
 * 这是选定风格（iOS 分组 · V2「品牌头」）里唯一的品牌表达：**不铺满、不饱和**，
 * 只是把页面顶端往品牌色偏一点点，让人看出「这是我们的产品」而不是系统设置。
 *
 * 🔴 渐变的落点必须是**页面底色本身**（`--color-background`），不是白色 ——
 * 不然渐变结束处会有一道可见的接缝。所以两个色标都从令牌取。
 *
 * ⚠️ 深色下不加紫（`from` 直接给页面底色）：iOS 深色分组的页面是纯黑，
 * 在纯黑上叠一层紫会显脏，而且分组块本身已经把层级说清楚了。
 */
export function BrandTop({ children }: { children?: React.ReactNode }) {
  const insets = useSafeAreaInsets()
  const bgVar = useCSSVariable('--color-background')
  const bg = typeof bgVar === 'string' ? bgVar : '#f4f2fa'
  const fgVar = useCSSVariable('--color-foreground')
  const fg = typeof fgVar === 'string' ? fgVar : '#171523'
  const primaryVar = useCSSVariable('--color-primary')
  const primary = typeof primaryVar === 'string' ? primaryVar : '#4630db'

  // 纯黑页面（深色）就不叠紫了，见上面那条
  const dark = bg.toLowerCase() === '#000000' || bg.toLowerCase() === '#000'
  const from = dark ? bg : '#e9e3ff'

  return (
    <LinearGradient
      colors={[from, bg]}
      style={{ paddingTop: insets.top + 6, paddingBottom: 14, paddingHorizontal: 20, gap: 12 }}
    >
      <View className="flex-row items-center gap-2">
        <TenonMark size={16} color={dark ? fg : primary} />
        <Text className="text-muted-foreground font-mono text-[10.5px]">{BRAND.wordmark}</Text>
      </View>
      {children}
    </LinearGradient>
  )
}

import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Card } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { cn } from '@/lib/utils'

/**
 * iOS **分组列表**的几个薄封装。
 *
 * ⚠️ 这不是另起一套设计系统 —— 里面全是 `react-native-reusables` 的原语
 * （`Card` / `Text` / `Icon`）+ 令牌类名。分组列表不在 rnr 的组件清单里，
 * 但它是移动端最成熟的一套实用界面语言，值得封这一层。
 *
 * 🔴 **不要再往这里加视觉发明。** 之前自创过「导轨/刻度/销钉」那一套，
 * 结果是组件库全用不上、每屏手写样式。这里只做「iOS 已有的形状」。
 */

/** 分组抬头。iOS 上是小号灰字，贴在分组块上方左侧 */
export function GroupHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Text className={cn('text-muted-foreground px-5 pt-4 pb-2 text-xs', className)}>{children}</Text>
  )
}

/** 一个分组块：白底、大圆角、左右留边。行之间的分隔线由 `Row` 自己画 */
export function Group({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Card className={cn('mx-4 gap-0 rounded-xl border-0 py-0 shadow-none', className)}>{children}</Card>
  )
}

/**
 * 分组块里的一行。
 *
 * 🔴 **分隔线画在「非首行」的顶部，而且左边内缩到内容起点。**
 * RN 没有 `:last-child`，所以 `first` 要显式传；通栏的分隔线会把分组块
 * 切成一格一格 —— 内缩之后它才读作「同一块里的下一行」。iOS 上内缩量
 * 等于左内边距（有图标时还要再加上图标宽 + 间距）。
 */
export function Row({
  first,
  inset = 20,
  className,
  children,
}: {
  first?: boolean
  /** 分隔线左边内缩多少。有图标的行传 `56` */
  inset?: number
  className?: string
  children: React.ReactNode
}) {
  return (
    <>
      {first ? null : <View className="bg-border h-px" style={{ marginLeft: inset }} />}
      <View className={cn('min-h-[46px] flex-row items-center gap-3 px-5 py-2.5', className)}>{children}</View>
    </>
  )
}

/** 可点的一行。iOS 上右侧是一枚很淡的 chevron */
export function PressRow({
  first,
  inset,
  onPress,
  children,
  testID,
}: {
  first?: boolean
  inset?: number
  onPress?: () => void
  children: React.ReactNode
  testID?: string
}) {
  return (
    <>
      {first ? null : <View className="bg-border h-px" style={{ marginLeft: inset ?? 20 }} />}
      <Pressable
        onPress={onPress}
        testID={testID}
        className="active:bg-muted min-h-[46px] flex-row items-center gap-3 px-5 py-2.5"
      >
        {children}
      </Pressable>
    </>
  )
}

/** 行末的 chevron。单独抽出来是为了让所有行的这一枚长得一样 */
export function Chevron({ icon }: { icon: React.ComponentProps<typeof Icon>['as'] }) {
  return <Icon as={icon} className="text-muted-foreground size-4 opacity-40" />
}

/**
 * 行左侧的图标。**永远单色**，没有「高亮」这个口子。
 *
 * 🔴 定稿那版（V2）的规则是「单色图标 + 主色的**值**」。实现时给铃铛按未读数
 * 染了主色，结果一排灰图标里蹦出一个紫的，很突兀 —— 用户当场指出来了。
 * 状态要表达就表达在**值**上（`1 条未读` 走主色），不要动图标。
 */
export function RowIcon({ icon }: { icon: React.ComponentProps<typeof Icon>['as'] }) {
  return <Icon as={icon} className="text-muted-foreground size-[19px]" />
}

/**
 * iOS 的「破坏性动作」行：**居中的红字，没有图标**。
 *
 * 🔴 加过一版带图标的，图标和文字两块红还不同调，一眼就怪。
 * iOS 上退出登录/删除账号从来只有一行居中红字。
 */
export function DangerRow({
  label,
  onPress,
  testID,
}: {
  label: string
  onPress: () => void
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className="active:bg-muted min-h-[46px] items-center justify-center px-5"
    >
      <Text className="text-destructive text-[15px]">{label}</Text>
    </Pressable>
  )
}

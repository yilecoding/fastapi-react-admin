import { SearchIcon } from 'lucide-react-native'
import * as React from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'

import { Card } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
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
 * **要翻页的列表**（`FlatList`）里的一行，拼起来读作一个分组块。
 *
 * 🔴 `Group` 包不住虚拟化列表（见分册「`Group` 和虚拟化列表冲突」），原来的退路是
 * 「每条一张独立卡片 + 间距」，一屏只放得下七八条，读起来像一叠名片。
 * 这里换成 iOS 自己的做法：**每行自己画形状** —— 首行圆上角、末行圆下角、
 * 非首行顶部画内缩分隔线。圆角跟着行走，滚动时不会闪。
 *
 * `count` 传列表当前长度：翻页之后原来的末行不再是末行，下角会跟着变直。
 */
export function ListItem({
  index,
  count,
  inset = 16,
  onPress,
  testID,
  className,
  children,
}: {
  index: number
  count: number
  /** 分隔线左边内缩多少。行首有头像时传「左内边距 + 头像宽 + 间距」 */
  inset?: number
  onPress?: () => void
  testID?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className={cn(
        'bg-card active:bg-muted overflow-hidden',
        index === 0 && 'rounded-t-xl',
        index === count - 1 && 'rounded-b-xl',
      )}
      /*
       * 🔴 非首行往上叠 1dp。行高是小数（字的行高 × 屏幕密度），逐行取整时偶尔会在两行之间
       * 漏出 1 个物理像素的页面底色，读起来像一条通栏的分隔线（实测：用户列表第 5、6 行之间，
       * 像素取样确认是底色 #F4F2FA，不是 border 色）。叠上去之后缝被上一行的白底盖住
       */
      style={index === 0 ? undefined : { marginTop: -1 }}
    >
      {index === 0 ? null : <View className="bg-border h-px" style={{ marginLeft: inset }} />}
      <View className={cn('min-h-[46px] flex-row items-center gap-3 px-4 py-3', className)}>{children}</View>
    </Pressable>
  )
}

/**
 * 搜索框：填充底、图标在框里、没有描边和阴影（iOS 的搜索栏形状）。
 *
 * ⚠️ 图标和输入框是**同一行的兄弟**，不是「绝对定位叠在输入框上」——
 * 原来那版图标 `absolute` 在一个没有高度约束的容器里，实测落到了输入框**上方**。
 */
export function SearchField({
  className,
  ...props
}: React.ComponentProps<typeof Input> & { className?: string }) {
  return (
    <View className={cn('bg-card h-10 flex-row items-center gap-2 rounded-[10px] px-3', className)}>
      <Icon as={SearchIcon} className="text-muted-foreground size-4" />
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        {...props}
        className="h-auto flex-1 border-0 bg-transparent px-0 py-0 text-[15px] shadow-none dark:bg-transparent"
      />
    </View>
  )
}

/**
 * 导航栏右上角的文字按钮（「发起」「编辑」）。主色、中等字重，按下变淡 ——
 * 所有屏的右上角动作长一个样子
 */
export function HeaderAction({
  label,
  onPress,
  disabled,
  loading,
  testID,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  /** 进行中：文字换成转圈，同时不可点（防连点） */
  loading?: boolean
  testID?: string
}) {
  const off = disabled || loading
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: loading }}
      testID={testID}
      className={cn('min-w-8 items-center px-1 active:opacity-50', disabled && 'opacity-40')}
    >
      {loading ? <ActivityIndicator size="small" /> : <Text className="text-primary text-[16px] font-medium">{label}</Text>}
    </Pressable>
  )
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

import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui/text'
import { cn } from '@/lib/utils'

/**
 * 一块卡片。移动端没有 hover / 边框那么细的层次手段，所以层次全靠
 * **底色 + 圆角 + 一点阴影**，而不是描边 —— 满屏细边框在小屏上会显得很脏。
 */
function Card({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <View
      className={cn('bg-card border-border overflow-hidden rounded-xl border', className)}
      {...props}
    />
  )
}

/** 卡片上方那行小标题。用 `tracking-wide` + 全大写感的字重把它压成「分区标签」 */
function CardLabel({ children }: { children: React.ReactNode }) {
  return <Text className="text-muted-foreground px-1 pb-2 text-xs font-medium">{children}</Text>
}

/**
 * 卡片内部的一行。
 *
 * ⚠️ 分隔线只画在**非首行**上（`border-t`），不要用 `border-b` + 最后一行去掉 ——
 * RN 里没有 `:last-child`，那种写法必须把 index 传进来，而 `border-t` + `first` 判断
 * 是同一件事的更简单形态。
 */
function CardRow({
  first,
  className,
  ...props
}: React.ComponentProps<typeof View> & { first?: boolean }) {
  return (
    <View
      className={cn('flex-row items-center gap-3 px-4 py-3.5', !first && 'border-border border-t', className)}
      {...props}
    />
  )
}

export { Card, CardLabel, CardRow }

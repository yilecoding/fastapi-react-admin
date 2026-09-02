import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui/text'
import { cn } from '@/lib/utils'

/**
 * 这套 UI 的结构件只有三个：面板、发丝横线、等宽眉标。
 * 都抄自 web 端登录页左栏那块 `.tenon-panel`（`-sign-in-brand.tsx`）。
 *
 * 🔴 **不要再往里加装饰**（阴影、渐变、大色块）。那块面板"好看"靠的是
 * 表面层级 + 一条线 + 一行小字，多一样就散了。主色只出现在**细笔画**上。
 */

/** 比页面低一档的一块面。用极细的内描边而不是 1px 实线边框 —— 后者在小屏上太重 */
export function Panel({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <View
      className={cn('bg-panel border-hair overflow-hidden rounded-2xl border', className)}
      {...props}
    />
  )
}

/** 发丝横线。**这是分隔的唯一手段** —— 不要用卡片间距或背景色去暗示分隔 */
export function Rule({ className }: { className?: string }) {
  return <View className={cn('bg-line h-px w-full', className)} />
}

/**
 * 眉标：等宽、大字距、主色。
 *
 * ⚠️ `tracking` 在 RN 里是 `letterSpacing`（绝对值 px），不是 em。
 * web 那边写的是 `tracking-[0.32em]`，10px 字号折算过来约 3.2px。
 */
export function Eyebrow({
  children,
  tone = 'accent',
  className,
}: {
  children: React.ReactNode
  tone?: 'accent' | 'faint'
  className?: string
}) {
  return (
    <Text
      className={cn(
        'font-mono text-[10px]',
        tone === 'accent' ? 'text-accent' : 'text-faint',
        className,
      )}
      style={{ letterSpacing: 3.2 }}
    >
      {children}
    </Text>
  )
}

/**
 * 一节的抬头：眉标 + 发丝横线。
 * 这是全 App 唯一的分区方式 —— 保持一致比每屏各想一个更重要。
 */
export function SectionHead({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <View className="gap-2.5">
      <View className="flex-row items-center justify-between">
        <Eyebrow>{label}</Eyebrow>
        {right}
      </View>
      <Rule />
    </View>
  )
}

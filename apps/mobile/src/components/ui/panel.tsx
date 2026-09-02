import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui/text'
import { cn } from '@/lib/utils'

/**
 * 这一套只有三件东西：**浅底的页 · 白色的卡 · 卡内内缩的发丝线**。
 *
 * 🔴 **返工记录，别再走回去：**
 * 第一版把 web 登录页那块 `.tenon-panel` 整屏铺开 —— 通栏发丝线 + 全屏辉光，
 * 结果是「一张电子表格 + 一块脏污」。web 那块面板好看是因为它是**有边界的卡**，
 * 边缘、圆角、内部纹理三者互相定义；全屏铺开就什么都不剩了。
 * 纹理只能出现在**卡的内部**（见 `brand-backdrop.tsx` 的用法）。
 *
 * 🔴 **主色只给交互和状态**（未读点、选中下划线、勾选框），
 * 静态标签一律用 `faint`。第一版把分区眉标做成主色紫，全屏最艳的东西是俩标签。
 */

/** 一块白卡。页是浅底，卡是白的 —— 层级全靠这一层，不靠阴影 */
export function Card({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <View
      className={cn('bg-node border-hair overflow-hidden rounded-2xl border', className)}
      {...props}
    />
  )
}

/**
 * 卡内分隔线。
 *
 * ⚠️ **左边要内缩到内容的左边界**（`ml-4`），不能通栏。通栏的线把卡片切成
 * 一格一格，正是「电子表格感」的来源；内缩之后它才读作「同一张卡里的下一行」。
 */
export function Divider({ inset = true }: { inset?: boolean }) {
  return <View className={cn('bg-line h-px', inset && 'ml-4')} />
}

/** 分区抬头：等宽小字。**默认 faint** —— 想强调请先问一句这值不值一个主色 */
export function Eyebrow({
  children,
  tone = 'faint',
  className,
}: {
  children: React.ReactNode
  tone?: 'accent' | 'faint'
  className?: string
}) {
  return (
    <Text
      className={cn('font-mono text-[11px]', tone === 'accent' ? 'text-accent' : 'text-faint', className)}
      style={{ letterSpacing: 1.6 }}
    >
      {children}
    </Text>
  )
}

/** 一节：抬头 + 一张卡。全 App 唯一的分区方式 */
export function Section({
  label,
  right,
  children,
  className,
}: {
  label?: string
  right?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <View className={cn('gap-2.5', className)}>
      {label ? (
        <View className="flex-row items-center justify-between px-1">
          <Eyebrow>{label}</Eyebrow>
          {right}
        </View>
      ) : null}
      <Card>{children}</Card>
    </View>
  )
}

/**
 * 卡内的一行。高度 52，左右 16。
 * `last` 决定要不要画下面那条线 —— RN 没有 `:last-child`，只能显式传。
 */
export function Row({
  last,
  className,
  ...props
}: React.ComponentProps<typeof View> & { last?: boolean }) {
  return (
    <>
      <View className={cn('min-h-[52px] flex-row items-center gap-3 px-4 py-3', className)} {...props} />
      {last ? null : <Divider />}
    </>
  )
}

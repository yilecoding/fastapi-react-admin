import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '@/components/ui/text'
import { cn } from '@/lib/utils'

/**
 * 导轨 —— 这套 UI 的**唯一**结构件，也是它的签名。
 *
 * 一条竖着的发丝线贯穿整段内容，每一项用一枚横向刻度挂上去；分区抬头用一枚
 * 主色销钉钉在导轨上。图形直接来自 web 登录页那张权限链示意
 * （`apps/web/src/routes/_guest/-sign-in-brand.tsx` 的 `AuthChain`）：
 * 那里的 rail、刻度、分岔销钉是同一套东西。
 *
 * 🔴 **不要退回「白卡片 + 通栏分隔线」。** 那一版返工过：读起来是一套标准
 * 设置列表，看不出任何设计意图。层级不靠面和阴影，靠**这一条线**。
 *
 * 🔴 **主色只出现在销钉和「活」的状态上**（未读、选中、脉冲）。
 * 静态标签一律 `faint`；曾经把分区眉标做成主色，全屏最艳的东西成了俩标签。
 */

/** 导轨左边距（内容相对导轨的缩进）。刻度就画在这段里 */
const INSET = 15

/** 一段挂在同一条导轨上的内容 */
export function Rail({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <View className={cn('border-line border-l', className)} style={{ paddingLeft: INSET }}>
      {children}
    </View>
  )
}

/** 刻度：把一行钉在导轨上的那一横。绝对定位到行的垂直中线上 */
function Tick({ live }: { live?: boolean }) {
  return (
    <View
      pointerEvents="none"
      className={live ? 'bg-accent' : 'bg-line'}
      style={{ position: 'absolute', left: -INSET, top: '50%', width: 9, height: 1 }}
    />
  )
}

/**
 * 分区抬头。销钉压在导轨上 —— 它标记的是「这里换了一段」，
 * 是全 App 唯一让主色出现在静态元素上的地方，因为它承担结构意义。
 */
export function RailSection({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <View className="flex-row items-center justify-between pt-7 pb-3">
      {/* 销钉：5×5 的实心方块，居中压在导轨上（左移半个身位 + 半个线宽） */}
      <View
        pointerEvents="none"
        className="bg-accent"
        style={{ position: 'absolute', left: -INSET - 2, top: 30, width: 5, height: 5, borderRadius: 1 }}
      />
      <Text className="text-faint font-mono text-[10px]" style={{ letterSpacing: 3 }}>
        {label}
      </Text>
      {right}
    </View>
  )
}

/**
 * 一行「标注」：左标签、右值。值用等宽承载 —— 它们是数据（ID、计数、时区、时间），
 * 等宽在这里不是装饰，是让它们能按位对齐。
 */
export function RailRow({
  label,
  value,
  note,
  live,
  plain,
}: {
  label: string
  value?: string | null
  note?: string
  /** 刻度点亮成主色。给「有状态」的行用，不要用来强调 */
  live?: boolean
  /** 值不是数据而是散文（部门名、角色名），用正文字体 */
  plain?: boolean
}) {
  return (
    <View className="border-line min-h-[46px] flex-row items-center gap-4 border-b py-2.5">
      <Tick live={live} />
      <Text className="text-faint shrink-0 text-[14px]">{label}</Text>
      <View className="flex-1 items-end">
        <Text
          className={cn(
            'text-right',
            plain ? 'text-ink text-[15px]' : 'text-ink font-mono text-[13px]',
            live && 'text-accent',
          )}
          numberOfLines={2}
        >
          {value?.trim() ? value : '—'}
        </Text>
        {note ? <Text className="text-faint mt-0.5 text-right text-[11px]">{note}</Text> : null}
      </View>
    </View>
  )
}

/** 一行可点的动作。右侧是等宽的动作提示，不用 chevron —— 图纸上没有那种箭头 */
export function RailAction({
  label,
  hint,
  onPress,
  danger,
  live,
  testID,
}: {
  label: string
  hint?: string
  onPress: () => void
  danger?: boolean
  live?: boolean
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className="active:bg-node border-line min-h-[46px] flex-row items-center gap-3 border-b py-2.5"
    >
      <Tick live={live || danger} />
      <Text className={cn('flex-1 text-[15px]', danger ? 'text-destructive' : 'text-ink')}>{label}</Text>
      {hint ? <Text className="text-faint font-mono text-[11px]">{hint}</Text> : null}
      <Text className={cn('font-mono text-[13px]', danger ? 'text-destructive' : 'text-faint')}>→</Text>
    </Pressable>
  )
}

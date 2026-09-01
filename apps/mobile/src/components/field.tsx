import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui/text'

/** 表单里的一格：标签 + 控件 + 可选的说明/错误 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-foreground text-sm font-medium">{label}</Text>
      {children}
      {hint ? <Text className="text-muted-foreground text-xs">{hint}</Text> : null}
    </View>
  )
}

/** 只读的一行：左标签右值。个人中心那种「看」的场合用它，不要用禁用的输入框冒充 */
export function ReadonlyRow({ label, value, hint }: { label: string; value?: string | null; hint?: string }) {
  return (
    <View className="border-border flex-row items-start justify-between gap-4 border-b py-3">
      <Text className="text-muted-foreground shrink-0 text-sm">{label}</Text>
      <View className="flex-1 items-end gap-0.5">
        <Text className="text-foreground text-right text-sm">{value?.trim() ? value : '—'}</Text>
        {hint ? <Text className="text-muted-foreground text-right text-xs">{hint}</Text> : null}
      </View>
    </View>
  )
}

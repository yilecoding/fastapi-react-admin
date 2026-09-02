import type { LucideIcon } from 'lucide-react-native'
import { View } from 'react-native'

import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'

/**
 * 「这里还没有内容」的统一形态。
 *
 * 🔴 **占位屏要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」。**
 * 三者在用户眼里都是一片空 —— 分不清的话，第一反应是「这 App 坏了」。
 * 根 `CLAUDE.md` 硬纪律 9 是同一个道理：缺失状态必须是**可辨认的**状态。
 */
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <View className="items-center gap-3 px-8 py-12">
      <View className="bg-muted h-14 w-14 items-center justify-center rounded-full">
        <Icon as={icon} className="text-muted-foreground size-6" />
      </View>
      <Text className="text-foreground text-base font-medium">{title}</Text>
      <Text className="text-muted-foreground text-center text-sm leading-6">{description}</Text>
    </View>
  )
}

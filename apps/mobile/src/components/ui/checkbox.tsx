import { CheckIcon } from 'lucide-react-native'
import { Pressable, View } from 'react-native'

import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'

/**
 * 勾选框 + 标签。RN 没有原生复选框，自己拼一个。
 *
 * ⚠️ **可点区域是整行**（含文字），不只是那个小方块 —— 16px 的方块在触屏上
 * 远低于可用的点击尺寸，这是移动端最常见的落差之一（issue #39 第 2.5 节）。
 */
export function Checkbox({
  checked,
  onChange,
  label,
  testID,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  testID?: string
}) {
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      testID={testID}
      hitSlop={8}
      className="flex-row items-center gap-2.5 self-start py-1"
    >
      <View
        className={`h-[18px] w-[18px] items-center justify-center rounded-[5px] border ${
          checked ? 'bg-accent border-accent' : 'border-hair bg-node'
        }`}
      >
        {checked ? <Icon as={CheckIcon} className="size-3 text-white" /> : null}
      </View>
      <Text className="text-dim text-sm">{label}</Text>
    </Pressable>
  )
}

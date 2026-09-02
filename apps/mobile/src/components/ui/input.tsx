import * as React from 'react'
import { TextInput, View } from 'react-native'
import { useCSSVariable } from 'uniwind'

import { Text } from '@/components/ui/text'
import { cn } from '@/lib/utils'

/**
 * 输入框做成**尺寸线**：等宽小标签在上，值坐在一条发丝线上，聚焦时线变主色。
 *
 * 🔴 **不要做成圆角描边的盒子。** 那是所有表单的默认长相，和这套图纸语言
 * 对不上（图纸上没有一个个方框，只有线和标注）。返工过一版盒子，
 * 整屏立刻回到「随便一个 App」。
 *
 * 🔴 **占位符颜色只能走 `placeholderTextColor`。** Tailwind 的 `placeholder:*`
 * 是 CSS 伪元素变体，RN 里没有这个概念 —— 写了不报错、也不生效。不给的话
 * 各 Android 版本的默认占位色不一样，深色主题下经常糊成一片看不见。
 */
function Input({
  label,
  className,
  onFocus,
  onBlur,
  ...props
}: React.ComponentProps<typeof TextInput> & { label?: string }) {
  const [focused, setFocused] = React.useState(false)
  const placeholderColor = useCSSVariable('--color-faint')

  return (
    <View className="gap-1">
      {label ? (
        <Text className="text-faint font-mono text-[10px]" style={{ letterSpacing: 2 }}>
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={typeof placeholderColor === 'string' ? placeholderColor : undefined}
        onFocus={(e) => {
          setFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          onBlur?.(e)
        }}
        className={cn(
          'text-ink h-10 border-b px-0 text-[16px]',
          focused ? 'border-accent' : 'border-line',
          props.editable === false && 'text-faint',
          className,
        )}
        {...props}
      />
    </View>
  )
}

export { Input }

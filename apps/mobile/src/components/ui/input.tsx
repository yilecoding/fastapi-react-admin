import * as React from 'react'
import { TextInput } from 'react-native'
import { useCSSVariable } from 'uniwind'

import { cn } from '@/lib/utils'

/**
 * 和 `packages/ui` 的 Input 同形，但这里是 RN 的 `TextInput`。
 *
 * 🔴 **占位符颜色只能走 `placeholderTextColor`，不能靠 className。**
 * Tailwind 的 `placeholder:*` 是 CSS 伪元素变体，RN 里根本没有这个概念 ——
 * 写了不报错、也不生效（uniwind 连 `placeholderClassName` 这个 prop 都没有，
 * 硬塞会被 tsc 挡下来）。不给的话各 Android 版本的默认占位色不一样，
 * 深色主题下经常糊成一片看不见，而这**不会报任何错**。
 *
 * `useCSSVariable` 要求这个变量至少在某处的 className 里被用过 ——
 * `text-muted-foreground` 全项目在用，所以拿得到。
 */
function Input({
  className,
  ...props
}: React.ComponentProps<typeof TextInput>) {
  const placeholderColor = useCSSVariable('--color-muted-foreground')

  return (
    <TextInput
      placeholderTextColor={typeof placeholderColor === 'string' ? placeholderColor : undefined}
      className={cn(
        'border-hair bg-panel text-ink h-12 rounded-xl border px-3.5 text-[15px]',
        props.editable === false && 'text-faint',
        className,
      )}
      {...props}
    />
  )
}

export { Input }

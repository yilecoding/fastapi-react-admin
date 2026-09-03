import { cn } from '@/lib/utils';
import { Platform, TextInput } from 'react-native';

/**
 * ⚠️ 这是 `react-native-reusables` 生成的组件，改了两处：
 *
 * 1. 补一条 `placeholderClassName` 的类型声明 —— 它解构了这个 prop（为了不让它
 *    被 spread 到原生 `TextInput` 上），但 `TextInputProps` 里没有这个键，
 *    TS 6 下会报 `Property 'placeholderClassName' does not exist`。
 *    **不要把解构删掉**：删了它就会被透传，原生侧收到未知 prop。
 *
 * 2. 🔴 **占位符颜色改走 uniwind 的 `placeholderTextColorClassName`。**
 *    模板原样带的是 `placeholder:text-muted-foreground/50`（native 分支里），
 *    而 **Tailwind 的 `placeholder:*` 是 CSS 伪元素变体，RN 里没有这个概念** ——
 *    写了不报错也不生效。于是占位色实际上**从来没被设过**，取的是各 Android
 *    版本自己的默认值（深色主题下经常糊成看不见），而这不会报任何错。
 *
 *    ⚠️ 正确的口子是 uniwind 自己的那个 prop（读它的 TextInput 包装确认过：
 *    `placeholderTextColorClassName` 经 `useAccentColor` 解析成
 *    `placeholderTextColor`）——**不是**自己 `useCSSVariable` 取值再传，
 *    那是多一层手写。
 */
function Input({
  className,
  placeholderClassName,
  placeholderTextColorClassName,
  ...props
}: React.ComponentProps<typeof TextInput> &
  React.RefAttributes<TextInput> & { placeholderClassName?: string }) {
  return (
    <TextInput
      // 不给的话占位符用平台默认色，见上
      placeholderTextColorClassName={placeholderTextColorClassName ?? 'text-muted-foreground'}
      className={cn(
        'dark:bg-input/30 border-input bg-background text-foreground flex h-10 w-full min-w-0 flex-row items-center rounded-md border px-3 py-1 text-base leading-5 shadow-sm shadow-black/5 sm:h-9',
        props.editable === false &&
          cn(
            'opacity-50',
            Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' })
          ),
        Platform.select({
          web: cn(
            'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground outline-none transition-[color,box-shadow] md:text-sm',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'
          ),
        }),
        className
      )}
      {...props}
    />
  );
}

export { Input };

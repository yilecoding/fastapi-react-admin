import { cn } from '@/lib/utils';
import { Platform, TextInput } from 'react-native';

/**
 * ⚠️ 这是 `react-native-reusables` 生成的原样组件，只补了一处类型：
 * 它解构了 `placeholderClassName`（为了不让这个 prop 被 spread 到原生
 * `TextInput` 上），但 `TextInputProps` 里没有这个键 —— TS 6 下会报
 * `Property 'placeholderClassName' does not exist`。加一条可选声明即可，
 * **不要把解构删掉**：删了它就会被透传，原生侧收到未知 prop。
 */
function Input({
  className,
  placeholderClassName,
  ...props
}: React.ComponentProps<typeof TextInput> &
  React.RefAttributes<TextInput> & { placeholderClassName?: string }) {
  return (
    <TextInput
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
          native: 'placeholder:text-muted-foreground/50',
        }),
        className
      )}
      {...props}
    />
  );
}

export { Input };

import * as React from "react"
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconExclamationCircle,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react"
import { cva, type VariantProps } from "class-variance-authority"

import { Button } from "@admin/ui/components/button"
import { useT } from "@admin/ui/lib/i18n"
import { cn } from "@admin/ui/lib/utils"

/**
 * 提示条 —— 「一段说明 + 一个语气色」。
 *
 * ## 为什么要有这个组件
 *
 * 它不是照着 antd 的组件清单补的，判据是**业务层已经在重复写它**：
 * 全仓 28 处手写「图标 + 彩色边框盒子」，而且抄成了四五种不同的形状 ——
 * 有的 `ring-1` 有的 `border`、有的 `rounded-md` 有的 `rounded-lg`、
 * 内边距在 `px-2.5 py-1.5` 和 `px-3 py-2` 之间摇摆、字号 `text-xs` / `text-sm`
 * 各半。同一个「警告」在配置页和插件页看着就不是一个东西。
 *
 * ## 和别的东西怎么分工
 *
 * | 要表达 | 用什么 |
 * |---|---|
 * | 请求失败了，可以重试 | `QueryError`（认 `ApiError.httpStatus`，403 有专门文案） |
 * | 一次操作的结果回执 | `toast()` —— 会自己消失，不占版面 |
 * | 一行数据的状态 | `StatusPill` / `Badge` |
 * | **常驻在版面上的一段说明或警告** | **本组件** |
 *
 * 判据是「会不会自己消失」：Alert 是版面的一部分，toast 不是。
 */
const alertVariants = cva(
  "relative flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm ring-1",
  {
    variants: {
      /**
       * 语气色。和 `platform/pages/_shared/status.tsx` 的 `TONE_CLASS` 同源 ——
       * 同一套语义在药丸和提示条上得是同一个颜色
       */
      tone: {
        info: "bg-sky-500/10 text-sky-800 ring-sky-500/25 dark:text-sky-200",
        success:
          "bg-emerald-500/10 text-emerald-800 ring-emerald-500/25 dark:text-emerald-200",
        warning:
          "bg-amber-500/10 text-amber-800 ring-amber-500/25 dark:text-amber-200",
        danger: "bg-destructive/10 text-destructive ring-destructive/25",
        muted: "bg-muted/50 text-muted-foreground ring-border",
      },
    },
    defaultVariants: { tone: "info" },
  }
)

const TONE_ICON = {
  info: IconInfoCircle,
  success: IconCircleCheck,
  warning: IconAlertTriangle,
  danger: IconExclamationCircle,
  muted: IconInfoCircle,
} as const

export type AlertTone = keyof typeof TONE_ICON

function Alert({
  className,
  tone = "info",
  icon,
  title,
  action,
  onDismiss,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof alertVariants> & {
    /** 自定义图标。传 `false` 完全不要图标（纯文字提示条） */
    icon?: React.ReactNode | false
    /** 加粗的一行标题。只有一句话时不用给 —— 单行提示不需要标题 */
    title?: React.ReactNode
    /** 右侧动作区，放「去设置」这种。**不放「关闭」**，那是 `onDismiss` */
    action?: React.ReactNode
    /** 给了才渲染关闭按钮。关不关得掉由调用方决定，组件自己不记状态 */
    onDismiss?: () => void
  }) {
  const t = useT()
  const key = (tone ?? "info") as AlertTone
  const Icon = TONE_ICON[key]

  return (
    <div
      role={key === "danger" ? "alert" : "status"}
      data-slot="alert"
      data-tone={key}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      {icon === false ? null : (
        // mt-0.5：图标是 16px、文字行高 20px，不推下去会比首行基线高 2px
        <span className="mt-0.5 shrink-0 [&>svg]:size-4">
          {icon ?? <Icon />}
        </span>
      )}

      {/* min-w-0：长 URL / 堆栈这种不可断词的内容不至于把提示条撑破 */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? (
          <div className="text-sm leading-relaxed [&_a]:underline [&_a]:underline-offset-2">
            {children}
          </div>
        ) : null}
      </div>

      {action ? <div className="shrink-0 self-center">{action}</div> : null}

      {onDismiss ? (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={t("关闭提示")}
          // -me-1：图标按钮自带 8px 视觉留白，不拉回来右边会比左边宽
          className="-me-1 shrink-0 self-start text-current hover:bg-current/10"
        >
          <IconX />
        </Button>
      ) : null}
    </div>
  )
}

export { Alert, alertVariants }

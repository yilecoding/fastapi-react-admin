"use client"

import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { useTranslation } from "react-i18next"
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react"

import { cn } from "@admin/ui/lib/utils"

/**
 * 轻量反馈（Toast）。
 *
 * 为什么要一个**模块级 manager**：真正需要弹提示的地方大多不是组件 ——
 * mutation 的 onError、api-client 的拦截器、store 里的副作用。
 * `createToastManager()` 造出来的 manager 可以在 React 之外调用，
 * `<Toaster />` 只是它的显示端。
 *
 * ⚠️ 这条通路只负责「说一声」。**失败必须仍然是可见状态**（硬纪律 9）——
 * 一个会自动消失的 toast 不能替代页面里的错误态，只能是它的补充。
 */
const manager = ToastPrimitive.createToastManager()

/**
 * message = 中性通知（无语气色）；loading = 转圈且不自动消失。
 * 其余四种是语气色。
 */
export type ToastTone = "message" | "info" | "success" | "warning" | "error" | "loading"

type Options = {
  description?: React.ReactNode
  /** 0 = 不自动消失（错误类默认就是 0，见下） */
  timeout?: number
  action?: { label: string; onClick: () => void }
}

function push(tone: ToastTone, title: React.ReactNode, opts: Options = {}) {
  return manager.add({
    title,
    description: opts.description,
    type: tone,
    // 错误和加载中默认不自动消失：一条自己溜走的报错等于没报，
    // 而 loading 要等调用方 update/close 才该走
    timeout: opts.timeout ?? (tone === "error" || tone === "loading" ? 0 : 4500),
    ...(opts.action
      ? { actionProps: { children: opts.action.label, onClick: opts.action.onClick } }
      : {}),
  })
}

export const toast = {
  /** 中性通知，不带语气色 */
  message: (title: React.ReactNode, opts?: Options) => push("message", title, opts),
  info: (title: React.ReactNode, opts?: Options) => push("info", title, opts),
  success: (title: React.ReactNode, opts?: Options) => push("success", title, opts),
  warning: (title: React.ReactNode, opts?: Options) => push("warning", title, opts),
  error: (title: React.ReactNode, opts?: Options) => push("error", title, opts),
  /** 转圈且不自动消失。返回 id，之后用 update 把它变成结果态 */
  loading: (title: React.ReactNode, opts?: Options) => push("loading", title, opts),
  /** 把已有的一条改掉（loading → success 就靠它） */
  update: manager.update,
  /** 关掉某一条；不传 id 关掉全部 */
  dismiss: (id?: string) => manager.close(id),
  /** 跟着 promise 走：loading → success / error */
  promise: manager.promise,
}

const TONE_ICON: Record<ToastTone, typeof IconInfoCircle> = {
  message: IconInfoCircle,
  info: IconInfoCircle,
  success: IconCircleCheck,
  warning: IconAlertTriangle,
  error: IconCircleX,
  loading: IconLoader2,
}

const TONE_CLASS: Record<ToastTone, string> = {
  message: "text-muted-foreground",
  info: "text-sky-600 dark:text-sky-400",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
  loading: "text-muted-foreground",
}

function ToastItem({ toast: item }: { toast: ToastPrimitive.Root.ToastObject }) {
  const { t } = useTranslation()
  // promise() 的 loading 阶段不带 type，按 loading 处理（转圈比信息图标准）
  const tone = (item.type as ToastTone | undefined) ?? "loading"
  const Icon = TONE_ICON[tone] ?? IconInfoCircle
  const spinning = tone === "loading"

  return (
    <ToastPrimitive.Root
      toast={item}
      swipeDirection={["right", "down"]}
      className={cn(
        "group/toast relative flex w-full items-start gap-3 rounded-lg border border-border bg-popover p-3.5 pe-9 text-popover-foreground shadow-lg",
        "translate-x-[var(--toast-swipe-movement-x)] translate-y-[var(--toast-swipe-movement-y)] transition-all duration-200",
        // 进场从下方浮起，离场缩一点淡出；被 limit 顶掉的直接淡出
        "data-[starting-style]:translate-y-3 data-[starting-style]:opacity-0",
        "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
        "data-[limited]:opacity-0",
        // 拖动过程中不要再叠一层过渡，否则跟手会有橡皮筋感
        "data-[swiping]:transition-none"
      )}
    >
      <Icon className={cn("mt-px size-4 shrink-0", TONE_CLASS[tone], spinning && "animate-spin")} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ToastPrimitive.Title className="text-sm leading-snug font-medium" />
        <ToastPrimitive.Description className="text-sm leading-relaxed text-muted-foreground" />
        {item.actionProps && (
          <ToastPrimitive.Action className="mt-1.5 w-fit rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline" />
        )}
      </div>
      <ToastPrimitive.Close
        aria-label={t("关闭")}
        className="absolute end-2 top-2 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <IconX className="size-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  )
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager()
  return toasts.map((item) => <ToastItem key={item.id} toast={item} />)
}

/**
 * 挂一次就够，放在应用根上。
 *
 * 视口是普通的纵向流式布局（不是绝对定位的叠卡）—— 叠卡要靠
 * `--toast-index` / `--toast-offset-y` 手算位移，多一层出错面，
 * 而这套后台需要的是「看清楚写了什么」，不是炫。
 */
export function Toaster({
  children,
  limit = 4,
}: {
  children?: React.ReactNode
  limit?: number
}) {
  return (
    <ToastPrimitive.Provider toastManager={manager} limit={limit}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="fixed end-4 bottom-4 z-100 flex w-[min(calc(100vw-2rem),23rem)] flex-col gap-2.5 outline-none">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  )
}

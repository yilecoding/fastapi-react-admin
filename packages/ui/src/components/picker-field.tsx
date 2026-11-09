"use client"

import * as React from "react"
import { IconX } from "@tabler/icons-react"

import { Popover, PopoverContent } from "@admin/ui/components/popover"
import { useT } from "@admin/ui/lib/i18n"
import { cn } from "@admin/ui/lib/utils"

/**
 * 「可以直接敲的输入框 + 下面弹一个面板」—— 日期 / 时间选择器的外壳（#266 的「手输」）。
 *
 * 和 `PopoverTrigger` 那种按钮触发器的区别全在焦点上：
 *
 * - 面板打开时**焦点留在输入框里**（`initialFocus={false}`），这样边敲边看面板跟着跳；
 *   按 ↓ 才把焦点送进面板
 * - 没有 `PopoverTrigger`，面板靠 `anchor` 定位到整个输入框上。于是 Base UI 会把
 *   「点输入框」也当成「点在浮层外面」—— 这一下要拦住，不然每点一次输入框面板就
 *   关了再开、闪一下
 * - Tab 离开时关面板：焦点本来就不在面板里，Base UI 的「焦点离开就关」管不到这里
 *
 * 文本的状态归调用方：敲到一半的文本不是值，只有回车 / 点选才提交；关面板时调用方
 * 把文本恢复成当前值（敲错了不留下半截）。
 */
export function PickerField({
  open,
  onOpenChange,
  text,
  onTextChange,
  onEnter,
  invalid,
  onClear,
  icon,
  placeholder,
  size = "default",
  disabled,
  id,
  className,
  inputClassName,
  contentClassName,
  "aria-label": ariaLabel,
  "data-testid": testId,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  text: string
  onTextChange: (text: string) => void
  /** 回车。返回 `false` 表示没提交成功（文本不合法），面板保持打开 */
  onEnter: () => boolean
  invalid?: boolean
  /** 给了就在有内容时显示「×」 */
  onClear?: () => void
  icon?: React.ReactNode
  placeholder?: string
  size?: "sm" | "default"
  disabled?: boolean
  id?: string
  className?: string
  inputClassName?: string
  contentClassName?: string
  "aria-label"?: string
  "data-testid"?: string
  children: React.ReactNode
}) {
  const t = useT()
  const boxRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const popupRef = React.useRef<HTMLDivElement>(null)

  const focusPanel = () => {
    const p = popupRef.current
    if (!p) return
    const target =
      p.querySelector<HTMLElement>('[data-slot="calendar"] [tabindex="0"]') ??
      p.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ??
      p.querySelector<HTMLElement>("button:not(:disabled)")
    target?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // 点的是输入框自己（没有 Trigger，Base UI 把它算成「浮层外面」）—— 不关
        const target = details.event?.target
        if (!next && target instanceof Node && boxRef.current?.contains(target)) return
        onOpenChange(next)
      }}
    >
      <div
        ref={boxRef}
        data-slot="picker-field"
        data-disabled={disabled || undefined}
        className={cn(
          "group/picker relative flex w-full min-w-0 items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 shadow-xs transition-[color,box-shadow] dark:bg-input/30",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          invalid && "border-destructive ring-3 ring-destructive/20 focus-within:border-destructive focus-within:ring-destructive/20",
          disabled && "pointer-events-none cursor-not-allowed opacity-50",
          size === "sm" ? "h-8" : "h-9",
          className
        )}
        onMouseDown={(e) => {
          // 点在图标 / 留白上也把焦点给输入框，和点输入框本身一样
          if (e.target !== inputRef.current && !(e.target as HTMLElement).closest("button")) {
            e.preventDefault()
            inputRef.current?.focus()
            if (!disabled) onOpenChange(true)
          }
        }}
      >
        {icon && <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>}
        <input
          ref={inputRef}
          id={id}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          autoComplete="off"
          spellCheck={false}
          data-testid={testId}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm",
            inputClassName
          )}
          onClick={() => !disabled && onOpenChange(true)}
          onChange={(e) => {
            // 先开再改文本：调用方在「打开」时用当前值起草稿，顺序反了会把刚敲出来的草稿冲掉
            if (!open) onOpenChange(true)
            onTextChange(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // 不要冒泡到外面的 <form>：回车在这里是「提交这个值」，不是「提交表单」
              e.preventDefault()
              if (onEnter()) onOpenChange(false)
            } else if (e.key === "ArrowDown") {
              e.preventDefault()
              if (!open) onOpenChange(true)
              requestAnimationFrame(focusPanel)
            } else if (e.key === "Tab") {
              if (open) onOpenChange(false)
            }
          }}
        />
        {onClear && text && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("清除")}
            data-testid={testId && `${testId}-clear`}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/picker:opacity-100 group-focus-within/picker:opacity-100 hover:text-foreground"
            onClick={() => {
              onClear()
              onOpenChange(false)
              inputRef.current?.focus()
            }}
          >
            <IconX className="size-3.5" />
          </button>
        )}
      </div>
      <PopoverContent
        ref={popupRef}
        anchor={boxRef}
        align="start"
        initialFocus={false}
        finalFocus={false}
        className={cn("w-auto gap-0 p-0", contentClassName)}
        data-testid={testId && `${testId}-panel`}
        onKeyDown={(e) => {
          // 面板里的 Esc：把焦点还给输入框（Base UI 关浮层，`finalFocus={false}` 不会替我们还）
          if (e.key === "Escape") requestAnimationFrame(() => inputRef.current?.focus())
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

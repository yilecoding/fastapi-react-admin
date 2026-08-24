import * as React from "react"
import { IconCheck } from "@tabler/icons-react"

import { Switch } from "@admin/ui/components/switch"
import { cn } from "@admin/ui/lib/utils"

/**
 * 设置项的行式排版件。
 *
 * ⚠️ **控件放哪一侧，按控件宽度决定。**
 *
 * | 控件 | 位置 | 理由 |
 * |---|---|---|
 * | 开关、单个按钮 | 同一行**最右**（`inline`） | 一列开关纵向对齐，好扫；且内容区铺满时右边缘齐 |
 * | 分段选择、色板 | **标签下方**（`stacked`，默认） | 这些有 200~430px 宽，塞进右侧会挤掉说明文字 |
 *
 * ⚠️ `inline` 行的代价：内容区不封顶（见 `settings-shell.tsx` 的说明），
 * 所以 1600px 视口下「标签文字 → 开关」实测 926~954px，1920px 下超过 1200px。
 * 这是**明知代价的选择**（右侧不留空白优先），不是没量过。
 * 如果哪天觉得难扫，改法在 `settings-shell.tsx` 顶部注释里写着。
 *
 * 说明文字写「开启后会发生什么」，不要重复标签本身。
 */
export function SettingRow({
  label,
  description,
  children,
  layout = "stacked",
  htmlFor,
  testId,
}: {
  label: string
  description?: React.ReactNode
  children?: React.ReactNode
  /** `inline` 只给开关和单按钮用，见上表 */
  layout?: "inline" | "stacked"
  /** 有真实表单控件时传，让标签可点 */
  htmlFor?: string
  testId?: string
}) {
  const Label = htmlFor ? "label" : "span"
  const text = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Label className="text-sm font-medium" htmlFor={htmlFor}>
        {label}
      </Label>
      {description && (
        <span className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      )}
    </div>
  )

  if (layout === "inline") {
    return (
      <div
        className="flex items-center justify-between gap-6 border-b border-border/60 pb-4 last:border-0 last:pb-0"
        data-testid={testId}
      >
        {text}
        <div className="shrink-0">{children}</div>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-2.5 border-b border-border/60 pb-4 last:border-0 last:pb-0"
      data-testid={testId}
    >
      {text}
      {children}
    </div>
  )
}

/** 分段选择。自己写而不用 Base UI 的 ToggleGroup —— 后者是多选语义，单选反而绕 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  testId,
  className,
  optionClassName,
  iconPlacement = "inline",
}: {
  value: T
  options: Array<{
    value: T
    label: string
    caption?: string
    icon?: React.ReactNode
  }>
  onChange: (v: T) => void
  testId?: string
  className?: string
  optionClassName?: string
  iconPlacement?: "inline" | "above"
}) {
  return (
    <div
      className={cn(
        "flex w-fit max-w-full flex-wrap items-stretch gap-1 rounded-md bg-muted/60 p-1",
        className
      )}
      role="radiogroup"
      data-testid={testId}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            onClick={() => onChange(o.value)}
            style={{ minHeight: "var(--density-row-height)" }}
            className={cn(
              "flex min-w-16 flex-col items-center justify-center gap-0.5 rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-xs transition-colors",
              optionClassName,
              on
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {iconPlacement === "above" && o.icon}
            <span className="flex items-center gap-1 whitespace-nowrap">
              {iconPlacement === "inline" && o.icon}
              {o.label}
            </span>
            {o.caption && (
              <span className="text-2xs opacity-70">{o.caption}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 色板选择。
 *
 * 色块下面带名字 —— 只有一排色点时，「当前选的是哪个」要靠对比 7 个色相来认，
 * 而颜色名（靛蓝 / 天蓝 / 青碧…）本身就是最短的说明。
 */
export function ColorSwatches<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T
  options: Array<{ value: T; label: string; color: string }>
  onChange: (v: T) => void
  testId?: string
}) {
  return (
    <div
      className="flex flex-wrap gap-2"
      role="radiogroup"
      data-testid={testId}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.label}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            onClick={() => onChange(o.value)}
            className="flex w-14 flex-col items-center gap-1"
          >
            <span
              style={{ backgroundColor: o.color }}
              className={cn(
                "grid size-6 place-content-center rounded-full text-white transition-transform",
                // 选中态用外圈而不是描边 —— 描边会把色块本身的颜色改掉
                on
                  ? "ring-2 ring-offset-2 ring-offset-background"
                  : "hover:scale-110"
              )}
            >
              {on && <IconCheck className="size-3.5" />}
            </span>
            <span
              className={cn(
                "w-full truncate text-center text-2xs",
                on ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {o.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** 开关行 —— 固定 `inline`，见文件头的表 */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  testId,
}: {
  label: string
  description?: React.ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <SettingRow label={label} description={description} layout="inline">
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        data-testid={testId}
      />
    </SettingRow>
  )
}

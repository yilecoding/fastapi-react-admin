"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { IconSearch, IconSelector, IconX } from "@tabler/icons-react"

import { Checkbox } from "@admin/ui/components/checkbox"
import { Separator } from "@admin/ui/components/separator"
import { cn } from "@admin/ui/lib/utils"

/**
 * 多选下拉。
 *
 * 和 `Select` / `Combobox` 的分工是**选几个**，不是选项多少：
 *   选一个 → `Select`（≤8 项）/ `Combobox`（长列表）
 *   选多个 → 这个
 *
 * 为什么单独一个组件而不是给 `Combobox` 加个 `multiple`：
 * 多选的**关闭态**是另一回事 —— 单选显示一个 label 就完了，多选要回答
 * 「选了哪些、选了几个、怎么去掉其中一个」。把两套关闭态挤进一个组件，
 * 调用方每次都要读一遍才知道自己拿到的是 string 还是 string[]。
 *
 * 关闭态刻意**不铺 chips**：筛选栏里的控件宽度是有限的（w-44 那一档），
 * 铺三个 chip 就换行，一行 32px 的工具栏会被顶成两行 —— 而多选最常见的
 * 用法就是筛选栏。所以 1 项显示 label、多项显示「label +n」，
 * 完整清单在下拉里（勾选态就是清单）。
 */

export type MultiSelectOption = {
  value: string
  label: string
  /** 右侧的弱化补充说明（如权限码、编号） */
  hint?: string
  disabled?: boolean
}

const triggerVariants = {
  sm: "h-8",
  default: "h-9",
} as const

/** 超过这个数量才给下拉配搜索框 —— 五六项还要打字是噪音 */
const SEARCHABLE_FROM = 8

function MultiSelect({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  size = "default",
  className,
  disabled,
  id,
  searchable,
  /** 显示「全选 / 清空」那一行。选项很多时它是唯一不用点 N 次的办法 */
  showBulk = true,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  value: readonly string[] | null | undefined
  onValueChange: (value: string[]) => void
  options: readonly MultiSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  size?: keyof typeof triggerVariants
  className?: string
  disabled?: boolean
  id?: string
  /** 不给就按选项数量自动决定（> 8 项才有搜索框） */
  searchable?: boolean
  showBulk?: boolean
  "aria-label"?: string
  "data-testid"?: string
}) {
  const { t } = useTranslation()
  const selected = React.useMemo(() => [...(value ?? [])], [value])

  const values = React.useMemo(() => options.map((o) => o.value), [options])
  const byValue = React.useMemo(() => new Map(options.map((o) => [o.value, o])), [options])
  const labelOf = React.useCallback((v: string) => byValue.get(v)?.label ?? v, [byValue])

  const withSearch = searchable ?? options.length > SEARCHABLE_FROM
  const enabled = React.useMemo(() => options.filter((o) => !o.disabled).map((o) => o.value), [options])
  const allOn = enabled.length > 0 && enabled.every((v) => selected.includes(v))

  return (
    <ComboboxPrimitive.Root
      multiple
      items={values}
      value={selected}
      onValueChange={(v) => onValueChange((v as string[]) ?? [])}
      itemToStringLabel={labelOf}
      disabled={disabled}
    >
      <ComboboxPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        data-slot="multi-select-trigger"
        data-size={size}
        data-testid={testId}
        className={cn(
          "flex w-full items-center justify-between gap-1.5 rounded-md border border-input bg-transparent py-2 ps-2.5 pe-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50",
          triggerVariants[size],
          className
        )}
      >
        {/*
          关闭态自己算，不用 Combobox.Value —— 多选时它给的是数组，
          「A、B、C」直接铺出来会在 w-44 里被截成「A、B、」，看不出还有几个。
        */}
        <span data-slot="multi-select-value" className="min-w-0 flex-1 truncate text-start">
          {selected.length === 0 ? (
            <span className="text-muted-foreground">{placeholder ?? t("请选择")}</span>
          ) : selected.length === 1 ? (
            labelOf(selected[0]!)
          ) : (
            <>
              {labelOf(selected[0]!)}
              <span className="ms-1 text-muted-foreground">+{selected.length - 1}</span>
            </>
          )}
        </span>
        <ComboboxPrimitive.Icon
          render={<IconSelector className="pointer-events-none size-4 shrink-0 text-muted-foreground" />}
        />
      </ComboboxPrimitive.Trigger>

      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner sideOffset={4} className="isolate z-50 outline-none">
          <ComboboxPrimitive.Popup
            data-slot="multi-select-content"
            className="max-h-(--available-height) w-(--anchor-width) min-w-[12rem] origin-(--transform-origin) overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md transition-[transform,scale,opacity] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            {withSearch && (
              <div className="flex items-center gap-2 border-b border-border px-2.5">
                <IconSearch className="size-4 shrink-0 text-muted-foreground" />
                <ComboboxPrimitive.Input
                  data-slot="multi-select-input"
                  placeholder={searchPlaceholder ?? t("搜索")}
                  className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            )}

            {/* 见 combobox.tsx 里那段注释：Empty 是常驻的 aria-live 区域，
                有结果时会白占 48px，`empty:hidden` 正好命中 */}
            <ComboboxPrimitive.Empty className="px-3 py-6 text-center text-sm text-muted-foreground empty:hidden">
              {emptyText ?? t("没有匹配项")}
            </ComboboxPrimitive.Empty>

            <ComboboxPrimitive.List className="max-h-64 overflow-y-auto overscroll-contain p-1">
              <MultiSelectItems byValue={byValue} selected={selected} />
            </ComboboxPrimitive.List>

            {showBulk && options.length > 1 && (
              <>
                <Separator />
                <div className="flex items-center justify-between gap-2 p-1">
                  <button
                    type="button"
                    data-testid={testId && `${testId}-all`}
                    className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onValueChange(allOn ? [] : enabled)}
                  >
                    {allOn ? t("取消全选") : t("全选")}
                  </button>
                  <span className="px-2 text-xs text-muted-foreground">
                    {t("已选 {{n}} 项", { n: selected.length })}
                  </span>
                  {selected.length > 0 && (
                    <button
                      type="button"
                      aria-label={t("清空")}
                      data-testid={testId && `${testId}-clear`}
                      className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => onValueChange([])}
                    >
                      <IconX className="size-3.5" />
                    </button>
                  )}
                </div>
              </>
            )}
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  )
}

/** 过滤后的条目由 Base UI 内部算好，这里只负责渲染 */
function MultiSelectItems({
  byValue,
  selected,
}: {
  byValue: Map<string, MultiSelectOption>
  selected: readonly string[]
}) {
  const filtered = ComboboxPrimitive.useFilteredItems<string>()
  const on = React.useMemo(() => new Set(selected), [selected])

  return (
    <>
      {filtered.map((v) => {
        const opt = byValue.get(v)
        if (!opt) return null
        return (
          <ComboboxPrimitive.Item
            key={v}
            value={v}
            disabled={opt.disabled}
            data-slot="multi-select-item"
            className="relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
          >
            {/*
              多选用**复选框**而不是右侧对勾：对勾是「当前是哪一个」的语义，
              多选要传达的是「这一项开着，还能再开别的」。
              ⚠️ `render={<span />}` 不能省 —— Base UI 的 Checkbox 默认渲染成
              `<button>`，塞进 `role="option"` 里就是嵌套可交互元素（点击还会互相抢）。
              渲染成 span 后它只是个带 `role="checkbox"` 的视觉件，点击照旧由 Item 处理。
            */}
            <Checkbox
              render={<span />}
              checked={on.has(v)}
              className="pointer-events-none"
              tabIndex={-1}
            />
            <span className="min-w-0 flex-1 truncate">{opt.label}</span>
            {opt.hint && (
              <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">{opt.hint}</span>
            )}
          </ComboboxPrimitive.Item>
        )
      })}
    </>
  )
}

export { MultiSelect }

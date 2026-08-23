"use client"

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { IconCheck, IconSearch, IconSelector } from "@tabler/icons-react"

import { cn } from "@admin/ui/lib/utils"

/**
 * 可搜索的下拉（Combobox）。
 *
 * 和 `Select` 的分工是**选项数量**，不是别的：
 *   ≤ 8 项（状态、类型、是否）      → `Select`，点开一眼看全，多一个输入框是噪音
 *   长列表（菜单 62 项、路由、部门） → 这个，必须能打字
 *
 * 之前没有它的代价是实打实的：菜单表单的「上级菜单」把 62 个菜单塞进一个
 * `max-h-72` 的下拉里，只能瞎滚；而 `menu/icon-picker.tsx` 干脆自己手搓了
 * 一个搜索框 —— 同一个需求在两个地方各解决一次。
 *
 * 底座是 Base UI 的 combobox（过滤用 `Intl.Collator`，中文和大小写都对），
 * 不是 cmdk。`command.tsx` 在这个仓库里一个调用方都没有。
 */

export type ComboboxOption = {
  value: string
  label: string
  /** 右侧的弱化补充说明（如权限码、路由地址） */
  hint?: string
  disabled?: boolean
}

const triggerVariants = {
  sm: "h-8",
  default: "h-9",
} as const

function Combobox({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  searchPlaceholder = "搜索",
  emptyText = "没有匹配项",
  size = "default",
  className,
  disabled,
  id,
  "data-testid": testId,
  renderItem,
}: {
  value: string | null | undefined
  onValueChange: (value: string | null) => void
  options: readonly ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  size?: keyof typeof triggerVariants
  className?: string
  disabled?: boolean
  id?: string
  "data-testid"?: string
  /** 自定义单项渲染。不给就是「label + 右侧 hint」 */
  renderItem?: (option: ComboboxOption) => React.ReactNode
}) {
  // 只把 value 交给 Base UI，label 通过 itemToStringLabel 供显示与过滤 ——
  // 这样调用方的 value 仍然是字符串，和 Select 一致，替换成本最低
  const values = React.useMemo(() => options.map((o) => o.value), [options])
  const byValue = React.useMemo(
    () => new Map(options.map((o) => [o.value, o])),
    [options]
  )
  const labelOf = React.useCallback(
    (v: string) => byValue.get(v)?.label ?? v,
    [byValue]
  )

  return (
    <ComboboxPrimitive.Root
      items={values}
      value={value ?? null}
      onValueChange={(v) => onValueChange((v as string | null) ?? null)}
      itemToStringLabel={labelOf}
      disabled={disabled}
    >
      <ComboboxPrimitive.Trigger
        id={id}
        data-slot="combobox-trigger"
        data-size={size}
        data-testid={testId}
        className={cn(
          "flex w-full items-center justify-between gap-1.5 rounded-md border border-input bg-transparent py-2 ps-2.5 pe-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50",
          triggerVariants[size],
          className
        )}
      >
        {/* Value 不渲染自己的元素（也不吃 className），所以外面套一层 */}
        <span data-slot="combobox-value" className="line-clamp-1 flex-1 text-start">
          <ComboboxPrimitive.Value placeholder={<span className="text-muted-foreground">{placeholder}</span>}>
            {(v: string | null) => (v == null ? null : labelOf(v))}
          </ComboboxPrimitive.Value>
        </span>
        <ComboboxPrimitive.Icon
          render={<IconSelector className="pointer-events-none size-4 shrink-0 text-muted-foreground" />}
        />
      </ComboboxPrimitive.Trigger>

      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner sideOffset={4} className="isolate z-50 outline-none">
          <ComboboxPrimitive.Popup
            data-slot="combobox-content"
            className="max-h-(--available-height) w-(--anchor-width) min-w-[12rem] origin-(--transform-origin) overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md transition-[transform,scale,opacity] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            {/* 输入框固定在顶部，列表自己滚 —— 滚着还能继续打字 */}
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <IconSearch className="size-4 shrink-0 text-muted-foreground" />
              <ComboboxPrimitive.Input
                data-slot="combobox-input"
                placeholder={searchPlaceholder}
                className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            {/*
              Empty 是**常驻**的 aria-live 区域（带 role/aria-live/aria-atomic），
              只有子内容是条件渲染的 —— 所以有结果时它仍然占着 py-6 那 48px，
              表现成「搜索框和结果之间空一大块」（实测过）。
              `empty:hidden` 正好命中：有结果 → 元素内没有任何子节点 → :empty → 隐藏；
              没结果 → 里面有文案 → 照常显示。读屏语义不受影响（该播报时它是可见的）。
            */}
            <ComboboxPrimitive.Empty className="px-3 py-6 text-center text-sm text-muted-foreground empty:hidden">
              {emptyText}
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List className="max-h-64 overflow-y-auto overscroll-contain p-1">
              <ComboboxItems byValue={byValue} renderItem={renderItem} />
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  )
}

/** 过滤后的条目由 Base UI 内部算好，这里只负责渲染 */
function ComboboxItems({
  byValue,
  renderItem,
}: {
  byValue: Map<string, ComboboxOption>
  renderItem?: (option: ComboboxOption) => React.ReactNode
}) {
  const filtered = ComboboxPrimitive.useFilteredItems<string>()

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
            data-slot="combobox-item"
            className="relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 ps-2 pe-8 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {renderItem ? renderItem(opt) : (
                <>
                  <span className="truncate">{opt.label}</span>
                  {opt.hint && (
                    <span className="ms-auto truncate font-mono text-xs text-muted-foreground">
                      {opt.hint}
                    </span>
                  )}
                </>
              )}
            </span>
            <ComboboxPrimitive.ItemIndicator className="absolute end-2 flex items-center">
              <IconCheck className="size-4" />
            </ComboboxPrimitive.ItemIndicator>
          </ComboboxPrimitive.Item>
        )
      })}
    </>
  )
}

export { Combobox }

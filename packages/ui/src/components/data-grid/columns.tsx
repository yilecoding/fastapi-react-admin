"use client"

import * as React from "react"

import { Checkbox } from "@admin/ui/components/checkbox"
import { cn } from "@admin/ui/lib/utils"

/**
 * 建列的小工具 + 单元格排版原语。
 *
 * 列定义本身留在调用方（业务字段、filterFn 都是业务的事），这里只提供
 * 「每张表都长一样」的那几根柱子：多选列、序号列、展开列，以及双行单元格。
 */

type AnyHelper = {
  display: (def: Record<string, unknown>) => unknown
}

/** 多选列。表头是三态全选，行内是单行复选 */
export function buildGridSelectColumn(
  col: AnyHelper,
  opts: { canSelect?: (row: any) => boolean } = {}
) {
  return col.display({
    id: "__select__",
    size: 40,
    enableHiding: false,
    header: ({ table }: { table: any }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
        onCheckedChange={(v: boolean) => table.toggleAllPageRowsSelected(Boolean(v))}
        aria-label="全选本页"
        data-testid="grid-select-all"
      />
    ),
    cell: ({ row }: { row: any }) => (
      <Checkbox
        checked={row.getIsSelected()}
        disabled={opts.canSelect ? !opts.canSelect(row.original) : !row.getCanSelect()}
        onCheckedChange={(v: boolean) => row.toggleSelected(Boolean(v))}
        aria-label="选择该行"
        data-testid={`grid-select-${row.id}`}
      />
    ),
  })
}

/**
 * 序号列。
 *
 * `offset` 是**跨页**序号的关键：服务端分页时第 2 页第 1 行要显示 21 而不是 1，
 * 所以偏移量得由调用方按 `(page-1)*size` 传进来，组件自己算不出来。
 */
export function buildGridRowNumberColumn(col: AnyHelper, opts: { offset?: number } = {}) {
  return col.display({
    id: "__index__",
    size: 56,
    enableHiding: false,
    header: () => <span className="text-xs text-muted-foreground">序号</span>,
    cell: ({ row }: { row: any }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {(opts.offset ?? 0) + row.index + 1}
      </span>
    ),
  })
}

/** 展开列：只有 `getCanExpand()` 为真的行才渲染箭头 */
export function buildGridExpandColumn(col: AnyHelper) {
  return col.display({
    id: "__expand__",
    size: 36,
    enableHiding: false,
    header: () => null,
    cell: ({ row }: { row: any }) =>
      row.getCanExpand() ? (
        <button
          type="button"
          onClick={row.getToggleExpandedHandler()}
          aria-label={row.getIsExpanded() ? "收起" : "展开"}
          data-testid={`grid-expand-${row.id}`}
          className="grid size-5 place-content-center rounded-sm text-muted-foreground hover:bg-muted"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               className={cn("size-3.5 transition-transform", row.getIsExpanded() && "rotate-90")}>
            <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null,
  })
}

// ─── 单元格排版 ────────────────────────────────────────────────────────────────

/**
 * 双行单元格：主信息 + 次要信息。
 *
 * 一张表的信息密度基本由这个决定 —— 把「上海 · 平台体验组」塞进姓名那一格的第二行，
 * 比单开一列省一半横向空间，而且读起来是一个整体。
 */
export function GridCell({
  primary,
  secondary,
  leading,
  className,
}: {
  primary: React.ReactNode
  secondary?: React.ReactNode
  leading?: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      {leading}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{primary}</span>
        {secondary != null && secondary !== "" && (
          <span className="truncate text-xs text-muted-foreground">{secondary}</span>
        )}
      </span>
    </span>
  )
}

/** 操作列内容：右对齐 + 悬停才显形的次要动作 */
export function GridActions({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("flex items-center justify-end gap-1", className)}>{children}</span>
  )
}

// ─── 尺寸与固定 ────────────────────────────────────────────────────────────────

/**
 * 每个 th / td 都要输出的尺寸样式。
 *
 * ⚠️ 这是整套布局的地基，不是可选装饰：
 * - `<table>` 必须 `table-fixed`，否则浏览器按内容自动分配列宽，
 *   拖出来的宽度立刻被覆盖，列宽拖拽等于不存在
 * - **th 和 td 都要给**，只给 th 的话 td 会各自撑开，sticky 的累计偏移就对不上
 * - `minWidth` 和 `width` 一起给：`table-fixed` 下光有 width 在窄容器里还是会被压
 */
export function sizeStyle(column: any): React.CSSProperties {
  const w = column?.getSize?.()
  return w ? { width: w, minWidth: w } : {}
}

/** 尺寸 + 固定，一次算完 —— 渲染处不用记得拼两个 */
export function cellStyle(column: any): React.CSSProperties {
  return { ...sizeStyle(column), ...getPinnedStyle(column) }
}

// ─── 列固定 ────────────────────────────────────────────────────────────────────

/**
 * 把 TanStack 的 pin 状态翻译成 sticky 定位。
 *
 * 这就是「操作列被 overflow 裁掉、点不到」那个老问题的正解：
 * 容器保持 `overflow-auto`，让操作列自己 sticky 在末尾。
 *
 * ⚠️ v9 的固定方位是**逻辑方位** `'start' | 'end'`（不是 left/right），
 * 偏移量 `getStart` / `getAfter` 来自 `columnSizingFeature` —— 没注册它就拿不到
 * 累计偏移，多列固定会叠在一起。单列固定（最常见的操作列）不受影响。
 */
export function getPinnedStyle(column: any): React.CSSProperties | undefined {
  const pinned = column?.getIsPinned?.()
  if (!pinned) return undefined
  const size = column.getSize?.()
  return pinned === "start"
    ? { position: "sticky", insetInlineStart: column.getStart?.("start") ?? 0, zIndex: 2, width: size }
    : { position: "sticky", insetInlineEnd: column.getAfter?.("end") ?? 0, zIndex: 2, width: size }
}

/** 固定列和滚动区交界处的那道阴影，不加会分不清哪些列是浮着的 */
export function pinnedClass(column: any): string {
  const pinned = column?.getIsPinned?.()
  if (!pinned) return ""
  const isEdge =
    pinned === "start"
      ? column.getIsLastColumn?.("start")
      : column.getIsFirstColumn?.("end")
  return cn(
    "bg-background",
    isEdge &&
      (pinned === "start"
        ? "after:pointer-events-none after:absolute after:inset-y-0 after:-end-4 after:w-4 after:bg-gradient-to-r after:from-black/8 after:to-transparent dark:after:from-black/40"
        : "before:pointer-events-none before:absolute before:inset-y-0 before:-start-4 before:w-4 before:bg-gradient-to-l before:from-black/8 before:to-transparent dark:before:from-black/40")
  )
}

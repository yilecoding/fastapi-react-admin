"use client"

import * as React from "react"
import { IconX } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Separator } from "@admin/ui/components/separator"
import { cn } from "@admin/ui/lib/utils"

/**
 * 底部浮动批量操作条。
 *
 * 为什么不放在工具栏：勾选发生在表格**中下部**，而工具栏在顶上 ——
 * 勾完还要把视线拉回顶部找按钮。浮条跟着视线走，选中即出现在手边。
 *
 * 选中 0 行时整块不渲染（不是隐藏），避免它在 DOM 里挡住表格底部的行。
 */
export function DataGridBulkBar({
  count,
  total,
  onClear,
  children,
  className,
}: {
  count: number
  /** 数据总量，用来显示「已选 3 / 1000」 */
  total?: number
  onClear: () => void
  children?: React.ReactNode
  className?: string
}) {
  if (count === 0) return null

  return (
    <div
      className={cn(
        "pointer-events-none sticky bottom-4 z-30 flex justify-center px-4",
        className
      )}
      data-testid="grid-bulk-bar"
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border bg-popover/80 px-3 py-2 shadow-lg ring-1 ring-foreground/5 backdrop-blur-xl">
        <span className="text-sm">
          已选 <span className="font-medium tabular-nums">{count}</span>
          {total != null && <span className="text-muted-foreground"> / {total}</span>}
        </span>
        {children && <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />}
        {children}
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        <Button
          variant="ghost" size="icon" className="size-6"
          aria-label="取消选择" onClick={onClear} data-testid="grid-bulk-clear"
        >
          <IconX className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

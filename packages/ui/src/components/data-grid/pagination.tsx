"use client"

import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/ui/components/select"

export type GridPagination = {
  /** 0 起 */
  pageIndex: number
  pageCount: number
  pageSize: number
  totalCount: number
  onPageChange: (i: number) => void
  onPageSizeChange: (s: number) => void
  pageSizeOptions?: number[]
}

const DEFAULT_SIZES = [10, 20, 50, 100]

export function DataGridPagination({ page }: { page: GridPagination }) {
  const sizes = page.pageSizeOptions ?? DEFAULT_SIZES
  const items = Object.fromEntries(sizes.map((s) => [String(s), `${s} / 页`]))
  const cur = page.pageIndex + 1
  const last = Math.max(1, page.pageCount)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
      <span data-testid="grid-total">共 {page.totalCount} 条</span>

      <div className="flex items-center gap-3">
        <Select
          value={String(page.pageSize)}
          items={items}
          onValueChange={(v: string | null) => v && page.onPageSizeChange(Number(v))}
        >
          <SelectTrigger className="h-8 w-24" data-testid="grid-page-size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sizes.map((s) => (
              <SelectItem key={s} value={String(s)}>{s} / 页</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="tabular-nums" data-testid="grid-page-indicator">{cur} / {last}</span>

        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="size-8" aria-label="首页"
                  disabled={cur <= 1} onClick={() => page.onPageChange(0)} data-testid="grid-page-first">
            <IconChevronsLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" aria-label="上一页"
                  disabled={cur <= 1} onClick={() => page.onPageChange(page.pageIndex - 1)} data-testid="grid-page-prev">
            <IconChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" aria-label="下一页"
                  disabled={cur >= last} onClick={() => page.onPageChange(page.pageIndex + 1)} data-testid="grid-page-next">
            <IconChevronRight className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" aria-label="末页"
                  disabled={cur >= last} onClick={() => page.onPageChange(last - 1)} data-testid="grid-page-last">
            <IconChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

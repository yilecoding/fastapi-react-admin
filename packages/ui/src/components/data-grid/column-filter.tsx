"use client"

import * as React from "react"
import { IconCheck, IconSearch } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Checkbox } from "@admin/ui/components/checkbox"
import { Input } from "@admin/ui/components/input"
import { Popover, PopoverContent, PopoverTrigger } from "@admin/ui/components/popover"
import { Separator } from "@admin/ui/components/separator"
import { cn } from "@admin/ui/lib/utils"

/**
 * 列头筛选器。
 *
 * 挂在表头标题旁边的放大镜上，点开就地筛这一列 —— 和工具栏那个全局搜索是两回事：
 * 全局搜索是「在所有列里找一个词」，这个是「把这一列限定成某几个值」。
 *
 * 按列的类型给不同的 UI，类型从 `columnDef.meta.filter` 读：
 *   - `'text'`（默认）：一个输入框，模糊匹配
 *   - `'select'`：多选清单，选项从 `columnFacetingFeature` 的去重值来 ——
 *     所以候选项永远是数据里真实出现过的值，不用手写枚举
 *   - `'range'`：数值上下限
 *
 * ⚠️ 这套是**客户端筛选**，要求调用方注册了 `columnFilteringFeature` +
 * `filteredRowModel`。服务端分页的表不要开它：只会筛出当前这一页，
 * 用户看到的是「筛完只剩 3 条」而实际全库有 300 条。
 */
export type ColumnFilterKind = "text" | "select" | "range"

/**
 * 多选列要用的 filterFn。
 *
 * ⚠️ 不能靠自动推断：filterValue 是数组时 TanStack 自动挑 `arrIncludes`，
 * 那个的语义是「**单元格的数组**里包含筛选值」（用于标签列这种）。
 * 我们要的是反过来 —— 「筛选值的集合里包含单元格的值」。
 * 所以枚举列必须显式 `filterFn: facetedFilterFn`。
 */
export function facetedFilterFn(row: any, columnId: string, value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true
  return value.includes(row.getValue(columnId))
}

/**
 * 数值区间 filterFn。
 *
 * 内置的 `'inNumberRange'` 要先在 `tableFeatures()` 里注册 filterFns 才能按名字引用，
 * 为一个区间筛选多引一层不划算，直接给函数。
 */
export function rangeFilterFn(row: any, columnId: string, value: unknown): boolean {
  if (!Array.isArray(value)) return true
  const [min, max] = value as [number | undefined, number | undefined]
  const v = Number(row.getValue(columnId))
  if (min !== undefined && v < min) return false
  if (max !== undefined && v > max) return false
  return true
}

export function DataGridColumnFilter({ column }: { column: any }) {
  const kind: ColumnFilterKind = column.columnDef?.meta?.filter ?? "text"
  const value = column.getFilterValue?.()
  const active =
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-6 shrink-0", active && "text-primary")}
            aria-label="筛选"
          />
        }
        data-testid={`grid-filter-${column.id}`}
      >
        <IconSearch className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        {kind === "select" ? (
          <FacetedFilter column={column} />
        ) : kind === "range" ? (
          <RangeFilter column={column} />
        ) : (
          <TextFilter column={column} />
        )}
      </PopoverContent>
    </Popover>
  )
}

function TextFilter({ column }: { column: any }) {
  const [v, setV] = React.useState(String(column.getFilterValue?.() ?? ""))
  // 受控 prop 镜像进本地 state：输入框要能自由输入（本地 state），
  // 但外部改了值也得跟上。见 eslint.config.js 里对 set-state-in-effect 的说明。
  React.useEffect(() => setV(String(column.getFilterValue?.() ?? "")), [column])
  return (
    <Input
      autoFocus
      value={v}
      placeholder={`按${column.columnDef?.meta?.label ?? "内容"}过滤`}
      data-testid={`grid-filter-input-${column.id}`}
      onChange={(e) => {
        setV(e.target.value)
        column.setFilterValue(e.target.value || undefined)
      }}
    />
  )
}

function FacetedFilter({ column }: { column: any }) {
  // 候选值来自 facet：数据里真实出现过什么就给什么，不用维护枚举表
  const facets: Map<any, number> | undefined = column.getFacetedUniqueValues?.()
  const options = React.useMemo(
    () => [...(facets?.keys() ?? [])].filter((k) => k != null && k !== "").sort(),
    [facets]
  )
  const selected: any[] = (column.getFilterValue?.() as any[]) ?? []
  const labelOf = column.columnDef?.meta?.optionLabel as ((v: any) => string) | undefined

  const toggle = (v: any) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]
    column.setFilterValue(next.length ? next : undefined)
  }

  if (!options.length) {
    return <p className="px-1 py-6 text-center text-xs text-muted-foreground">这一列没有可筛的值</p>
  }

  return (
    <div className="flex flex-col">
      <div className="max-h-60 overflow-y-auto">
        {options.map((o) => (
          <button
            key={String(o)}
            type="button"
            onClick={() => toggle(o)}
            data-testid={`grid-filter-opt-${column.id}-${String(o)}`}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm hover:bg-muted"
          >
            <Checkbox checked={selected.includes(o)} className="pointer-events-none" tabIndex={-1} />
            <span className="flex-1 truncate">{labelOf ? labelOf(o) : String(o)}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{facets?.get(o)}</span>
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <>
          <Separator className="my-1" />
          <Button
            variant="ghost" size="sm" className="h-7 text-xs"
            data-testid={`grid-filter-clear-${column.id}`}
            onClick={() => column.setFilterValue(undefined)}
          >
            <IconCheck className="size-3.5" />清除（已选 {selected.length}）
          </Button>
        </>
      )}
    </div>
  )
}

function RangeFilter({ column }: { column: any }) {
  const [min, max] = (column.getFilterValue?.() as [number?, number?]) ?? []
  const set = (i: 0 | 1, raw: string) => {
    const n = raw === "" ? undefined : Number(raw)
    const next: [number?, number?] = i === 0 ? [n, max] : [min, n]
    column.setFilterValue(next[0] === undefined && next[1] === undefined ? undefined : next)
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number" value={min ?? ""} placeholder="最小"
        data-testid={`grid-filter-min-${column.id}`}
        onChange={(e) => set(0, e.target.value)}
      />
      <span className="text-muted-foreground">–</span>
      <Input
        type="number" value={max ?? ""} placeholder="最大"
        data-testid={`grid-filter-max-${column.id}`}
        onChange={(e) => set(1, e.target.value)}
      />
    </div>
  )
}

/**
 * data-table-base.tsx
 *
 * Reusable primitives shared by every data-table in this app.
 * Each piece accepts a TanStack Table v9 `table` instance that is
 * created by the caller — keeping column definitions, filterFns, and
 * domain state out of this file.
 *
 * Exports:
 *   DataTableColumnVisibility  – 「列」：显隐 + 拖拽排序（排序要注册 columnOrderingFeature）
 *   DataTableFacetedFilter     – multi-select faceted filter (status/plan, etc.)
 *   DataTablePagination        – rows-per-page select + page nav buttons
 *   DataTable                  – full shell: toolbar slot + table + pagination
 *   DataTableSkeletonRows      – 骨架行，供手写 <TableBody> 的树形表格复用
 *   DataTableErrorRow          – 取数失败的错误块占满一整行，供手写 <TableBody> 复用
 *                                （错误块本身在 components/query-error.tsx）
 */
import * as React from "react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { IconGripVertical, IconLayoutColumns, IconPlus, IconRotate } from "@tabler/icons-react"
import { FlexRender } from "@tanstack/react-table"
import { useT } from "../lib/i18n"
import type { Row, RowData, Table, TableFeatures } from "@tanstack/react-table"

import { Badge } from "@admin/ui/components/badge"
import { Button } from "@admin/ui/components/button"
import { Checkbox } from "@admin/ui/components/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@admin/ui/components/popover"
import { Pagination, type PaginationProps } from "@admin/ui/components/pagination"
import { QueryError, type QueryErrorProps } from "@admin/ui/components/query-error"
import { Separator } from "@admin/ui/components/separator"
import { Skeleton } from "@admin/ui/components/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@admin/ui/components/tooltip"
import {
  Table as TableRoot,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/ui/components/table"
import { cn } from "@admin/ui/lib/utils"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Broad table/row/column/header types used internally for rendering.
 * The `any` feature generic makes TanStack resolve every feature API, so all
 * methods used below (getVisibleCells, getIsSelected, getCanHide, ...) exist.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = Table<any, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Row<any, any>

/** Optional label map so callers can override ugly column IDs (e.g. "totalSpend" → "Total Spend") */
type ColumnLabelMap = Record<string, string>

// ─── DataTableColumnVisibility ────────────────────────────────────────────────

export interface DataTableColumnVisibilityProps<
  TFeatures extends TableFeatures,
  TData extends RowData,
> {
  table: Table<TFeatures, TData>
  /** Override display labels for column ids. Falls back to `col.id`. */
  columnLabels?: ColumnLabelMap
}

/**
 * 「列」：显隐 + 顺序（#11）。
 *
 * 顺序要调用方在 `tableFeatures()` 里注册 `columnOrderingFeature`；没注册的表只有显隐，
 * 拖拽手柄不渲染 —— 而不是运行时炸掉（见 ui 分册「没注册的 TanStack 特性」）。
 * 列表页把 `columnOrder` 接到 URL 上（`platform/pages/_shared/use-column-order.ts`），刷新还在。
 *
 * 只在**有 accessor、能隐藏**的那几列之间换位置：勾选列、序号、操作列留在自己的槽位上 ——
 * 照 `data-grid` 那份把固定列一股脑放到最前面的话，操作列会被挪到第一列。
 *
 * **只留图标**，全站一致：「列」是次要的工具动作（一天点不了一次），和它同排的却是「新增 / 导出」。
 *
 * ⚠️ tooltip 的 `render` 必须**直接指向 trigger**，不能套一层 `<span className="contents">` ——
 * `display:contents` 不生成布局盒，`getBoundingClientRect()` 全 0，气泡会飞到视口左上角（见 ui 分册）。
 */
export function DataTableColumnVisibility<
  TFeatures extends TableFeatures,
  TData extends RowData,
>({
  table: tableProp,
  columnLabels = {},
}: DataTableColumnVisibilityProps<TFeatures, TData>) {
  const t = useT()
  const table = tableProp as AnyTable
  // `getAllLeafColumns` 已经按当前的 columnOrder 排好了
  const leaves = table.getAllLeafColumns()
  const movable = leaves.filter((col) => typeof col.accessorFn !== "undefined" && col.getCanHide())
  const ids = movable.map((col) => col.id)
  const canOrder = typeof table.setColumnOrder === "function"
  const shown = movable.filter((col) => col.getIsVisible()).length

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    const slots = new Set(ids)
    let i = 0
    table.setColumnOrder(leaves.map((col) => (slots.has(col.id) ? next[i++] : col.id)))
  }

  const trigger = (
    <PopoverTrigger
      render={
        <Button
          variant="outline"
          size="sm"
          className="size-8 p-0"
          aria-label={t("列")}
          data-testid="column-settings"
        />
      }
    >
      <IconLayoutColumns className="size-4" />
    </PopoverTrigger>
  )

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent>{t("列")}</TooltipContent>
      </Tooltip>
      {/* `gap-0`：PopoverContent 的基础类是 `flex-col gap-4`，表头 / 分隔线 / 列表 / 底栏之间
          会各空出 16px（截图看出来的，第一列上面一条空白带） */}
      <PopoverContent align="end" className="w-60 gap-0 p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-medium">{t("列")}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {shown} / {movable.length}
          </span>
        </div>
        <Separator />
        <div className="max-h-80 overflow-y-auto overflow-x-hidden p-1" data-testid="column-list">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {movable.map((col) => (
                <ColumnSettingRow
                  key={col.id}
                  column={col}
                  label={t(columnLabels[col.id] ?? col.id)}
                  canOrder={canOrder}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <Separator />
        <div className="flex items-center justify-between gap-2 p-2">
          {canOrder ? (
            <span className="text-xs text-muted-foreground">{t("拖动调整顺序")}</span>
          ) : (
            <span />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            data-testid="columns-reset"
            onClick={() => {
              // 写空值而不是 reset*()：受控在 URL 上的表，reset 回的是 initialState，URL 不会跟着清
              table.setColumnVisibility({})
              if (canOrder) table.setColumnOrder([])
            }}
          >
            <IconRotate className="size-3.5" />
            {t("恢复默认")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ColumnSettingRow({ column, label, canOrder }: { column: any; label: string; canOrder: boolean }) {
  const t = useT()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !canOrder,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60",
        isDragging && "relative z-10 bg-muted shadow-sm"
      )}
      data-testid={`column-row-${column.id}`}
    >
      {canOrder ? (
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
          aria-label={t("拖动调整「{{name}}」的位置", { name: label })}
          data-testid={`column-drag-${column.id}`}
          {...attributes}
          {...listeners}
        >
          <IconGripVertical className="size-3.5" />
        </button>
      ) : null}
      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <Checkbox
          checked={column.getIsVisible()}
          onCheckedChange={(v) => column.toggleVisibility(v === true)}
          data-testid={`column-check-${column.id}`}
        />
        <span className="truncate">{label}</span>
      </label>
    </div>
  )
}

// ─── DataTablePagination ──────────────────────────────────────────────────────

/**
 * 分页条。实现已经搬到 `components/pagination.tsx`（全站唯一一份，
 * `data-grid` 也用它）—— 这里只留一个薄薄的名字别名，
 * 因为 15 个列表页 import 的是 `DataTablePagination`。
 */
export type DataTablePaginationProps = PaginationProps
export const DataTablePagination = Pagination

// ─── DataTableFacetedFilter ───────────────────────────────────────────────────

export interface FacetedFilterOption {
  label: string
  value: string
}

export interface DataTableFacetedFilterProps {
  /** Label shown on the trigger button and as the popover header. */
  label: string
  /** Selectable options. */
  options: FacetedFilterOption[]
  /** Currently selected values (column filter state). */
  selected: string[]
  /** Called with the new selection whenever it changes. */
  onSelectionChange: (values: string[]) => void
}

export function DataTableFacetedFilter({
  label,
  options,
  selected,
  onSelectionChange,
}: DataTableFacetedFilterProps) {
  const t = useT()
  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onSelectionChange(selected.filter((v) => v !== value))
    } else {
      onSelectionChange([...selected, value])
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 border-dashed"
          />
        }
      >
        <IconPlus className="size-3.5" />
        {label}
        {selected.length > 0 && (
          <>
            <Separator orientation="vertical" className="mx-0.5 h-4" />
            <span className="flex items-center gap-1">
              {selected.length > 1 ? (
                <Badge
                  variant="secondary"
                  className="rounded-sm px-1 text-xs font-normal"
                >
                  {t("已选 {{n}} 项", { n: selected.length })}
                </Badge>
              ) : (
                options
                  .filter((o) => selected.includes(o.value))
                  .map((o) => (
                    <Badge
                      key={o.value}
                      variant="secondary"
                      className="rounded-sm px-1 text-xs font-normal"
                    >
                      {o.label}
                    </Badge>
                  ))
              )}
            </span>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-0">
        <div className="border-b px-2 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        <div className="p-1">
          {options.map((option) => {
            const checked = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => toggle(option.value)}
                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm capitalize transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
              >
                <div
                  className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input"
                  }`}
                >
                  {checked && (
                    <svg
                      className="size-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>
                {option.label}
              </button>
            )
          })}
        </div>
        {selected.length > 0 && (
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => onSelectionChange([])}
              className="flex w-full cursor-default items-center justify-center rounded-sm px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none"
            >
              {t("清除筛选")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ─── DataTableSkeletonRows ────────────────────────────────────────────────────

export interface DataTableSkeletonRowsProps {
  rows: number
  columns: number
}

/**
 * 表体骨架行。放在 `<TableBody>` 里用，**表头与工具栏保持渲染** ——
 * 这样加载完成时只有行内容替换，筛选栏和列宽都不跳。
 */
export function DataTableSkeletonRows({
  rows,
  columns,
}: DataTableSkeletonRowsProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r} data-testid="table-skeleton-row">
          {Array.from({ length: columns }).map((__, c) => (
            <TableCell key={c}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

// ─── DataTableErrorRow ────────────────────────────────────────────────────────

export interface DataTableErrorRowProps extends QueryErrorProps {
  /** 表格列数 —— 错误块横跨整行 */
  columnCount: number
}

/**
 * 取数失败的错误块占满一整行。手写 `<TableBody>` 的树形表格（部门 / 菜单）用它，
 * 位置在原来那个「没有匹配的 xxx」空态分支**之前** —— 顺序反了就又把失败画成空态。
 */
export function DataTableErrorRow({ columnCount, ...rest }: DataTableErrorRowProps) {
  return (
    <TableRow>
      <TableCell colSpan={columnCount} className="p-3">
        <QueryError {...rest} />
      </TableCell>
    </TableRow>
  )
}

// ─── DataTable (full shell) ───────────────────────────────────────────────────

export interface DataTableProps<
  TFeatures extends TableFeatures,
  TData extends RowData,
> {
  table: Table<TFeatures, TData>
  /**
   * The rows to render in the table body. Pass your already-paginated,
   * already-filtered rows here so the shell stays generic.
   */
  rows: Row<TFeatures, TData>[]
  /** Number of columns — used for the empty-state colspan. */
  columnCount: number
  /** Toolbar content rendered above the table (search, faceted filters, etc.) */
  toolbar?: React.ReactNode
  /**
   * 工具栏右侧、「列」下拉左边的动作区（新增 / 导出这类页面主动作）。
   * 放这里而不是单独占一行 —— 页名已经在 tab 上，顶部不该再有一条只有一个按钮的空行。
   */
  actions?: React.ReactNode
  /** Rendered inside each TableRow — defaults to standard FlexRender cells. */
  renderRow?: (row: Row<TFeatures, TData>) => React.ReactNode
  /** 额外挂到每个 <TableRow> 上的属性（如 data-testid），便于测试定位行 */
  rowAttributes?: (row: Row<TFeatures, TData>) => Record<string, string | undefined>
  /** Text shown when `rows` is empty. */
  emptyMessage?: string
  /**
   * 空态下 emptyMessage 底下的动作区（如「清除筛选」按钮）。
   * 空列表最常见的成因就是筛选太窄 —— 让用户在原地退出来，别逼他回工具栏找。
   */
  emptyAction?: React.ReactNode
  /** Pagination props. When omitted the pagination bar is not rendered. */
  pagination?: DataTablePaginationProps
  /** Column label overrides forwarded to DataTableColumnVisibility. */
  columnLabels?: ColumnLabelMap
  /** When true the column-visibility dropdown is shown in the toolbar's right side. Default: true */
  showColumnVisibility?: boolean
  /** Extra classes for the table body (e.g. per-column sizing for drag handles). */
  tableBodyClassName?: string
  /**
   * 首屏加载中 —— 表体渲染骨架行，但**工具栏与表头保持在位**。
   * 整块替换成骨架会让筛选栏在加载完成时凭空出现，视觉上有跳动。
   */
  loading?: boolean
  /** 骨架行数，默认 6 */
  skeletonRows?: number
  /**
   * 后台正在取数（服务端翻页/筛选的中间态）。
   * 只做整体降透明 + aria-busy，**不拦点击** —— 后台静默 refetch 时行操作仍应可用。
   */
  busy?: boolean
  /**
   * 主查询的错误（`useQuery` 的 `error` 原样传进来，没错就是 `null`/`undefined`）。
   *
   * 🔴 传了它才不会把失败伪装成空态（硬纪律 9）。两种渲染：
   * - 没有可显示的行 → 错误块**替换**表体，不再出现「暂无数据」
   * - 还有上一次成功的行（`placeholderData` 保留的）→ 行照常显示，
   *   错误块作为横幅挂在表格上方，别把用户正在看的数据抽走
   */
  error?: unknown
  /** 错误块上的「重试」（通常是 `refetch`）。不传就只显示错误，不给入口 */
  onRetry?: () => void
}

export function DataTable<
  TFeatures extends TableFeatures,
  TData extends RowData,
>({
  table: tableProp,
  rows,
  columnCount,
  toolbar,
  actions,
  renderRow,
  rowAttributes,
  emptyMessage,
  emptyAction,
  pagination,
  columnLabels,
  showColumnVisibility = true,
  tableBodyClassName,
  loading = false,
  skeletonRows = 6,
  busy = false,
  error,
  onRetry,
}: DataTableProps<TFeatures, TData>) {
  const t = useT()
  const table = tableProp as AnyTable
  // 有错但上一次的行还在（翻页失败那种）→ 行留着，错误挂成横幅
  const errorBanner = Boolean(error) && rows.length > 0
  return (
    /*
     * `content-scroll:` 那几条 = 「内容区滚动」模式下把自己变成**定高的表格视区**：
     * 工具栏 / 表头 / 分页条钉住，只有表格行滚。
     *
     * 为什么可以无条件写、不用 fill 之类的开关：这些类只在**祖先真的定了高**时才有效。
     * 页面容器高度是 auto 时（整页滚动模式，以及嵌在卡片/面板里的那几张表），
     * `flex-1` 在自动高度的列向 flex 里退化成「按内容撑开」、`min-h-0` 只是去掉一个下限、
     * `overflow-y-auto` 因为内容刚好装得下所以不出滚动条 —— 三条全是空操作。
     * 于是「谁要变成视区」只由**页面那一层**决定（给最外层块加
     * `content-scroll:min-h-0 content-scroll:flex-1`），这里不用知道调用方是谁。
     */
    <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
      {/* ── Toolbar ── */}
      {(toolbar || actions || showColumnVisibility) && (
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {showColumnVisibility && (
              <DataTableColumnVisibility
                table={table}
                columnLabels={columnLabels}
              />
            )}
          </div>
        </div>
      )}

      {/* ── 错误横幅 ── 还有旧数据可看时用这一条，不动表体 */}
      {errorBanner && (
        <QueryError error={error} onRetry={onRetry} className="shrink-0" />
      )}

      {/* ── Table ── */}
      {/* 宽表要横向滚动，不能 overflow-hidden —— 那会把最右侧的操作列裁掉，用户点不到行操作 */}
      <div
        className={`overflow-x-auto rounded-lg border transition-opacity content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col ${busy ? "opacity-60" : ""}`}
        aria-busy={loading || busy}
        data-busy={busy || undefined}
      >
        <TableRoot>
          {/* sticky 表头：`border-collapse: collapse`（Tailwind preflight 设的）下
              thead 那条 border-b 会跟着内容滚走 —— 用 inset 阴影补一条不会滚的分隔线。
              `bg-muted` 是必须的，透明表头会让滚上来的行从底下透出来。 */}
          <TableHeader className="sticky top-0 z-10 bg-muted shadow-[inset_0_-1px_0_var(--border)]">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} colSpan={header.colSpan}>
                    {header.isPlaceholder ? null : (
                      <FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className={tableBodyClassName}>
            {loading ? (
              <DataTableSkeletonRows rows={skeletonRows} columns={columnCount} />
            ) : error && !rows.length ? (
              /* 🔴 这一支必须排在空态**前面** —— 否则失败会渲染成「暂无数据」 */
              <DataTableErrorRow columnCount={columnCount} error={error} onRetry={onRetry} />
            ) : rows.length ? (
              rows.map((row) =>
                renderRow ? (
                  <React.Fragment key={row.id}>{renderRow(row)}</React.Fragment>
                ) : (
                  <TableRow
                    key={row.id}
                    /* 🔴 `?.()` 不是防御性写法，是必需的：TanStack v9 是
                       tree-shaken 的，没注册 `rowSelectionFeature` 的表上
                       **根本没有** `getIsSelected`。而上面那个 `AnyRow` 断言
                       （`Row<any, any>`）让 TS 认为所有特性的方法都在，
                       于是这条 `TypeError: row.getIsSelected is not a function`
                       类型检查一路绿、渲染时整张表白屏。
                       消息中心（没有批量动作，故意不注册行选中）第一次跑就踩到。 */
                    data-state={(row as AnyRow).getIsSelected?.() && "selected"}
                    {...rowAttributes?.(row)}
                  >
                    {(row as AnyRow).getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                )
              )
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columnCount}
                  className="h-24 text-center text-muted-foreground"
                >
                  <div className="flex flex-col items-center gap-2">
                    <span>{emptyMessage ?? t("暂无数据")}</span>
                    {emptyAction}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </TableRoot>
      </div>

      {/* ── Pagination ── */}
      {pagination && <DataTablePagination {...pagination} />}
    </div>
  )
}

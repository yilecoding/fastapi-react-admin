"use client"

import * as React from "react"
import { FlexRender } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { IconChevronRight, IconGripVertical, IconInbox } from "@tabler/icons-react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@admin/ui/components/context-menu"
import { Skeleton } from "@admin/ui/components/skeleton"
import {
  Table as TableRoot,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/ui/components/table"
import { cn } from "@admin/ui/lib/utils"

import { DataGridBulkBar } from "./bulk-bar"
import { cellStyle, pinnedClass } from "./columns"
import { DataGridColumnFilter } from "./column-filter"
import { GRID_DENSITY, type GridDensity } from "./density"
import { DataGridPagination, type GridPagination } from "./pagination"
import { DataGridToolbar, type GridToolbarCaps } from "./toolbar"
import { useGridView } from "./use-grid-view"

export type DataGridProps = {
  /** 调用方自己 useTable() 出来的实例 —— 列定义、features、状态都归调用方 */
  table: any
  /** 要渲染的行。不传就用 table.getRowModel().rows */
  rows?: any[]

  // ── 数据态 ────────────────────────────────────────────────────────────────
  loading?: boolean
  /** 后台取数中：整表降透明 + aria-busy，但表头工具栏留在原位 */
  busy?: boolean
  emptyMessage?: React.ReactNode

  // ── 外观（可持久化的个人偏好） ─────────────────────────────────────────────
  storageKey?: string
  defaultDensity?: GridDensity
  defaultStriped?: boolean
  defaultBordered?: boolean

  // ── 能力开关 ──────────────────────────────────────────────────────────────
  caps?: GridToolbarCaps
  /** 行数超过 threshold 才真正启用虚拟滚动 —— 小表虚拟化只会更慢 */
  virtual?: { enabled?: boolean; threshold?: number; overscan?: number; maxHeight?: number }
  keyboardNav?: boolean
  showFooter?: boolean
  /** 传了就启用行拖拽排序 */
  onRowReorder?: (activeId: string, overId: string) => void
  /** 表头拖拽换列序（需要 columnOrderingFeature） */
  columnDrag?: boolean
  /** 列头筛选器（需要 columnFilteringFeature + filteredRowModel；服务端分页别开） */
  columnFilters?: boolean
  /**
   * 按列的行展开。
   *
   * 和 `renderSubRow` 的单一展开不同：这里每个登记的列在自己的单元格里带一个箭头，
   * 点开渲染**这一列专属**的详情。同一行同时只开一个 —— 点用户列开用户档案，
   * 再点团队列，用户档案自动收起换成团队详情。
   */
  expandableColumns?: Record<string, (row: any) => React.ReactNode>

  // ── 插槽 ──────────────────────────────────────────────────────────────────
  /** 工具栏左侧：业务筛选 */
  toolbar?: React.ReactNode
  /** 工具栏右侧：主操作按钮（新增之类） */
  actions?: React.ReactNode
  columnLabels?: Record<string, string>
  /** 行右键菜单内容；不传就不启用右键 */
  contextMenu?: (row: any) => React.ReactNode
  /** 行展开后的详情区；配合 rowExpandingFeature 用 */
  renderSubRow?: (row: any) => React.ReactNode
  /** 底部浮动批量条的内容；选中 0 行时不渲染 */
  bulkActions?: (rows: any[]) => React.ReactNode

  // ── 交互回调 ──────────────────────────────────────────────────────────────
  onRowActivate?: (row: any) => void
  onRefresh?: () => void
  refreshing?: boolean
  search?: string
  onSearchChange?: (v: string) => void
  searchPlaceholder?: string

  pagination?: GridPagination
  className?: string
}

const DEFAULT_CAPS: GridToolbarCaps = {
  search: false,
  density: true,
  columnSettings: true,
  refresh: false,
  clearFilters: false,
  expandToggle: false,
  fullscreen: true,
}

/**
 * DataGrid —— 全能力表格外壳。
 *
 * 和旧的 `DataTable` 的分工：`DataTable` 是「够用就好」的列表壳子，
 * 这个是把 TanStack v9 的能力铺满的那一版（固定列、行置顶、分组、
 * 虚拟滚动、行拖拽、右键菜单、键盘导航、页脚聚合）。
 *
 * 设计上只有一条硬规矩：**组件不持有业务状态**。
 * 列定义、features 注册、筛选值、分页参数全在调用方；这里只管
 * 「怎么把它们画出来」和「外观偏好」。所以同一个 grid 既能配服务端分页，
 * 也能配一次性 1000 行全量滚动，取决于调用方注册了哪些 feature。
 */
export function DataGrid({
  table,
  rows: rowsProp,
  loading,
  busy,
  emptyMessage = "暂无数据",
  storageKey,
  defaultDensity,
  defaultStriped,
  defaultBordered,
  caps: capsProp,
  virtual,
  keyboardNav,
  showFooter,
  onRowReorder,
  columnDrag,
  columnFilters,
  expandableColumns,
  toolbar,
  actions,
  columnLabels,
  contextMenu,
  renderSubRow,
  bulkActions,
  onRowActivate,
  onRefresh,
  refreshing,
  search,
  onSearchChange,
  searchPlaceholder,
  pagination,
  className,
}: DataGridProps) {
  const caps = { ...DEFAULT_CAPS, ...capsProp }
  const [view, setView] = useGridView(storageKey, {
    density: defaultDensity,
    striped: defaultStriped,
    bordered: defaultBordered,
  })
  const [fullscreen, setFullscreen] = React.useState(false)

  const d = GRID_DENSITY[view.density] ?? GRID_DENSITY.standard
  const model = table.getRowModel()
  const rows: any[] = rowsProp ?? model.rows
  const leafCount = table.getVisibleLeafColumns?.().length ?? 1

  // 行置顶：TanStack 的 rowPinningFeature 把行拆成 top / center / bottom 三段
  const hasPinning = typeof table.getTopRows === "function"
  const topRows: any[] = hasPinning ? table.getTopRows() : []
  const bottomRows: any[] = hasPinning ? table.getBottomRows() : []
  const centerRows: any[] = hasPinning && !rowsProp ? table.getCenterRows() : rows

  const selected = table.getSelectedRowModel?.()?.rows ?? []

  // ── 虚拟滚动 ────────────────────────────────────────────────────────────────
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const virtualOn =
    Boolean(virtual?.enabled) && centerRows.length >= (virtual?.threshold ?? 80)
  // @tanstack/react-virtual 的 useVirtualizer 在内部改自己的实例，React Compiler
  // 的规则因此跳过这一段编译。那是库的实现方式，不是这里能改的，而虚拟滚动没有替代品。
  //
  // ⚠️ 下面那条 disable 必须**单独一行、紧贴代码** —— `eslint-disable-next-line`
  // 只作用于紧邻的下一行，写成多行注释的第一行会落到第二行注释上（然后报
  // 「Unused eslint-disable directive」，而真正的告警照旧）。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtualOn ? centerRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => d.rowHeight,
    overscan: virtual?.overscan ?? 12,
  })
  const vItems = virtualOn ? virtualizer.getVirtualItems() : []
  const padTop = virtualOn && vItems.length ? vItems[0]!.start : 0
  const padBottom =
    virtualOn && vItems.length
      ? virtualizer.getTotalSize() - vItems[vItems.length - 1]!.end
      : 0
  const bodyRows = virtualOn ? vItems.map((v) => centerRows[v.index]) : centerRows

  // ── 键盘导航 ────────────────────────────────────────────────────────────────
  const [focus, setFocus] = React.useState<{ r: number; c: number } | null>(null)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!keyboardNav || bodyRows.length === 0) return
    const cur = focus ?? { r: 0, c: 0 }
    const move = (dr: number, dc: number) => {
      e.preventDefault()
      setFocus({
        r: Math.max(0, Math.min(bodyRows.length - 1, cur.r + dr)),
        c: Math.max(0, Math.min(leafCount - 1, cur.c + dc)),
      })
    }
    if (e.key === "ArrowDown") move(1, 0)
    else if (e.key === "ArrowUp") move(-1, 0)
    else if (e.key === "ArrowRight") move(0, 1)
    else if (e.key === "ArrowLeft") move(0, -1)
    else if (e.key === "Enter" && focus) { e.preventDefault(); onRowActivate?.(bodyRows[focus.r]) }
    else if (e.key === " " && focus) { e.preventDefault(); bodyRows[focus.r]?.toggleSelected?.() }
  }

  // ── 列拖拽（原生 HTML5 DnD：表头是 <th>，套 dnd-kit 反而要拆表格结构） ──────────
  const colDragOn = Boolean(columnDrag) && typeof table.setColumnOrder === "function"
  const dragCol = React.useRef<string | null>(null)
  /** 正在拖列宽 —— 用来挡住表头的原生拖拽，两者会抢同一串鼠标事件 */
  const resizing = React.useRef(false)
  const moveColumn = React.useCallback(
    (from: string | null, to: string) => {
      if (!from || from === to) return
      const order: string[] = table.getAllLeafColumns().map((c: any) => c.id)
      const f = order.indexOf(from)
      const t = order.indexOf(to)
      if (f < 0 || t < 0) return
      order.splice(t, 0, ...order.splice(f, 1))
      table.setColumnOrder(order)
      dragCol.current = null
    },
    [table]
  )

  // ── 按列展开：每行记住「当前开着哪一列的详情」，同一行互斥 ────────────────────
  const [openCol, setOpenCol] = React.useState<Record<string, string>>({})
  const toggleColExpand = React.useCallback((rowId: string, colId: string) => {
    setOpenCol((m) => (m[rowId] === colId ? omit(m, rowId) : { ...m, [rowId]: colId }))
  }, [])

  // ── 行拖拽 ──────────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const dragOn = Boolean(onRowReorder) && !virtualOn
  const dragIds = React.useMemo(() => bodyRows.map((r) => r?.id).filter(Boolean), [bodyRows])
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (over && active.id !== over.id) onRowReorder?.(String(active.id), String(over.id))
  }

  const rowProps = {
    density: d,
    striped: view.striped,
    bordered: view.bordered,
    contextMenu,
    renderSubRow,
    leafCount,
    focus,
    setFocus,
    keyboardNav,
    onRowActivate,
    dragOn,
    expandableColumns,
    openCol,
    toggleColExpand,
  }

  const body = (
    <>
      {loading ? (
        Array.from({ length: 8 }).map((_, i) => (
          <TableRow key={`sk-${i}`}>
            {Array.from({ length: leafCount }).map((__, j) => (
              <TableCell key={j} className={d.cell}>
                <Skeleton className="h-4 w-full" />
              </TableCell>
            ))}
          </TableRow>
        ))
      ) : rows.length === 0 && topRows.length === 0 ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={leafCount} className="h-40">
            <span className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <IconInbox className="size-8" />
              <span className="text-sm">{emptyMessage}</span>
            </span>
          </TableCell>
        </TableRow>
      ) : (
        <>
          {topRows.map((r, i) => <GridRow key={`t-${r.id}`} row={r} index={i} pinnedEdge="top" {...rowProps} />)}
          {padTop > 0 && <tr style={{ height: padTop }} aria-hidden />}
          {bodyRows.map((r, i) => <GridRow key={r.id} row={r} index={i} {...rowProps} />)}
          {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden />}
          {bottomRows.map((r, i) => <GridRow key={`b-${r.id}`} row={r} index={i} pinnedEdge="bottom" {...rowProps} />)}
        </>
      )}
    </>
  )

  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        fullscreen && "fixed inset-0 z-50 overflow-auto bg-background p-4",
        className
      )}
      data-testid="data-grid"
      data-density={view.density}
      data-fullscreen={fullscreen}
    >
      <DataGridToolbar
        table={table}
        caps={caps}
        columnLabels={columnLabels}
        density={view.density}
        onDensityChange={(density) => setView({ density })}
        search={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={searchPlaceholder}
        onRefresh={onRefresh}
        refreshing={refreshing}
        fullscreen={fullscreen}
        onFullscreenChange={setFullscreen}
        actions={actions}
      >
        {toolbar}
      </DataGridToolbar>

      <div
        ref={scrollRef}
        className={cn(
          "relative overflow-auto rounded-lg transition-opacity",
          view.bordered && "border",
          busy && !loading && "opacity-60"
        )}
        style={virtualOn ? { maxHeight: virtual?.maxHeight ?? 520 } : undefined}
        aria-busy={busy}
        tabIndex={keyboardNav ? 0 : undefined}
        onKeyDown={onKeyDown}
        data-testid="grid-scroll"
      >
        <TableRoot className="table-fixed">
          <TableHeader className="sticky top-0 z-20 bg-muted">
            {table.getHeaderGroups().map((hg: any) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h: any) => (
                  <TableHead
                    key={h.id}
                    colSpan={h.colSpan}
                    style={cellStyle(h.column)}
                    draggable={colDragOn && h.column.getCanHide?.() !== false}
                    onDragStart={colDragOn ? (e: React.DragEvent) => {
                      if (resizing.current) { e.preventDefault(); return }
                      dragCol.current = h.column.id
                    } : undefined}
                    onDragOver={colDragOn ? (e: React.DragEvent) => e.preventDefault() : undefined}
                    onDrop={colDragOn ? () => moveColumn(dragCol.current, h.column.id) : undefined}
                    className={cn(
                      d.head, "group/head relative bg-muted whitespace-nowrap",
                      colDragOn && "cursor-grab",
                      pinnedClass(h.column)
                    )}
                  >
                    {h.isPlaceholder ? null : (
                      <span className="inline-flex items-center gap-0.5">
                        <FlexRender header={h} />
                        {columnFilters && h.column.getCanFilter?.() && (
                          <DataGridColumnFilter column={h.column} />
                        )}
                      </span>
                    )}
                    {h.column.getCanResize?.() && (
                      <button
                        type="button"
                        aria-label={`调整列宽：${h.column.id}`}
                        data-column-resize=""
                        // ⚠️ 必须 draggable={false}：表头开了列拖拽后是原生 draggable，
                        // 从手柄按下去会被 HTML5 拖拽劫持，resize 的 mousemove 一个都收不到
                        draggable={false}
                        data-testid={`grid-resize-${h.column.id}`}
                        onPointerDown={(e: React.PointerEvent) => {
                          e.stopPropagation()
                          resizing.current = true
                          h.getResizeHandler?.()(e)
                        }}
                        onPointerUp={() => { resizing.current = false }}
                        onDoubleClick={() => h.column.resetSize?.()}
                        className="absolute inset-y-0 -end-1 z-10 w-2 cursor-col-resize touch-none opacity-0 group-hover/head:opacity-100"
                      >
                        <span className="mx-auto block h-full w-px bg-border" />
                      </button>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {dragOn ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={dragIds} strategy={verticalListSortingStrategy}>
                  {body}
                </SortableContext>
              </DndContext>
            ) : (
              body
            )}
          </TableBody>

          {showFooter && !loading && rows.length > 0 && (
            <TableFooter className="sticky bottom-0 z-10">
              {table.getFooterGroups().map((fg: any) => (
                <TableRow key={fg.id} className="hover:bg-transparent">
                  {fg.headers.map((h: any) => (
                    <TableCell
                      key={h.id}
                      style={cellStyle(h.column)}
                      className={cn(d.cell, "text-xs font-medium", pinnedClass(h.column))}
                    >
                      {h.isPlaceholder ? null : (
                        <FlexRender footer={h} />
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableFooter>
          )}
        </TableRoot>
      </div>

      {bulkActions && selected.length > 0 && (
        <DataGridBulkBar
          count={selected.length}
          total={pagination?.totalCount}
          onClear={() => table.resetRowSelection?.()}
        >
          {bulkActions(selected)}
        </DataGridBulkBar>
      )}

      {pagination && <DataGridPagination page={pagination} />}
    </div>
  )
}

function omit(map: Record<string, string>, key: string) {
  const next = { ...map }
  delete next[key]
  return next
}

// ─── 行 ────────────────────────────────────────────────────────────────────────

function GridRow(props: any) {
  // 拖拽版和普通版拆成两个组件：同一行上调两次 useSortable 会互相打架，
  // 而把 useSortable 写成条件调用又会违反 hook 规则。按 dragOn 换组件类型，
  // 切换时整批行重挂，是这里唯一干净的做法。
  return props.dragOn ? <SortableGridRow {...props} /> : <PlainGridRow {...props} />
}

function SortableGridRow(props: any) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.row.id,
  })
  return (
    <PlainGridRow
      {...props}
      rowRef={setNodeRef}
      rowStyle={{ transform: CSS.Translate.toString(transform), transition }}
      rowExtraClass={isDragging ? "relative z-10 bg-background shadow-md" : undefined}
      handleProps={{ ...attributes, ...listeners }}
    />
  )
}

function PlainGridRow({
  row, index, density, striped, bordered, contextMenu, renderSubRow, leafCount,
  focus, setFocus, keyboardNav, onRowActivate, pinnedEdge,
  rowRef, rowStyle, rowExtraClass, handleProps,
  expandableColumns, openCol, toggleColExpand,
}: any) {
  // 分组行：整行合并成一个「分组名 + 计数」的抬头
  if (row.getIsGrouped?.()) {
    return (
      <TableRow className="bg-muted/40 hover:bg-muted/40" data-testid={`grid-group-${row.id}`}>
        <TableCell colSpan={leafCount} className={cn(density.cell, "font-medium")}>
          <button
            type="button"
            onClick={row.getToggleExpandedHandler()}
            className="flex items-center gap-1.5 text-sm"
          >
            <IconChevronRight
              className={cn("size-3.5 transition-transform", row.getIsExpanded() && "rotate-90")}
            />
            {String(row.groupingValue ?? "")}
            <span className="text-xs text-muted-foreground">（{row.subRows?.length ?? 0}）</span>
          </button>
        </TableCell>
      </TableRow>
    )
  }

  const inner = (
    <>
      {row.getVisibleCells().map((cell: any, ci: number) => {
        const focused = keyboardNav && focus?.r === index && focus?.c === ci
        return (
          <TableCell
            key={cell.id}
            style={cellStyle(cell.column)}
            onClick={keyboardNav ? () => setFocus({ r: index, c: ci }) : undefined}
            className={cn(
              density.cell,
              "relative",
              bordered && "border-e last:border-e-0",
              pinnedClass(cell.column),
              focused && "outline outline-2 -outline-offset-2 outline-primary"
            )}
          >
            {ci === 0 && handleProps && <DragHandle id={row.id} handleProps={handleProps} />}
            {expandableColumns?.[cell.column.id] ? (
              <span className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={openCol?.[row.id] === cell.column.id ? "收起详情" : "展开详情"}
                  aria-expanded={openCol?.[row.id] === cell.column.id}
                  data-testid={`grid-colexpand-${cell.column.id}-${row.id}`}
                  onClick={(e) => { e.stopPropagation(); toggleColExpand(row.id, cell.column.id) }}
                  className="grid size-5 shrink-0 place-content-center rounded-sm text-muted-foreground hover:bg-muted"
                >
                  <IconChevronRight
                    className={cn("size-3.5 transition-transform", openCol?.[row.id] === cell.column.id && "rotate-90")}
                  />
                </button>
                <FlexRender cell={cell} />
              </span>
            ) : (
              <FlexRender cell={cell} />
            )}
          </TableCell>
        )
      })}
    </>
  )

  const rowCls = cn(
    striped && index % 2 === 1 && "bg-muted/30",
    row.getIsSelected?.() && "bg-primary/5",
    pinnedEdge && "bg-amber-500/10",
    onRowActivate && "cursor-pointer",
    rowExtraClass
  )

  const body = contextMenu ? (
    <ContextMenu>
      <ContextMenuTrigger
        render={<TableRow ref={rowRef} style={rowStyle} className={rowCls} data-testid={`grid-row-${row.id}`} />}
        onDoubleClick={() => onRowActivate?.(row)}
      >
        {inner}
      </ContextMenuTrigger>
      <ContextMenuContent>{contextMenu(row)}</ContextMenuContent>
    </ContextMenu>
  ) : (
    <TableRow
      ref={rowRef}
      style={rowStyle}
      className={rowCls}
      data-testid={`grid-row-${row.id}`}
      onDoubleClick={() => onRowActivate?.(row)}
    >
      {inner}
    </TableRow>
  )

  const openColId: string | undefined = openCol?.[row.id]
  const colDetail = openColId ? expandableColumns?.[openColId] : undefined

  return (
    <>
      {body}
      {colDetail && (
        <TableRow className="hover:bg-transparent" data-testid={`grid-coldetail-${openColId}-${row.id}`}>
          <TableCell colSpan={leafCount} className="bg-muted/20 p-0">
            {colDetail(row)}
          </TableCell>
        </TableRow>
      )}
      {!colDetail && renderSubRow && row.getIsExpanded?.() && !row.getIsGrouped?.() && (
        <TableRow className="hover:bg-transparent" data-testid={`grid-subrow-${row.id}`}>
          <TableCell colSpan={leafCount} className="bg-muted/20 p-0">
            {renderSubRow(row)}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function DragHandle({ id, handleProps }: { id: string; handleProps: any }) {
  return (
    <button
      type="button"
      className="me-1 cursor-grab align-middle text-muted-foreground active:cursor-grabbing"
      aria-label="拖动排序"
      data-testid={`grid-drag-${id}`}
      {...handleProps}
    >
      <IconGripVertical className="inline size-3.5" />
    </button>
  )
}

export { DataGridBulkBar }
export { DataGridPagination, type GridPagination } from "./pagination"
export { DataGridToolbar, type GridToolbarCaps } from "./toolbar"
export { DataGridColumnSettings } from "./column-settings"
export { DataGridColumnFilter, facetedFilterFn, rangeFilterFn, type ColumnFilterKind } from "./column-filter"
export { GRID_DENSITY, GRID_DENSITIES, type GridDensity } from "./density"
export { useGridView, type GridView } from "./use-grid-view"
export {
  buildGridSelectColumn,
  buildGridRowNumberColumn,
  buildGridExpandColumn,
  GridCell,
  GridActions,
  getPinnedStyle,
  pinnedClass,
} from "./columns"

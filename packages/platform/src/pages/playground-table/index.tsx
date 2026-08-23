import * as React from 'react'
import {
  columnFacetingFeature,
  columnFilteringFeature,
  columnGroupingFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createExpandedRowModel,
  createFacetedMinMaxValues,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createGroupedRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowAggregationFeature,
  rowExpandingFeature,
  rowPaginationFeature,
  rowPinningFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import {
  IconArrowDown, IconArrowUp, IconArrowsSort, IconCopy, IconEye, IconPin, IconPinnedOff,
  IconTrash,
} from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Card, CardContent } from '@admin/ui/components/card'
import {
  ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator,
} from '@admin/ui/components/context-menu'
import {
  DataGrid, GridActions, GridCell, facetedFilterFn, rangeFilterFn,
  buildGridExpandColumn, buildGridRowNumberColumn, buildGridSelectColumn,
} from '@admin/ui/components/data-grid'
import { Label } from '@admin/ui/components/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import { Separator } from '@admin/ui/components/separator'
import { Switch } from '@admin/ui/components/switch'
import { cn } from '@admin/ui/lib/utils'

import { PageHeader } from '../../shell/page-header'
import { StatusPill } from '../_shared/status'
import { STATUS_META, makeDemoRows, type DemoRow } from './data'

/**
 * DataTable 能力实验台。
 *
 * 一页里把 `DataGrid` 的每项能力都挂上开关，1000 行数据下逐个开关看效果 ——
 * 这页本身不是业务页，它的价值在于：任何人要给某个列表加能力之前，
 * 先在这里点一遍，就知道打开之后长什么样、和别的能力冲不冲突。
 */

// v9 是 tree-shaken 的：用到哪个能力就得注册哪个，row model 也一并塞进 tableFeatures
const features = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnFilteringFeature,
  columnFacetingFeature,
  globalFilteringFeature,
  columnGroupingFeature,
  rowAggregationFeature,
  rowExpandingFeature,
  rowPaginationFeature,
  rowPinningFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  facetedRowModel: createFacetedRowModel(),
  // 列头筛选的候选项来自这两个：不注册的话 getFacetedUniqueValues() 永远是空 Map
  facetedUniqueValues: createFacetedUniqueValues(),
  facetedMinMaxValues: createFacetedMinMaxValues(),
  groupedRowModel: createGroupedRowModel(),
  sortedRowModel: createSortedRowModel(),
  expandedRowModel: createExpandedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
})

const col = createColumnHelper<typeof features, DemoRow>()

type Caps = {
  loading: boolean
  paginated: boolean
  virtual: boolean
  keyboard: boolean
  contextMenu: boolean
  bulkBar: boolean
  select: boolean
  rowNumber: boolean
  expand: boolean
  rowDrag: boolean
  colDrag: boolean
  colFilter: boolean
  colExpand: boolean
  resize: boolean
  footer: boolean
  search: boolean
  refresh: boolean
  clearFilters: boolean
  expandToggle: boolean
  fullscreen: boolean
}

const DEFAULT_CAPS: Caps = {
  loading: false, paginated: true, virtual: false, keyboard: true,
  contextMenu: true, bulkBar: true, select: true, rowNumber: true,
  expand: false, rowDrag: false, colDrag: true, colFilter: true,
  colExpand: true, resize: true, footer: true, search: true,
  refresh: true, clearFilters: true, expandToggle: true, fullscreen: true,
}

const GROUPS: { key: keyof Caps; label: string; hint: string }[][] = [
  [
    { key: 'loading', label: '加载态', hint: '覆盖表格加载状态' },
    { key: 'paginated', label: '分页模式', hint: '关掉即全量滚动' },
    { key: 'virtual', label: '虚拟滚动', hint: '大数据量只渲染可视区（需先关分页）' },
    { key: 'keyboard', label: '键盘导航', hint: '方向键移动、回车打开、空格选中' },
    { key: 'contextMenu', label: '右键菜单', hint: '行级上下文菜单' },
    { key: 'bulkBar', label: '批量操作条', hint: '选中后底部浮条' },
  ],
  [
    { key: 'select', label: '多选列', hint: '行选择' },
    { key: 'rowNumber', label: '序号列', hint: '跨页连续序号' },
    { key: 'expand', label: '独立展开列', hint: '单独一列放箭头，全行一个详情' },
    { key: 'colExpand', label: '按列展开', hint: '用户/团队列各带箭头，各自的详情，行内互斥' },
    { key: 'colFilter', label: '列头筛选', hint: '文本列输入框、枚举列多选（客户端筛选）' },
    { key: 'resize', label: '列宽拖拽', hint: '表头右缘拖动，双击复位' },
    { key: 'colDrag', label: '列拖拽', hint: '拖表头换列序' },
    { key: 'rowDrag', label: '行拖拽', hint: '当前可视集合内排序（与虚拟滚动互斥）' },
    { key: 'footer', label: '页脚聚合', hint: '合计与均值' },
  ],
  [
    { key: 'search', label: '全局搜索', hint: '工具栏搜索框' },
    { key: 'refresh', label: '刷新按钮', hint: '重新生成数据' },
    { key: 'clearFilters', label: '清筛选', hint: '一键清空筛选' },
    { key: 'expandToggle', label: '展开切换', hint: '全部展开 / 折叠' },
    { key: 'fullscreen', label: '全屏', hint: '表格区域全屏' },
  ],
]

export function PlaygroundTablePage() {
  const [caps, setCaps] = React.useState<Caps>(DEFAULT_CAPS)
  const [seed, setSeed] = React.useState(0)
  const [grouping, setGrouping] = React.useState<string[]>([])
  const [sorting, setSorting] = React.useState<any[]>([])
  const [globalFilter, setGlobalFilter] = React.useState('')
  const [rowSelection, setRowSelection] = React.useState({})
  const [expanded, setExpanded] = React.useState<any>({})
  const [rowPinning, setRowPinning] = React.useState<any>({ top: [], bottom: [] })
  const [columnPinning, setColumnPinning] = React.useState<any>({ start: ['__select__', '__index__'], end: ['actions'] })
  const [columnVisibility, setColumnVisibility] = React.useState({})
  const [columnOrder, setColumnOrder] = React.useState<string[]>([])
  const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: 20 })
  // 列宽要两份 state：columnSizing 是「最终宽度」，columnResizing 是「正在拖的那一下」。
  // 只接前者的话，onChange 模式下拖动过程不跟手，松手才跳一次。
  const [columnSizing, setColumnSizing] = React.useState({})
  const [columnResizing, setColumnResizing] = React.useState<any>({})
  const [columnFilters, setColumnFilters] = React.useState<any[]>([])

  // seed 变一次就重造一批数据，用来演示「刷新」
  const [data, setData] = React.useState(() => makeDemoRows(1000))
  React.useEffect(() => { if (seed > 0) setData(makeDemoRows(1000)) }, [seed])

  const columns = React.useMemo(() => {
    const list: any[] = []
    if (caps.select) list.push(buildGridSelectColumn(col as never))
    if (caps.rowNumber) {
      list.push(buildGridRowNumberColumn(col as never, {
        offset: caps.paginated ? pagination.pageIndex * pagination.pageSize : 0,
      }))
    }
    if (caps.expand) list.push(buildGridExpandColumn(col as never))
    list.push(
      col.accessor('name', {
        header: '用户',
        size: 220,
        meta: { filter: 'text', label: '姓名' },
        cell: ({ row }) => (
          <GridCell
            primary={row.original.name}
            secondary={`${row.original.city} · ${row.original.team}`}
            leading={
              <span className="grid size-7 shrink-0 place-content-center rounded-full bg-primary/10 text-xs text-primary">
                {row.original.name.slice(0, 1)}
              </span>
            }
          />
        ),
      }),
      col.accessor('email', {
        header: '邮箱',
        size: 240,
        meta: { filter: 'text', label: '邮箱' },
        cell: ({ row }) => (
          <GridCell primary={row.original.email} secondary={`最近登录：${row.original.lastLoginAt}`} />
        ),
      }),
      col.accessor('team', {
        header: '团队',
        size: 170,
        meta: { filter: 'select', label: '团队' },
        filterFn: facetedFilterFn,
        cell: ({ row }) => <GridCell primary={row.original.team} secondary={`所在城市：${row.original.city}`} />,
      }),
      col.accessor('role', {
        header: '角色',
        size: 110,
        meta: { filter: 'select', label: '角色' },
        filterFn: facetedFilterFn,
      }),
      col.accessor('status', {
        header: '状态',
        size: 100,
        meta: { filter: 'select', label: '状态', optionLabel: (v: number) => STATUS_META[v]?.label ?? String(v) },
        filterFn: facetedFilterFn,
        cell: ({ getValue }) => {
          const m = STATUS_META[getValue() as number]!
          return <StatusPill tone={m.tone}>{m.label}</StatusPill>
        },
      }),
      col.accessor('score', {
        header: '评分',
        size: 90,
        meta: { filter: 'range', label: '评分' },
        filterFn: rangeFilterFn,
        footer: ({ table }) => {
          const rows = table.getFilteredRowModel().rows
          if (!rows.length) return null
          const avg = rows.reduce((s: number, r: any) => s + r.original.score, 0) / rows.length
          return <span className="tabular-nums">均 {avg.toFixed(1)}</span>
        },
        cell: ({ getValue }) => <span className="tabular-nums">{getValue() as number}</span>,
      }),
      col.accessor('amount', {
        header: '额度',
        size: 120,
        footer: ({ table }) => {
          const rows = table.getFilteredRowModel().rows
          const sum = rows.reduce((s: number, r: any) => s + r.original.amount, 0)
          return <span className="tabular-nums">合计 {sum.toLocaleString()}</span>
        },
        cell: ({ getValue }) => <span className="tabular-nums">{(getValue() as number).toLocaleString()}</span>,
      }),
      col.accessor('createdAt', {
        header: '创建时间',
        size: 170,
        cell: ({ getValue }) => (
          <span className="text-xs tabular-nums text-muted-foreground">{getValue() as string}</span>
        ),
      }),
      col.display({
        id: 'actions',
        header: () => <span className="block text-end">操作</span>,
        size: 130,
        enableHiding: false,
        cell: ({ row }) => (
          <GridActions>
            <Button variant="ghost" size="icon" className="size-7" aria-label="置顶"
                    onClick={() => row.pin(row.getIsPinned() ? false : 'top')}>
              {row.getIsPinned() ? <IconPinnedOff className="size-3.5" /> : <IconPin className="size-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs">
              <IconEye className="size-3.5" />查看
            </Button>
          </GridActions>
        ),
      })
    )
    return list
  }, [caps.select, caps.rowNumber, caps.expand, caps.paginated, pagination.pageIndex, pagination.pageSize])

  const table = useTable({
    features,
    data,
    columns: columns as never,
    getRowId: (r: DemoRow) => r.id,
    state: {
      grouping, sorting, globalFilter, rowSelection, expanded,
      rowPinning, columnPinning, columnVisibility, columnOrder,
      columnSizing, columnResizing, columnFilters,
      pagination: caps.paginated ? pagination : { pageIndex: 0, pageSize: data.length },
    },
    enableRowSelection: caps.select,
    enableColumnResizing: caps.resize,
    columnResizeMode: 'onChange',
    // 分组行本身要能展开；不开分组时只有「详情」用到 expanded
    getRowCanExpand: () => caps.expand,
    onGroupingChange: setGrouping,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    onRowPinningChange: setRowPinning,
    onColumnPinningChange: setColumnPinning,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    onColumnResizingChange: setColumnResizing,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
  } as never)

  const t = table as any
  const filtered = t.getFilteredRowModel().rows.length
  const rendered = t.getRowModel().rows.length
  const selectedCount = Object.keys(rowSelection).filter((k) => (rowSelection as any)[k]).length
  const pinnedCount = (rowPinning.top?.length ?? 0) + (rowPinning.bottom?.length ?? 0)

  const set = (k: keyof Caps) => (v: boolean) =>
    setCaps((c) => {
      const next = { ...c, [k]: v }
      // 虚拟滚动和分页互斥：全量滚动才需要虚拟化
      if (k === 'virtual' && v) next.paginated = false
      if (k === 'paginated' && v) next.virtual = false
      // 行拖拽和虚拟滚动互斥：虚拟化下 DOM 里没有完整列表，拖过去会掉进空区
      if (k === 'rowDrag' && v) next.virtual = false
      return next
    })

  function reorder(activeId: string, overId: string) {
    setData((d) => {
      const from = d.findIndex((x) => x.id === activeId)
      const to = d.findIndex((x) => x.id === overId)
      if (from < 0 || to < 0) return d
      const next = d.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved!)
      return next
    })
  }

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader
            title="数据表格（Table）"
            description="在同一页里切换 DataGrid 的布局、交互和工具栏能力，看 1000 行数据下的实际表现。"
          />

          <div className="grid gap-3 md:grid-cols-4">
            <Stat label="总数据量" value={data.length} hint={`${filtered} 条命中过滤条件`} />
            <Stat label="当前已选" value={selectedCount} hint="支持批量操作与跨页选择" />
            <Stat label="已置顶" value={pinnedCount} hint={`${rowPinning.top?.length ?? 0} 顶部 / ${rowPinning.bottom?.length ?? 0} 底部`} />
            <Stat label="当前渲染" value={rendered} hint={caps.virtual ? '虚拟滚动' : caps.paginated ? '分页模式' : '全量渲染'} />
          </div>

          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <Card className="w-full shrink-0 xl:w-72">
              <CardContent className="flex flex-col gap-4 p-4">
                <div>
                  <h3 className="text-sm font-semibold">能力配置面板</h3>
                  <p className="text-xs text-muted-foreground">集中测试渲染、交互、工具栏与布局能力。</p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="text-xs">分组方式</Label>
                  <Select
                    value={grouping[0] ?? 'none'}
                    items={{ none: '不分组', role: '按角色分组', status: '按状态分组', team: '按团队分组' }}
                    onValueChange={(v: string | null) => setGrouping(!v || v === 'none' ? [] : [v])}
                  >
                    <SelectTrigger className="w-full" data-testid="pg-grouping"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不分组</SelectItem>
                      <SelectItem value="role">按角色分组</SelectItem>
                      <SelectItem value="status">按状态分组</SelectItem>
                      <SelectItem value="team">按团队分组</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {GROUPS.map((group, gi) => (
                  <React.Fragment key={gi}>
                    <Separator />
                    <div className="flex flex-col">
                      {group.map((item) => (
                        <label
                          key={item.key}
                          className="flex cursor-pointer items-start justify-between gap-3 rounded-md px-1 py-2 hover:bg-muted/50"
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="text-sm">{item.label}</span>
                            <span className="text-xs text-muted-foreground">{item.hint}</span>
                          </span>
                          <Switch
                            checked={caps[item.key]}
                            onCheckedChange={(v: boolean) => set(item.key)(Boolean(v))}
                            data-testid={`pg-${item.key}`}
                          />
                        </label>
                      ))}
                    </div>
                  </React.Fragment>
                ))}
              </CardContent>
            </Card>

            <div className="min-w-0 flex-1">
              <DataGrid
                table={table}
                storageKey="grid:playground"
                loading={caps.loading}
                columnLabels={{
                  name: '用户', email: '邮箱', team: '团队', role: '角色', status: '状态',
                  score: '评分', amount: '额度', createdAt: '创建时间', actions: '操作',
                }}
                caps={{
                  search: caps.search,
                  density: true,
                  columnSettings: true,
                  refresh: caps.refresh,
                  clearFilters: caps.clearFilters,
                  expandToggle: caps.expandToggle,
                  fullscreen: caps.fullscreen,
                }}
                search={globalFilter}
                onSearchChange={setGlobalFilter}
                searchPlaceholder="搜索姓名、邮箱、团队、角色…"
                onRefresh={() => setSeed((s) => s + 1)}
                virtual={{ enabled: caps.virtual, threshold: 80, overscan: 12, maxHeight: 560 }}
                keyboardNav={caps.keyboard}
                showFooter={caps.footer}
                onRowReorder={caps.rowDrag ? reorder : undefined}
                columnDrag={caps.colDrag}
                columnFilters={caps.colFilter}
                expandableColumns={
                  caps.colExpand
                    ? {
                        name: (row: any) => <ColDetail row={row} kind="name" />,
                        team: (row: any) => <ColDetail row={row} kind="team" />,
                      }
                    : undefined
                }
                emptyMessage="没有匹配的数据"
                toolbar={<SortToolbar table={t} sorting={sorting} />}
                contextMenu={caps.contextMenu ? (row: any) => <RowMenu row={row} /> : undefined}
                renderSubRow={caps.expand ? (row: any) => <SubRow row={row} /> : undefined}
                bulkActions={
                  caps.bulkBar
                    ? (rows: any[]) => (
                        <>
                          <Button variant="ghost" size="sm" className="h-7 text-xs"
                                  onClick={() => rows.forEach((r) => r.pin('top'))}>
                            批量置顶
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs"
                                  onClick={() => t.resetRowPinning()}>
                            取消置顶
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive">
                            <IconTrash className="size-3.5" />删除
                          </Button>
                        </>
                      )
                    : undefined
                }
                pagination={
                  caps.paginated
                    ? {
                        pageIndex: pagination.pageIndex,
                        pageCount: t.getPageCount(),
                        pageSize: pagination.pageSize,
                        totalCount: filtered,
                        onPageChange: (i: number) => setPagination((p) => ({ ...p, pageIndex: i })),
                        onPageSizeChange: (s: number) => setPagination({ pageIndex: 0, pageSize: s }),
                      }
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </CardContent>
    </Card>
  )
}

/** 排序入口放工具栏左侧：表头点击排序在多选列/拖拽列存在时容易误触 */
function SortToolbar({ table, sorting }: { table: any; sorting: any[] }) {
  const cur = sorting[0]
  const cycle = (id: string) => {
    if (cur?.id !== id) table.setSorting([{ id, desc: false }])
    else if (!cur.desc) table.setSorting([{ id, desc: true }])
    else table.setSorting([])
  }
  return (
    <div className="flex items-center gap-1">
      {[['score', '评分'], ['amount', '额度'], ['createdAt', '创建时间']].map(([id, label]) => (
        <Button
          key={id} variant={cur?.id === id ? 'secondary' : 'outline'} size="sm" className="h-8 text-xs"
          data-testid={`pg-sort-${id}`} onClick={() => cycle(id!)}
        >
          {label}
          {cur?.id === id
            ? cur.desc ? <IconArrowDown className="size-3.5" /> : <IconArrowUp className="size-3.5" />
            : <IconArrowsSort className="size-3.5 opacity-50" />}
        </Button>
      ))}
    </div>
  )
}

function RowMenu({ row }: { row: any }) {
  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel>{row.original?.name}</ContextMenuLabel>
        <ContextMenuItem onClick={() => navigator.clipboard?.writeText(row.original?.email ?? '')}>
          <IconCopy className="size-4" />复制邮箱
        </ContextMenuItem>
        <ContextMenuItem onClick={() => row.toggleExpanded()}>
          <IconEye className="size-4" />{row.getIsExpanded() ? '收起详情' : '展开详情'}
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem onClick={() => row.pin('top')}>
          <IconPin className="size-4" />置顶到顶部
        </ContextMenuItem>
        <ContextMenuItem onClick={() => row.pin('bottom')}>
          <IconPin className="size-4 rotate-180" />置顶到底部
        </ContextMenuItem>
        <ContextMenuItem onClick={() => row.pin(false)} disabled={!row.getIsPinned()}>
          <IconPinnedOff className="size-4" />取消置顶
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem variant="destructive">
          <IconTrash className="size-4" />删除
        </ContextMenuItem>
      </ContextMenuGroup>
    </>
  )
}

/** 按列展开的详情：同一行点不同列出来的内容不一样 */
function ColDetail({ row, kind }: { row: any; kind: 'name' | 'team' }) {
  const r: DemoRow = row.original
  const items: [string, React.ReactNode][] =
    kind === 'name'
      ? [['姓名', r.name], ['账号', <code key="a" className="text-xs">{r.account}</code>],
         ['邮箱', r.email], ['角色', r.role], ['最近登录', r.lastLoginAt]]
      : [['团队', r.team], ['所在城市', r.city], ['评分', r.score],
         ['额度', r.amount.toLocaleString()], ['创建时间', r.createdAt]]
  return (
    <div className="flex flex-col gap-2 p-4">
      <span className="text-xs font-medium text-muted-foreground">
        {kind === 'name' ? '用户档案' : '团队详情'} · 点{kind === 'name' ? '用户' : '团队'}列箭头展开
      </span>
      <div className="grid gap-x-8 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {items.map(([k, v]) => (
          <span key={k} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{k}</span>
            <span className="text-sm">{v}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function SubRow({ row }: { row: any }) {
  const r: DemoRow = row.original
  const items: [string, React.ReactNode][] = [
    ['账号', <code key="a" className="text-xs">{r.account}</code>],
    ['团队', r.team],
    ['所在城市', r.city],
    ['角色', <Badge key="r" variant="outline" className="font-normal">{r.role}</Badge>],
    ['评分', <span key="s" className="tabular-nums">{r.score}</span>],
    ['额度', <span key="m" className="tabular-nums">{r.amount.toLocaleString()}</span>],
    ['最近登录', <span key="l" className="text-xs tabular-nums">{r.lastLoginAt}</span>],
    ['创建时间', <span key="c" className="text-xs tabular-nums">{r.createdAt}</span>],
  ]
  return (
    <div className={cn('grid gap-x-8 gap-y-2 p-4 sm:grid-cols-2 lg:grid-cols-4')}>
      {items.map(([k, v]) => (
        <span key={k} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{k}</span>
          <span className="text-sm">{v}</span>
        </span>
      ))}
    </div>
  )
}

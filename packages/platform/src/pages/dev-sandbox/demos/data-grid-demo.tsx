import * as React from 'react'
import {
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createExpandedRowModel,
  createPaginatedRowModel,
  rowExpandingFeature,
  rowPaginationFeature,
  rowPinningFeature,
  rowSelectionFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { IconCopy, IconEye, IconPin, IconPinnedOff, IconTrash } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  ContextMenuGroup, ContextMenuItem, ContextMenuSeparator,
} from '@admin/ui/components/context-menu'
import {
  DataGrid, GridActions, GridCell,
  buildGridExpandColumn, buildGridRowNumberColumn, buildGridSelectColumn,
} from '@admin/ui/components/data-grid'

import { StatusPill } from '../../_shared/status'
import { STATUS_META, makeDemoRows, type DemoRow } from '../../playground-table/data'
import { b, n, s, type KnobValues } from '../kit'

/**
 * 沙箱里的 DataGrid demo。
 *
 * 只挂常用的那半套能力 —— 分组、排序、列拖拽、行拖拽这些可调项太多，
 * 挤在沙箱的小舞台里说不清楚，放 `/sandbox/table` 那个专门的实验台。
 * 这里的目标是「一眼看清一张业务表能长成什么样」并且代码能抄走。
 */
const features = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  rowExpandingFeature,
  rowPaginationFeature,
  rowPinningFeature,
  rowSelectionFeature,
  expandedRowModel: createExpandedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
})

const col = createColumnHelper<typeof features, DemoRow>()

const ALL_ROWS = makeDemoRows(200)

export function DataGridDemo({ v }: { v: KnobValues }) {
  const density = s(v, 'density') as 'compact' | 'standard' | 'loose'
  const rowCount = n(v, 'rows')
  const virtual = b(v, 'virtual')

  const [rowSelection, setRowSelection] = React.useState({})
  const [expanded, setExpanded] = React.useState<any>({})
  const [rowPinning, setRowPinning] = React.useState<any>({ top: [], bottom: [] })
  const [columnVisibility, setColumnVisibility] = React.useState({})
  const [columnOrder, setColumnOrder] = React.useState<string[]>([])
  const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: 8 })

  const data = React.useMemo(() => ALL_ROWS.slice(0, rowCount), [rowCount])

  const columns = React.useMemo(() => {
    const list: any[] = []
    if (b(v, 'select')) list.push(buildGridSelectColumn(col as never))
    if (b(v, 'rowNumber')) {
      list.push(buildGridRowNumberColumn(col as never, {
        offset: virtual ? 0 : pagination.pageIndex * pagination.pageSize,
      }))
    }
    if (b(v, 'expand')) list.push(buildGridExpandColumn(col as never))
    list.push(
      col.accessor('name', {
        header: '用户',
        size: 200,
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
        size: 230,
        cell: ({ row }) => (
          <GridCell primary={row.original.email} secondary={`最近登录：${row.original.lastLoginAt}`} />
        ),
      }),
      col.accessor('status', {
        header: '状态',
        size: 96,
        cell: ({ getValue }) => {
          const m = STATUS_META[getValue() as number]!
          return <StatusPill tone={m.tone}>{m.label}</StatusPill>
        },
      }),
      col.accessor('score', {
        header: '评分',
        size: 88,
        cell: ({ getValue }) => <span className="tabular-nums">{getValue() as number}</span>,
        footer: () => {
          const avg = data.reduce((t, r) => t + r.score, 0) / (data.length || 1)
          return <span className="tabular-nums">均 {avg.toFixed(1)}</span>
        },
      }),
      col.display({
        id: 'actions',
        header: () => <span className="block text-end">操作</span>,
        size: 112,
        enableHiding: false,
        cell: ({ row }) => (
          <GridActions>
            <Button variant="ghost" size="icon" className="size-7" aria-label="置顶"
                    onClick={() => row.pin(row.getIsPinned() ? false : 'top')}>
              {row.getIsPinned() ? <IconPinnedOff className="size-3.5" /> : <IconPin className="size-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs">查看</Button>
          </GridActions>
        ),
      })
    )
    return list
  }, [v, virtual, pagination.pageIndex, pagination.pageSize, data])

  const table = useTable({
    features,
    data,
    columns: columns as never,
    getRowId: (r: DemoRow) => r.id,
    state: {
      rowSelection, expanded, rowPinning, columnVisibility, columnOrder,
      columnPinning: { start: [], end: b(v, 'pinActions') ? ['actions'] : [] },
      pagination: virtual ? { pageIndex: 0, pageSize: data.length } : pagination,
    },
    enableRowSelection: b(v, 'select'),
    getRowCanExpand: () => b(v, 'expand'),
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    onRowPinningChange: setRowPinning,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onPaginationChange: setPagination,
  } as never)

  const t = table as any

  return (
    <DataGrid
      table={table}
      // 沙箱里不落 storageKey：旋钮调出来的外观不该污染真实页面的偏好
      defaultDensity={density}
      defaultStriped={b(v, 'striped')}
      defaultBordered={b(v, 'bordered')}
      caps={{ density: true, columnSettings: true, fullscreen: true }}
      showFooter={b(v, 'footer')}
      keyboardNav={b(v, 'keyboard')}
      virtual={{ enabled: virtual, threshold: 20, overscan: 8, maxHeight: 360 }}
      contextMenu={b(v, 'contextMenu') ? (row: any) => <RowMenu row={row} /> : undefined}
      renderSubRow={b(v, 'expand') ? (row: any) => <SubRow row={row} /> : undefined}
      bulkActions={
        b(v, 'bulkBar')
          ? (rows: any[]) => (
              <>
                <Button variant="ghost" size="sm" className="h-7 text-xs"
                        onClick={() => rows.forEach((r) => r.pin('top'))}>
                  批量置顶
                </Button>
                <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive">
                  <IconTrash className="size-3.5" />删除
                </Button>
              </>
            )
          : undefined
      }
      pagination={
        virtual
          ? undefined
          : {
              pageIndex: pagination.pageIndex,
              pageCount: t.getPageCount(),
              pageSize: pagination.pageSize,
              totalCount: data.length,
              pageSizeOptions: [5, 8, 20, 50],
              onPageChange: (i: number) => setPagination((p) => ({ ...p, pageIndex: i })),
              onPageSizeChange: (size: number) => setPagination({ pageIndex: 0, pageSize: size }),
            }
      }
    />
  )
}

function RowMenu({ row }: { row: any }) {
  return (
    <>
      <ContextMenuGroup>
        <ContextMenuItem onClick={() => navigator.clipboard?.writeText(row.original?.email ?? '')}>
          <IconCopy className="size-4" />复制邮箱
        </ContextMenuItem>
        <ContextMenuItem onClick={() => row.toggleExpanded()}>
          <IconEye className="size-4" />{row.getIsExpanded() ? '收起详情' : '展开详情'}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => row.pin(row.getIsPinned() ? false : 'top')}>
          <IconPin className="size-4" />{row.getIsPinned() ? '取消置顶' : '置顶'}
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

function SubRow({ row }: { row: any }) {
  const r: DemoRow = row.original
  return (
    <div className="grid gap-x-8 gap-y-2 p-4 sm:grid-cols-3">
      {([['账号', r.account], ['团队', r.team], ['所在城市', r.city],
         ['角色', r.role], ['额度', r.amount.toLocaleString()], ['创建时间', r.createdAt]] as const).map(
        ([k, val]) => (
          <span key={k} className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">{k}</span>
            <span className="text-sm">{val}</span>
          </span>
        )
      )}
    </div>
  )
}

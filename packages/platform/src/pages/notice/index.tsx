import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTable, type ColumnVisibilityState, type RowSelectionState } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { IconPlus } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { BulkBar, RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { useQuerySearch } from '../_shared/use-query-search'
import { noticeKeys, noticesQuery, useDeleteNotices, type Notice, type NoticeListParams } from './api'
import { COLUMN_LABELS, buildColumns } from './columns'
import { NoticeDetailSheet } from './detail-sheet'
import { features } from './table-features'
import { NoticeFormSheet } from './form'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

/**
 * 通知公告。标准的三件套列表页，照 `pages/user/` 的模板。
 *
 * 硬纪律：组件 router-独立（search 走 props，内部不碰 Route.useSearch），
 * 筛选与分页全进 URL。
 */

/**
 * 可筛字段。`key` 恰好和接口入参同名，所以不用 `param` 映射。
 *
 * ⚠️ 这一页的「状态」语义是**显示 / 隐藏**，不是系统通用的正常 / 停用 ——
 * 所以不能用 `_shared/status` 那套选项。
 */
const FIELDS: FilterField[] = [
  {
    key: 'title',
    label: '标题',
    type: 'text',
    group: '内容',
    defaultVisible: true,
    placeholder: '模糊匹配',
  },
  {
    key: 'type',
    label: '类型',
    type: 'select',
    group: '内容',
    defaultVisible: true,
    options: [
      { value: 0, label: '通知' },
      { value: 1, label: '公告' },
    ],
  },
  {
    key: 'status',
    label: '状态',
    type: 'select',
    group: '状态',
    defaultVisible: true,
    options: [
      { value: 1, label: '显示' },
      { value: 0, label: '隐藏' },
    ],
  },
]
export type NoticePageSearch = {
  page?: number
  size?: number
  /** 摆开但还没填值的格子（见 `_shared/use-query-search`） */
  f?: string
  title?: string
  /** 0 通知 · 1 公告 */
  type?: number
  /** 0 隐藏 · 1 显示 */
  status?: number
}

export function NoticePage({
  search = {},
  onSearchChange,
}: {
  search?: NoticePageSearch
  onSearchChange?: (next: NoticePageSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE

  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})

  // 换页/换筛选清掉选中：分页在服务端，留着的选中项已不在可见行里，
  // 批量删除会打到用户看不见的记录上
  const patch = React.useCallback(
    (next: Partial<NoticePageSearch>) => {
      setRowSelection({})
      onSearchChange?.({ ...search, ...next })
    },
    [onSearchChange, search]
  )

  /**
   * URL ↔ QueryBar 的胶水。
   *
   * ⚠️ 搜索/重置要清掉选中行：分页在服务端，换筛选后留着的选中项已经不在
   * 可见行里，批量删除会打到看不见的记录上（原来 `patch` 顺手做的那件事）。
   */
  // 这一页的列显隐是组件内 state（没进 URL），所以 keep 里没有 'hide'
  const q = useQuerySearch({ fields: FIELDS, search, onSearchChange, refreshKey: noticeKeys.all })
  const submitQuery = React.useCallback(
    (v: Parameters<typeof q.submit>[0]) => {
      setRowSelection({})
      q.submit(v)
    },
    [q]
  )

  const params = { page, size, ...q.params } as NoticeListParams
  const listQuery = useQuery(noticesQuery(params))
  const { data, isFetching } = listQuery
  const list = listState(listQuery, { onBeforeRefetch: () => setRowSelection({}) })
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = data?.total_pages ?? 1

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Notice | null>(null)
  const [viewing, setViewing] = React.useState<Notice | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Notice | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const del = useDeleteNotices()

  const handleEdit = React.useCallback((n: Notice) => {
    setEditing(n)
    setSheetOpen(true)
  }, [])

  const columns = React.useMemo(
    () => buildColumns(setViewing, handleEdit, setPendingDelete, t),
    [handleEdit, t]
  )

  const table = useTable({
    features,
    data: rows,
    // v9 的列定义数组混用不同 TValue 会形成联合类型，与 useTable 期望的
    // ColumnDef<..., unknown>[] 不兼容（库的类型方差限制）
    columns: columns as never,
    state: { columnVisibility, rowSelection },
    getRowId: (row) => row.id,
    manualPagination: true,
    rowCount: total,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
  })

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])
  const hasFilter = countActive(q.applied, FIELDS) > 0
  const clearFilters = React.useCallback(() => {
    setRowSelection({})
    q.reset()
  }, [q])

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t('通知公告')} description={t('发布系统通知与公告，状态控制是否对外展示。')} />

          {/* 查询区和表格是同一个块的两半；这一层也要能收缩，否则「只滚表格行」那条链断在这里 */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            <QueryBar
              fields={FIELDS}
              value={q.value}
              onChange={q.setValue}
              onSearch={submitQuery}
              onReset={clearFilters}
              applied={q.applied}
              loading={isFetching}
              viewsStorageKey="qb:notice"
              actions={
                <>
                  <Can perm="sys:notice:add">
                    <Button
                      size="sm"
                      data-testid="add-notice"
                      onClick={() => {
                        setEditing(null)
                        setSheetOpen(true)
                      }}
                    >
                      <IconPlus className="size-4" />
                      {t('新增公告')}
                    </Button>
                  </Can>
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                  {/* 批量条放左组末尾：它随选中行出现/消失，放右组会让「搜索/重置」横向位移 */}
                  <Can perm="sys:notice:del">
                    <BulkBar
                      count={selectedIds.length}
                      pending={del.isPending}
                      onDelete={() => setBulkOpen(true)}
                    />
                  </Can>
                </>
              }
            />

            {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
            <div
              data-testid="notice-table"
              data-fetching={isFetching}
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                columnLabels={COLUMN_LABELS}
                emptyMessage={t('还没有通知公告')}
                emptyAction={
                  hasFilter ? (
                    <ResetButton
                      variant="outline"
                      testId="empty-clear-filter"
                      label={t('清除筛选')}
                      onClick={clearFilters}
                    />
                  ) : undefined
                }
                {...list}
                pagination={{
                  pageIndex: page - 1,
                  pageCount: totalPages,
                  pageSize: size,
                  selectedCount: selectedIds.length,
                  totalCount: total,
                  onPageChange: (i) => patch({ page: i === 0 ? undefined : i + 1 }),
                  onPageSizeChange: (s) => patch({ size: s, page: undefined }),
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <NoticeFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />
      <NoticeDetailSheet notice={viewing} onOpenChange={(o) => !o && setViewing(null)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除通知公告')}
        description={
          pendingDelete ? t('确定删除「{{title}}」吗？此操作不可撤销。', { title: pendingDelete.title }) : ''
        }
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          try {
            await del.mutateAsync([pendingDelete.id])
          } finally {
            setPendingDelete(null)
          }
        }}
      />

      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => !o && setBulkOpen(false)}
        title={t('批量删除通知公告')}
        description={t('确定删除选中的 {{n}} 条通知公告吗？此操作不可撤销。', { n: selectedIds.length })}
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          try {
            await del.mutateAsync(selectedIds)
            setRowSelection({})
          } finally {
            setBulkOpen(false)
          }
        }}
      />
    </div>
  )
}

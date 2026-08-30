import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useTable, type ColumnVisibilityState } from '@tanstack/react-table'
import { IconChecks } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { RefreshButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { useQuerySearch } from '../_shared/use-query-search'
import {
  CATEGORY,
  notificationKeys,
  notificationsQuery,
  unreadCountQuery,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  type Notification,
  type NotificationListParams,
} from './api'
import { buildColumns, COLUMN_LABELS } from './columns'
import { features } from './table-features'
import { useNotificationOpen } from './use-open'

/**
 * 可筛字段。`key` 是**地址栏参数名**，恰好和接口入参同名，所以不用 `param` 映射。
 *
 * 「状态」这一栏的语义是**已读 / 未读**，不是系统通用的正常 / 停用 ——
 * 所以不能用 `_shared/status` 的 `STATUS_FILTER_ITEMS`。
 * 值用 `1` / `0` 而不是布尔：`QueryBar` 的选项值进 URL 之后是字符串，
 * 布尔 `false` 会被写成 `'false'` 再被 zod 的 `coerce.boolean()` 判成 `true`
 * （非空字符串一律真）—— 那是个静默反转，不如一开始就用数字。
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
    key: 'category',
    label: '分类',
    type: 'select',
    group: '内容',
    defaultVisible: true,
    options: [
      { value: CATEGORY.SYSTEM, label: '系统' },
      { value: CATEGORY.ANNOUNCEMENT, label: '公告' },
      { value: CATEGORY.TASK, label: '任务' },
    ],
  },
  {
    key: 'unread',
    label: '状态',
    type: 'select',
    group: '状态',
    defaultVisible: true,
    options: [
      { value: 1, label: '未读' },
      { value: 0, label: '已读' },
    ],
  },
]

export type NotificationPageSearch = {
  page?: number
  size?: number
  /** 摆开但还没填值的格子（见 `_shared/use-query-search`） */
  f?: string
  title?: string
  /** 见 `api.ts` 的 `CATEGORY` */
  category?: number
  /** 1 未读 · 0 已读 */
  unread?: number
}

/**
 * 消息中心 —— 收件箱的完整视图（翻历史 / 筛已读未读 / 全部已读）。
 *
 * 顶栏那枚铃铛（`./bell.tsx`）是同一份数据的「最近几条」预览，两者共用
 * `api.ts` 的 query key —— 在任一处标记已读，另一处立刻跟着变，不用互相通知。
 *
 * 硬纪律：组件 router-独立（search 走 props，内部不读 `Route.useSearch()`），
 * 筛选与分页全进 URL。
 */
export function NotificationPage({
  search = {},
  onSearchChange,
}: {
  search?: NotificationPageSearch
  onSearchChange?: (next: NotificationPageSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE

  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})
  const [markAllOpen, setMarkAllOpen] = React.useState(false)

  const q = useQuerySearch({ fields: FIELDS, search, onSearchChange, refreshKey: notificationKeys.all })

  const raw = q.params as { title?: string; category?: number; unread?: number }
  const params: NotificationListParams = {
    page,
    size,
    title: raw.title,
    category: raw.category,
    // 1/0 → true/false。`undefined` 保持 undefined（= 不筛），
    // 不能写成 `raw.unread === 1`：那会把「不限」变成「只看已读」
    unread: raw.unread === undefined ? undefined : raw.unread === 1,
  }

  const listQuery = useQuery(notificationsQuery(params))
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = data?.total_pages ?? 1

  const unread = useQuery(unreadCountQuery)
  const markRead = useMarkNotificationRead()
  const markAll = useMarkAllNotificationsRead()

  const { linkOf, readIfUnread } = useNotificationOpen()
  const handleMarkRead = React.useCallback((n: Notification) => markRead.mutate(n.id), [markRead])

  const columns = React.useMemo(
    () => buildColumns(linkOf, readIfUnread, handleMarkRead, t),
    [linkOf, readIfUnread, handleMarkRead, t]
  )

  const table = useTable({
    features,
    data: rows,
    // v9 的列定义数组混用不同 TValue 会形成联合类型，与 useTable 期望的
    // ColumnDef<..., unknown>[] 不兼容（库的类型方差限制）
    columns: columns as never,
    state: { columnVisibility },
    getRowId: (row) => row.id,
    manualPagination: true,
    rowCount: total,
    onColumnVisibilityChange: setColumnVisibility,
  })

  const unreadTotal = unread.data?.total ?? 0
  const hasFilter = countActive(q.applied, FIELDS) > 0

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader
            title={t('消息中心')}
            description={t('系统消息与公告的收件箱。已读状态只属于你自己。')}
          />

          {/* 查询区和表格是同一个块的两半；这一层也要能收缩，
              否则「只滚表格行」那条链断在这里（见 shell 分册） */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            <QueryBar
              fields={FIELDS}
              value={q.value}
              onChange={q.setValue}
              onSearch={q.submit}
              onReset={q.reset}
              applied={q.applied}
              loading={isFetching}
              viewsStorageKey="qb:notification"
              actions={
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={unreadTotal === 0 || markAll.isPending}
                    onClick={() => setMarkAllOpen(true)}
                    data-testid="notification-mark-all-page"
                  >
                    <IconChecks className="size-4" />
                    {unreadTotal > 0
                      ? t('全部已读（{{n}}）', { n: unreadTotal })
                      : t('全部已读')}
                  </Button>
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                </>
              }
            />

            <div
              data-testid="notification-table"
              data-fetching={isFetching}
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                columnLabels={COLUMN_LABELS}
                emptyMessage={hasFilter ? t('没有匹配的通知') : t('暂无通知')}
                // 未读行整行加一点底色 —— 和铃铛下拉里的处理保持一致
                rowAttributes={(row) => ({ 'data-unread': row.original.read_time ? undefined : 'true' })}
                tableBodyClassName="[&_tr[data-unread=true]]:bg-muted/30"
                {...list}
                pagination={{
                  pageIndex: page - 1,
                  pageCount: totalPages,
                  pageSize: size,
                  totalCount: total,
                  onPageChange: (i) =>
                    onSearchChange?.({ ...search, page: i === 0 ? undefined : i + 1 }),
                  onPageSizeChange: (s) => onSearchChange?.({ ...search, size: s, page: undefined }),
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={markAllOpen}
        onOpenChange={setMarkAllOpen}
        title={t('标记全部已读')}
        description={t('会把你当前全部 {{n}} 条未读通知标记为已读，此操作不可撤销。', {
          n: unreadTotal,
        })}
        confirmText={t('全部已读')}
        pending={markAll.isPending}
        onConfirm={async () => {
          await markAll.mutateAsync()
          setMarkAllOpen(false)
        }}
      />
    </div>
  )
}

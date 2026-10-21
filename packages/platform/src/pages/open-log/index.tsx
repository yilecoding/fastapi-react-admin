import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'

import { formatDateTime } from '@admin/i18n'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'
import { cn } from '@admin/ui/lib/utils'

import { api, type PageData } from '../../api-client/client'
import { PageHeader } from '../../shell/page-header'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { logFeatures as features } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { StatusPill } from '../_shared/status'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useQuerySearch } from '../_shared/use-query-search'
import { allOpenAppsQuery } from '../open-app/api'
import { OpenApiLogDetailSheet } from './detail-sheet'
import { ERROR_META, ERROR_OPTIONS, type OpenApiLog } from './shared'

/** 这一页列表 query 的 key 前缀；`useQuerySearch` 的 `refreshKey` 也用它（点搜索必须真的重取） */
const LOG_KEY = ['open-api-logs'] as const

const col = createColumnHelper<typeof features, OpenApiLog>()

const COLUMN_LABELS = {
  request_time: '时间',
  app: '应用',
  title: '接口',
  result: '结果',
  row_count: '返回条数',
  cost_time: '耗时',
  ip: '来源 IP',
}

export type OpenLogSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key。`app` 是应用 ID（雪花，字符串） */
  app?: string
  status?: number
  error_code?: string
  path?: string
  ip?: string
  time?: string
  f?: string
  hide?: string
}

function buildQuery(params: Record<string, unknown>, page: number, size: number): string {
  const q = new URLSearchParams({ page: String(page), size: String(size) })
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  return q.toString()
}

/**
 * 开放接口调用日志。**不占菜单**：从「应用管理」进来（工具栏的「调用日志」= 全部应用；
 * 行操作的「调用日志」/「最近调用」= 预填那个应用）。AK 无效这类识别不出应用的记录只在「全部」里。
 */
export function OpenLogPage({
  search = {},
  onSearchChange,
}: {
  search?: OpenLogSearch
  onSearchChange?: (n: OpenLogSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<OpenLogSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  const appsQuery = useQuery(allOpenAppsQuery())
  const fields = React.useMemo<FilterField[]>(
    () => [
      {
        key: 'app',
        param: 'app_id',
        label: '应用',
        type: 'select',
        group: '应用',
        defaultVisible: true,
        // 应用名是用户录入的业务数据，不翻；删除了的应用不在下拉里，但日志里还有它的快照
        options: (appsQuery.data?.items ?? []).map((a) => ({ value: a.id, label: `${a.name}（${a.code}）` })),
        optionsLoading: appsQuery.isPending,
      },
      {
        key: 'status',
        label: '结果',
        type: 'select',
        group: '结果',
        defaultVisible: true,
        options: [
          { value: 1, label: '成功' },
          { value: 0, label: '失败' },
        ],
      },
      {
        key: 'error_code',
        label: '失败原因',
        type: 'select',
        group: '结果',
        defaultVisible: true,
        options: ERROR_OPTIONS,
      },
      { key: 'path', label: '接口', type: 'text', group: '请求', defaultVisible: false, placeholder: '/api/open/v1/…' },
      { key: 'ip', label: '来源 IP', type: 'text', group: '请求', defaultVisible: false },
      {
        key: 'time',
        label: '调用时间',
        type: 'dateTimeRange',
        group: '时间',
        defaultVisible: true,
        rangeParams: ['start_time', 'end_time'],
      },
    ],
    [appsQuery.data, appsQuery.isPending]
  )

  const q = useQuerySearch({ fields, search, onSearchChange, refreshKey: LOG_KEY, keep: ['hide'] })
  const qs = buildQuery(q.params, page, size)
  const listQuery = useQuery({
    queryKey: [...LOG_KEY, qs],
    queryFn: () => api.GET<PageData<OpenApiLog>>(`/api/v1/open-api-logs?${qs}`),
    placeholderData: (prev) => prev,
  })
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  const [detail, setDetail] = React.useState<OpenApiLog | null>(null)
  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search])
  )

  const columns = React.useMemo(
    () => [
      col.accessor('request_time', {
        header: t('时间'),
        // 点时间开详情（同操作日志）
        cell: ({ row, getValue }) => (
          <button
            type="button"
            onClick={() => setDetail(row.original)}
            data-testid={`open-log-detail-${row.original.id}`}
            className="font-mono text-xs text-primary tabular-nums underline-offset-2 hover:underline"
          >
            {formatDateTime(getValue())}
          </button>
        ),
      }),
      col.accessor((r) => r.app_name ?? '', {
        id: 'app',
        header: t('应用'),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-sm leading-tight">{row.original.app_name ?? t('（未识别的应用）')}</span>
            <span className="font-mono text-xs leading-tight text-muted-foreground">{row.original.app_code ?? '—'}</span>
          </div>
        ),
      }),
      col.accessor('title', {
        header: t('接口'),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-sm leading-tight">{t(row.original.title)}</span>
            <span className="font-mono text-xs leading-tight text-muted-foreground">
              {row.original.method} {row.original.path}
            </span>
          </div>
        ),
      }),
      col.accessor('error_code', {
        id: 'result',
        header: t('结果'),
        cell: ({ row, getValue }) => {
          const ok = row.original.status === 1
          const meta = ERROR_META[getValue()]
          return (
            <StatusPill tone={ok ? 'success' : 'danger'} className="whitespace-nowrap">
              {meta ? t(meta.label) : getValue()} · {row.original.code}
            </StatusPill>
          )
        },
      }),
      col.accessor('row_count', {
        header: t('返回条数'),
        cell: ({ getValue }) => (
          <span className="font-mono text-xs tabular-nums">{getValue() === null ? '—' : getValue()}</span>
        ),
      }),
      col.accessor('cost_time', {
        header: t('耗时'),
        cell: ({ getValue }) => (
          <span
            className={cn(
              'font-mono text-xs tabular-nums',
              getValue() > 500 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
            )}
          >
            {getValue().toFixed(1)} ms
          </span>
        ),
      }),
      col.accessor('ip', {
        header: t('来源 IP'),
        cell: ({ getValue }) => <span className="font-mono text-xs tabular-nums">{getValue()}</span>,
      }),
    ],
    [t]
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility },
    getRowId: (r: OpenApiLog) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
  })

  const hasFilter = countActive(q.applied, fields) > 0

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t('调用日志')} />
          <p className="text-sm text-muted-foreground">
            {t('外部系统每次调用开放接口都会记一条，成功失败都记。点时间看详情；日志保留 30 天，到期由定时任务清理。')}
          </p>

          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            <QueryBar
              fields={fields}
              value={q.value}
              onChange={q.setValue}
              onSearch={q.submit}
              onReset={q.reset}
              applied={q.applied}
              loading={isFetching}
              actions={
                <>
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                </>
              }
              viewsStorageKey="qb:open-log"
            />

            <div
              data-testid="open-log-table"
              data-fetching={isFetching}
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                emptyMessage={t('没有匹配的调用记录')}
                emptyAction={
                  hasFilter ? (
                    <ResetButton variant="outline" testId="empty-clear-filter" label={t('清除筛选')} onClick={q.reset} />
                  ) : undefined
                }
                {...list}
                skeletonRows={8}
                pagination={{
                  pageIndex: page - 1,
                  pageCount: data?.total_pages ?? 1,
                  pageSize: size,
                  totalCount: data?.total ?? 0,
                  onPageChange: (i) => patch({ page: i === 0 ? undefined : i + 1 }),
                  onPageSizeChange: (s) => patch({ size: s, page: undefined }),
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <OpenApiLogDetailSheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} log={detail} />
    </div>
  )
}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'

import { formatDateTime } from '@admin/i18n'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { PageHeader } from '../../shell/page-header'
import { ResetButton } from '../_shared/filters'
import { logFeatures as features } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { StatusPill } from '../_shared/status'
import { useQuerySearch } from '../_shared/use-query-search'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import {
  RESULT_STATUS_FILTER_ITEMS,
  RESULT_STATUS_LABEL,
  RESULT_STATUS_TONE,
  resultsQuery,
  type TaskResult,
} from './api'
import { TaskResultDetailSheet } from './detail-sheet'

export type SchedulerRecordSearch = {
  page?: number
  size?: number
  name?: string
  task_id?: string
  status?: string
  hide?: string
}

/**
 * 筛选字段。
 *
 * ⚠️ `key` 是**地址栏里的参数名**，`rangeParams` 才是接口入参名 —— 两者刻意分开：
 * URL 上是 `time=2026-08-16~2026-08-22`（一个参数、无编码噪音），
 * 发出去是 `start_time=… 00:00:00&end_time=… 23:59:59`。
 *
 * 🔴 **补时分秒那一步不能省。** 后端是 `date_done <= end_time`，
 * 只给日期会被 pydantic 解析成当天 00:00:00，**静默丢掉最后一整天**——
 * 用户选了「到今天」，今天的记录一条都不显示，界面上没有任何异常。
 * 压缩只发生在 URL 上，解码时立刻补回规范形式。
 * （后端那条边界有专门的回归：`test_end_time_without_clock_silently_drops_the_last_day`）
 */
const FIELDS: readonly FilterField[] = [
  { key: 'name', label: '任务名', type: 'text', param: 'name', defaultVisible: true },
  {
    key: 'status',
    label: '状态',
    type: 'select',
    param: 'status',
    defaultVisible: true,
    options: Object.entries(RESULT_STATUS_FILTER_ITEMS)
      .filter(([v]) => v !== 'all')
      .map(([value, label]) => ({ value, label })),
  },
  {
    key: 'time',
    label: '结束时间',
    type: 'dateTimeRange',
    group: '时间',
    defaultVisible: true,
    rangeParams: ['start_time', 'end_time'],
  },
  { key: 'task_id', label: '任务 UUID', type: 'text', param: 'task_id' },
]

const COLUMN_LABELS: Record<string, string> = {
  date_done: '结束时间',
  name: '任务名',
  status: '状态',
  retries: '重试次数',
  worker: '执行节点',
  task_id: '任务 UUID',
}

const col = createColumnHelper<typeof features, TaskResult>()

export function SchedulerRecordPage({
  search = {},
  onSearchChange,
}: {
  search?: SchedulerRecordSearch
  onSearchChange?: (n: SchedulerRecordSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<SchedulerRecordSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  const q = useQuerySearch({ fields: FIELDS, search, onSearchChange, keep: ['hide'] })

  const { data, isPending, isFetching } = useQuery(
    resultsQuery({ page, size, ...(q.params as Record<string, string>) })
  )
  const rows = data?.items ?? []

  const [detailId, setDetailId] = React.useState<number | null>(null)
  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search])
  )

  const columns = React.useMemo(
    () => [
      col.display({
        id: 'seq',
        header: t('序号'),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {(page - 1) * size + row.index + 1}
          </span>
        ),
      }),
      col.accessor((r) => formatDateTime(r.date_done), {
        id: 'date_done',
        header: t('结束时间'),
        // ⚠️ 不要裸打印 date_done：后端下发的是 ISO（UTC），
        // 直接渲染会得到 `2026-08-22T16:29:00.141035+08:00` 这种带微秒的原文，
        // 而且切片取日期在东八区凌晨会切到前一天。一律走 `@admin/i18n` 的
        // formatDateTime（见 packages/i18n/src/datetime.ts 的头注释）
        // 点时间开详情 —— 和操作日志一致，比多一列「查看」省地方
        cell: ({ row, getValue }) => (
          <button
            type="button"
            data-testid={`open-result-${row.original.id}`}
            onClick={() => setDetailId(row.original.id)}
            className="font-mono text-xs text-primary tabular-nums underline-offset-2 hover:underline"
          >
            {getValue()}
          </button>
        ),
      }),
      col.accessor((r) => r.name ?? '—', {
        id: 'name',
        header: t('任务名'),
        cell: ({ getValue }) => (
          <span className="block max-w-56 truncate font-mono text-xs" title={getValue()}>
            {getValue()}
          </span>
        ),
      }),
      col.accessor((r) => r.status ?? '', {
        id: 'status',
        header: t('状态'),
        cell: ({ getValue }) => {
          const s = getValue()
          return (
            <StatusPill tone={RESULT_STATUS_TONE[s] ?? 'muted'}>
              {t(RESULT_STATUS_LABEL[s] ?? s ?? '—')}
            </StatusPill>
          )
        },
      }),
      col.accessor((r) => r.retries ?? 0, {
        id: 'retries',
        header: t('重试次数'),
        cell: ({ getValue }) => (
          <span
            className={
              getValue() > 0
                ? 'font-mono text-xs font-medium text-amber-600 tabular-nums dark:text-amber-400'
                : 'font-mono text-xs text-muted-foreground tabular-nums'
            }
          >
            {getValue()}
          </span>
        ),
      }),
      col.accessor((r) => r.worker ?? '—', {
        id: 'worker',
        header: t('执行节点'),
        cell: ({ getValue }) => <span className="text-sm text-muted-foreground">{getValue()}</span>,
      }),
      col.accessor((r) => r.task_id ?? '—', {
        id: 'task_id',
        header: t('任务 UUID'),
        cell: ({ getValue }) => (
          <span className="block max-w-52 truncate font-mono text-xs text-muted-foreground" title={getValue()}>
            {getValue()}
          </span>
        ),
      }),
    ],
    [page, size, t]
  )

  const hasFilter = countActive(q.applied, FIELDS) > 0

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility },
    getRowId: (r: TaskResult) => String(r.id),
    manualPagination: true,
    rowCount: data?.total ?? 0,
    // 只读列表 —— 没开批量删除就不开行选中，否则分页条上「已选 N 项」永远是 0
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
  })

  return (
    // 三件套模板的外层骨架（照 pages/user/ 抄，见 pages/AGENTS.md）——
    // 之前这一页把 py-4 md:py-6 那层拆掉、gap 直接摆在 @container/main 上，
    // 于是「页头 → 查询区」少了一层竖向留白，跟别的列表页对不上
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t('执行记录')} description={t('定时任务每一次执行的结果与异常栈')} />

          {/* 查询区和表格是同一个块的两半，gap-4 而不是页面级的 24px */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            {/* 查询区与表格工具行合并成一行 —— 不合并是两条右对齐、左半边全空的按钮行 */}
            <QueryBar
              fields={FIELDS}
              value={q.value}
              onChange={q.setValue}
              onSearch={q.submit}
              onReset={q.reset}
              applied={q.applied}
              loading={isFetching}
              actions={<DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />}
            />

            <div
              data-testid="scheduler-record-table"
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                loading={isPending}
                busy={isFetching && !isPending}
                skeletonRows={8}
                emptyMessage={t('暂无执行记录')}
                emptyAction={
                  hasFilter ? (
                    <ResetButton
                      variant="outline"
                      testId="empty-clear-filter"
                      label={t('清除筛选')}
                      onClick={q.reset}
                    />
                  ) : undefined
                }
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

      <TaskResultDetailSheet id={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { PageHeader } from '../../shell/page-header'
import { ClearLogsButton } from '../_shared/clear-logs'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { logFeatures as features } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useUrlColumnOrder } from '../_shared/use-column-order'
import { useQuerySearch } from '../_shared/use-query-search'
import { ERROR_KIND_LABELS, smsConfigsQuery, smsTemplatesQuery } from '../sms-config/api'
import { LOG_STATUS, smsLogKeys, smsLogsQuery, type SmsLog } from './api'
import { SmsLogDetailSheet, StatusBadgeFor } from './detail-sheet'

const COLUMN_LABELS = {
  seq: '序号',
  created_time: '时间',
  phone: '手机号',
  template: '业务模板',
  provider: '厂商',
  status: '状态',
  error_kind: '错误类型',
  provider_code: '厂商码',
  duration_ms: '耗时',
}

export type SmsLogSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key */
  phone?: string
  config_id?: string
  template?: string
  status?: number
  error_kind?: string
  time?: string
  /** 摆开但没填值的格子 */
  f?: string
  /** 被隐藏的列 id，逗号分隔 */
  hide?: string
  /** 可移动列的顺序，逗号分隔 */
  cols?: string
}

function buildQuery(params: Record<string, unknown>, page: number | undefined, size: number | undefined): string {
  const q = new URLSearchParams()
  q.set('page', String(page ?? 1))
  q.set('size', String(size ?? DEFAULT_PAGE_SIZE))
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  return q.toString()
}

const col = createColumnHelper<typeof features, SmsLog>()

/**
 * 短信发送日志。只读、倒序、分页；审计记录那一类（pages 分册的批量操作表）：不给勾选删除，
 * 按策略清空（`ClearLogsButton kind="sms"`）。
 *
 * 列表里手机号是掩码，点一行看详情（完整号在那里）。
 */
export function SmsLogPage({ search = {}, onSearchChange }: { search?: SmsLogSearch; onSearchChange?: (next: SmsLogSearch) => void }) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback((n: Partial<SmsLogSearch>) => onSearchChange?.({ ...search, ...n }), [onSearchChange, search])
  const [detail, setDetail] = React.useState<string | null>(null)

  const configsQuery = useQuery(smsConfigsQuery())
  const templatesQuery = useQuery(smsTemplatesQuery())

  const fields = React.useMemo<FilterField[]>(
    () => [
      { key: 'phone', label: '手机号', type: 'text', group: '收件', defaultVisible: true, placeholder: '完整号码，全等匹配' },
      {
        key: 'template',
        label: '业务模板',
        type: 'select',
        group: '收件',
        defaultVisible: true,
        optionsLoading: templatesQuery.isPending,
        options: [
          ...(templatesQuery.data ?? []).map((tpl) => ({ value: tpl.code, label: tpl.label })),
          { value: 'test', label: '测试短信' },
        ],
      },
      {
        key: 'config_id',
        label: '配置',
        type: 'select',
        group: '通道',
        optionsLoading: configsQuery.isPending,
        options: (configsQuery.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        group: '结果',
        defaultVisible: true,
        options: Object.entries(LOG_STATUS).map(([value, meta]) => ({ value: Number(value), label: meta.label })),
      },
      {
        key: 'error_kind',
        label: '错误类型',
        type: 'select',
        group: '结果',
        options: Object.entries(ERROR_KIND_LABELS)
          .filter(([k]) => k !== 'circuit_open')
          .map(([value, label]) => ({ value, label })),
      },
      { key: 'time', label: '时间', type: 'dateTimeRange', group: '时间', defaultVisible: true, rangeParams: ['start_time', 'end_time'] },
    ],
    [templatesQuery.data, templatesQuery.isPending, configsQuery.data, configsQuery.isPending],
  )

  const q = useQuerySearch({ fields, search, onSearchChange, refreshKey: smsLogKeys.all, keep: ['hide', 'cols'] })
  const qs = buildQuery(q.params, search.page, search.size)
  const listQuery = useQuery(smsLogsQuery(qs))
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search]),
  )

  const columns = React.useMemo(
    () => [
      col.display({
        id: 'seq',
        header: t('序号'),
        cell: ({ row }) => <span className="font-mono text-xs tabular-nums text-muted-foreground">{(page - 1) * size + row.index + 1}</span>,
      }),
      col.accessor('created_time', {
        header: t('时间'),
        // 点时间开详情 —— 同操作日志页，比额外加一列「查看」省地方
        cell: ({ row, getValue }) => (
          <button
            type="button"
            data-testid={`open-detail-${row.original.id}`}
            onClick={() => setDetail(row.original.id)}
            className="font-mono text-xs text-primary tabular-nums underline-offset-2 hover:underline"
          >
            {formatDateTime(getValue())}
          </button>
        ),
      }),
      col.accessor('phone', {
        header: t('手机号'),
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
      }),
      col.accessor('template', {
        header: t('业务模板'),
        cell: ({ getValue, row }) => (
          <span className="font-mono text-xs">
            {getValue()}
            {row.original.template_id ? <span className="ms-1 text-muted-foreground">{row.original.template_id}</span> : null}
          </span>
        ),
      }),
      col.accessor('provider', {
        header: t('厂商'),
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
      }),
      col.accessor('status', {
        header: t('状态'),
        cell: ({ getValue, row }) => <StatusBadgeFor status={getValue()} stale={row.original.stale} />,
      }),
      col.accessor('error_kind', {
        header: t('错误类型'),
        cell: ({ getValue }) => {
          const v = getValue()
          return v ? <span className="text-xs">{t(ERROR_KIND_LABELS[v] ?? v)}</span> : <span className="text-muted-foreground">—</span>
        },
      }),
      col.accessor('provider_code', {
        header: t('厂商码'),
        cell: ({ getValue, row }) => (
          <span className="block max-w-xs truncate font-mono text-xs text-muted-foreground" title={row.original.provider_msg ?? ''}>
            {getValue() ?? '—'}
          </span>
        ),
      }),
      col.accessor('duration_ms', {
        header: t('耗时'),
        cell: ({ getValue }) => {
          const v = getValue()
          return <span className="tabular-nums">{v === null ? '—' : `${v}ms`}</span>
        },
      }),
    ],
    [page, size, t],
  )

  const [columnOrder, setColumnOrder] = useUrlColumnOrder(
    search.cols,
    React.useCallback((cols) => onSearchChange?.({ ...search, cols }), [onSearchChange, search]),
    columns,
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility, columnOrder },
    getRowId: (r: SmsLog) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
  })

  const hasFilter = countActive(q.applied, fields) > 0

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-4 content-scroll:min-h-0">
        <PageHeader title={t('发送日志')} description={t('每一次短信发送都会留痕，失败也记。点一行看完整手机号和厂商原文。')} />

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
                <ClearLogsButton kind="sms" filtered={hasFilter} total={data?.total ?? 0} iconOnly />
                <RefreshButton busy={isFetching} onClick={list.onRetry} />
                <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
              </>
            }
            viewsStorageKey="qb:sms-log"
          />

          <div
            data-testid="sms-log-table"
            data-fetching={isFetching}
            className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
          >
            <DataTable
              table={table}
              showColumnVisibility={false}
              rows={table.getRowModel().rows}
              columnCount={columns.length}
              emptyMessage={t('没有匹配的发送记录')}
              emptyAction={
                hasFilter ? <ResetButton variant="outline" testId="empty-clear-filter" label={t('清除筛选')} onClick={q.reset} /> : undefined
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

      <SmsLogDetailSheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} id={detail} />
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import { IconSend } from '@tabler/icons-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'
import { toast } from '@admin/ui/components/toast'

import { Can } from '../../auth/can'
import { usePerm } from '../../auth/use-perm'
import { PageHeader } from '../../shell/page-header'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { logFeatures as features } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { useUrlColumnOrder } from '../_shared/use-column-order'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useQuerySearch } from '../_shared/use-query-search'
import { CHANNELS, policiesQuery } from '../notify-policy/api'
import { channelLabel } from '../notify-policy/labels'
import { DELIVERY_STATUSES, RESENDABLE, deliveriesQuery, deliveryKeys, useResendDelivery, type Delivery } from './api'
import { DeliveryDetailSheet } from './detail-sheet'
import { DeliveryStatusPill, reasonLabel, statusMeta } from './status'

const COLUMN_LABELS = {
  seq: '序号',
  created_time: '时间',
  kind: '通知类型',
  channel: '渠道',
  address: '地址',
  status: '状态',
  reason: '原因',
  attempts: '尝试',
  next_attempt_time: '下一次',
  actions: '操作',
}

export type NotifyDeliverySearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key */
  kind?: string
  channel?: string
  status?: string
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

const col = createColumnHelper<typeof features, Delivery>()

/**
 * 通知投递记录（#166）。审计记录那一类（pages 分册「批量操作」表）：只读、倒序、分页，不给勾选删除，
 * 按保留期自动清（参数配置「通知推送」组）。失败 / 结果未知的行可以逐条重发。
 *
 * 列表里地址是掩码，点时间看详情（完整地址、正文、错误原文在那里）。
 */
export function NotifyDeliveryPage({
  search = {},
  onSearchChange,
}: {
  search?: NotifyDeliverySearch
  onSearchChange?: (next: NotifyDeliverySearch) => void
}) {
  const { t } = useTranslation()
  const { can } = usePerm()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback((n: Partial<NotifyDeliverySearch>) => onSearchChange?.({ ...search, ...n }), [onSearchChange, search])
  const [detail, setDetail] = React.useState<string | null>(null)
  const resend = useResendDelivery()

  // 类型下拉要读策略矩阵（行 = 注册过的类型）；没有那个权限就退成文本框，照样能按类型码筛
  const canPolicies = can('sys:notification:policy:list')
  const kindsQuery = useQuery({ ...policiesQuery(), enabled: canPolicies })
  const kindLabel = React.useMemo(() => new Map((kindsQuery.data ?? []).map((k) => [k.kind, k.label])), [kindsQuery.data])

  const fields = React.useMemo<FilterField[]>(
    () => [
      canPolicies
        ? {
            key: 'kind',
            label: '通知类型',
            type: 'select',
            group: '通知',
            defaultVisible: true,
            optionsLoading: kindsQuery.isPending,
            options: (kindsQuery.data ?? []).filter((k) => !k.broadcast).map((k) => ({ value: k.kind, label: k.label })),
          }
        : { key: 'kind', label: '通知类型', type: 'text', group: '通知', defaultVisible: true, placeholder: 'workflow.remind' },
      {
        key: 'channel',
        label: '渠道',
        type: 'select',
        group: '通知',
        defaultVisible: true,
        options: CHANNELS.filter((c) => c !== 'inapp').map((c) => ({ value: c, label: channelLabel(t, c) })),
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        group: '结果',
        defaultVisible: true,
        options: DELIVERY_STATUSES.map((s) => ({ value: s, label: statusMeta(t, s).label })),
      },
      { key: 'time', label: '时间', type: 'dateTimeRange', group: '时间', defaultVisible: true, rangeParams: ['start_time', 'end_time'] },
    ],
    [canPolicies, kindsQuery.data, kindsQuery.isPending, t],
  )

  const q = useQuerySearch({ fields, search, onSearchChange, refreshKey: deliveryKeys.all, keep: ['hide', 'cols'] })
  const qs = buildQuery(q.params, search.page, search.size)
  const listQuery = useQuery(deliveriesQuery(qs))
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search]),
  )

  const doResend = React.useCallback(
    async (id: string) => {
      try {
        await resend.mutateAsync(id)
        toast.success(t('已重新排队，稍后发出'))
      } catch {
        /* 已由全局 toast 展示（硬纪律 9） */
      }
    },
    [resend, t],
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
      col.accessor('kind', {
        header: t('通知类型'),
        cell: ({ getValue, row }) => {
          const label = kindLabel.get(getValue())
          return (
            <span className="flex flex-col">
              <span className="max-w-xs truncate text-sm" title={row.original.title}>
                {label ? t(label) : row.original.title}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{getValue()}</span>
            </span>
          )
        },
      }),
      col.accessor('channel', {
        header: t('渠道'),
        cell: ({ getValue }) => channelLabel(t, getValue()),
      }),
      col.accessor('address', {
        header: t('地址'),
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() ?? '—'}</span>,
      }),
      col.accessor('status', {
        header: t('状态'),
        cell: ({ getValue }) => <DeliveryStatusPill status={getValue()} />,
      }),
      col.accessor('reason', {
        header: t('原因'),
        cell: ({ getValue, row }) => (
          <span className="block max-w-xs truncate text-xs" title={row.original.last_error ?? ''}>
            {reasonLabel(t, getValue())}
          </span>
        ),
      }),
      col.accessor('attempts', {
        header: t('尝试'),
        cell: ({ getValue }) => <span className="tabular-nums">{getValue()}</span>,
      }),
      col.accessor('next_attempt_time', {
        header: t('下一次'),
        cell: ({ getValue }) => <span className="font-mono text-xs tabular-nums">{formatDateTime(getValue())}</span>,
      }),
      col.display({
        id: 'actions',
        header: t('操作'),
        cell: ({ row }) =>
          RESENDABLE.has(row.original.status) ? (
            <Can perm="sys:notification:delivery:resend">
              <Button
                variant="ghost"
                size="sm"
                data-testid={`resend-${row.original.id}`}
                onClick={() => void doResend(row.original.id)}
              >
                <IconSend />
                {t('重发')}
              </Button>
            </Can>
          ) : null,
      }),
    ],
    [page, size, t, kindLabel, doResend],
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
    getRowId: (r: Delivery) => r.id,
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
        <PageHeader
          title={t('投递记录')}
          description={t('通知走邮件 / 短信的每一次投递都留痕，跳过和失败也记。点时间看完整地址和错误原文。')}
        />

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
            viewsStorageKey="qb:notify-delivery"
          />

          <div
            data-testid="notify-delivery-table"
            data-fetching={isFetching}
            className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
          >
            <DataTable
              table={table}
              showColumnVisibility={false}
              rows={table.getRowModel().rows}
              columnCount={columns.length}
              emptyMessage={t('没有匹配的投递记录')}
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

      <DeliveryDetailSheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} id={detail} />
    </div>
  )
}

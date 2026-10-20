import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { PageHeader } from '../../shell/page-header'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { logFeatures as features } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { StatusPill } from '../_shared/status'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useQuerySearch } from '../_shared/use-query-search'
import { INVOCATION_STATUS, toolLogKeys, toolLogsQuery, type ToolInvocation } from './api'

const FIELDS: FilterField[] = [
  {
    key: 'tool_name',
    label: '工具',
    type: 'text',
    group: '调用',
    defaultVisible: true,
    placeholder: '模糊匹配',
  },
  {
    key: 'status',
    label: '结果',
    type: 'select',
    group: '调用',
    defaultVisible: true,
    // 选项从同一份 INVOCATION_STATUS 生成，不另抄一遍数值 ——
    // 后端枚举改了，筛选项和表格里的药丸一起动
    options: Object.entries(INVOCATION_STATUS).map(([value, meta]) => ({ value: Number(value), label: meta.label })),
  },
  {
    key: 'time',
    label: '调用时间',
    type: 'dateTimeRange',
    group: '时间',
    defaultVisible: true,
    rangeParams: ['start_time', 'end_time'],
  },
]

const COLUMN_LABELS = {
  seq: '序号',
  created_time: '调用时间',
  tool_name: '工具',
  channel: '入口',
  status: '结果',
  permission_code: '权限码',
  params_redacted: '入参（已脱敏）',
  duration_ms: '耗时',
}

export type AiToolLogSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key */
  tool_name?: string
  status?: number
  time?: string
  /** 摆开但没填值的格子 */
  f?: string
  /** 被隐藏的列 id，逗号分隔 */
  hide?: string
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

const col = createColumnHelper<typeof features, ToolInvocation>()

/**
 * AI 工具调用日志（审计）。
 *
 * 只读、倒序、分页。刻意不做成可编辑/可删除的：它是「AI 到底对系统做了什么」
 * 的唯一凭据，能改的审计等于没有审计。
 *
 * 查询区照 `log-opera` 那一套（QueryBar + DataTable）——它和操作日志是同一类页面，
 * 长得一样就该行为一样，自己另造一套轻量筛选只会多出第三种脾气。
 */
export function AiToolLogPage({
  search = {},
  onSearchChange,
}: {
  search?: AiToolLogSearch
  onSearchChange?: (next: AiToolLogSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<AiToolLogSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search],
  )

  const q = useQuerySearch({
    fields: FIELDS,
    search,
    onSearchChange,
    refreshKey: toolLogKeys.all,
    keep: ['hide'],
  })

  const qs = buildQuery(q.params, search.page, search.size)
  const listQuery = useQuery(toolLogsQuery(qs))
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  // 列显隐进 URL —— 隐掉几列后刷新全冒出来，等于每次都要重新点一遍
  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search]),
  )

  const columns = React.useMemo(
    () => [
      col.display({
        id: 'seq',
        header: t('序号'),
        cell: ({ row }) => (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {(page - 1) * size + row.index + 1}
          </span>
        ),
      }),
      col.accessor('created_time', {
        header: t('调用时间'),
        // 时间一律过 formatDateTime，不裸渲染 ISO 串（pages 分册那条）
        cell: ({ getValue }) => <span className="tabular-nums">{formatDateTime(getValue())}</span>,
      }),
      col.accessor('tool_name', {
        header: t('工具'),
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
      }),
      col.accessor('channel', {
        header: t('入口'),
        // 外部系统的调用身份是它**声明**的，这一列让「谁替谁调的」一眼可见
        cell: ({ getValue }) => {
          const v = getValue()
          return v ? <span className="font-mono text-xs">{v}</span> : <span className="text-muted-foreground">{t('网页对话')}</span>
        },
      }),
      col.accessor('status', {
        header: t('结果'),
        cell: ({ getValue }) => {
          const meta = INVOCATION_STATUS[getValue()] ?? INVOCATION_STATUS[1]!
          return <StatusPill tone={meta.tone}>{t(meta.label)}</StatusPill>
        },
      }),
      col.accessor('permission_code', {
        header: t('权限码'),
        cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue() ?? '—'}</span>,
      }),
      col.accessor('params_redacted', {
        header: t('入参（已脱敏）'),
        cell: ({ getValue }) => (
          <span className="block max-w-xs truncate font-mono text-xs" title={getValue() ?? ''}>
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

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility },
    getRowId: (r: ToolInvocation) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    // 只读列表 —— 没有批量操作就不开行选中（开着但没有复选框列，
    // 分页条上那句「已选 N 项」会永远显示 0）
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
  })

  const hasFilter = countActive(q.applied, FIELDS) > 0

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-4 content-scroll:min-h-0">
        <PageHeader
          title={t('调用日志')}
          description={t('AI 每一次工具调用都会留痕，包括被权限拦下的那些。')}
        />

        {/* 查询区和表格是同一个块的两半（筛选 → 结果），所以包一层用 gap-4；
            这一层也必须能收缩 —— 「只滚表格行」那条链断一层就整条失效 */}
        <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
          <QueryBar
            fields={FIELDS}
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
            viewsStorageKey="qb:ai-tool-log"
          />

          <div
            data-testid="ai-tool-log-table"
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
                  <ResetButton
                    variant="outline"
                    testId="empty-clear-filter"
                    label={t('清除筛选')}
                    onClick={q.reset}
                  />
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
  )
}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTable } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { IconUserShare } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { Can } from '../../auth/can'
import { PageHeader } from '../../shell/page-header'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { logFeatures } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useUrlColumnOrder } from '../_shared/use-column-order'
import { useQuerySearch } from '../_shared/use-query-search'
import { definitionsQuery, monitorQuery, workflowKeys, type InstanceStatus } from '../workflow/api'
import { InstanceSheet } from '../workflow/instance-sheet'
import { INSTANCE_STATUS } from '../workflow/status'
import { COLUMN_LABELS, buildColumns } from './columns'
import { HandoverDialog } from './handover-dialog'

export type WorkflowMonitorSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key（出参名见各字段的 param / rangeParams） */
  keyword?: string
  definition?: string
  initiator?: string
  status?: InstanceStatus
  time?: string
  f?: string
  hide?: string
  /** 可移动列的顺序（和默认一样时不写），逗号分隔 */
  cols?: string
  /** 打开的详情 */
  id?: string
}

/**
 * 实例监控：管理员看全部审批单、终止 / 改办理人（详情里，按能力信封出）、离职交接（页头）。
 *
 * 版式照用户管理页（`user/index.tsx`）：查询区（QueryBar）+ 工具行 + DataTable，
 * 「内容区滚动」模式下只有表格行滚，表头和分页条钉住。
 */
export function WorkflowMonitorPage({
  search = {},
  onSearchChange,
}: {
  search?: WorkflowMonitorSearch
  onSearchChange?: (next: WorkflowMonitorSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (next: Partial<WorkflowMonitorSearch>) => onSearchChange?.({ ...search, ...next }),
    [onSearchChange, search]
  )
  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search])
  )
  const [handover, setHandover] = React.useState(false)

  // 流程下拉的选项。没有 workflow:definition:list 的人取不到 —— 那就是个空下拉，筛选照样能用别的条件
  const defs = useQuery(definitionsQuery())
  const fields = React.useMemo<FilterField[]>(
    () => [
      { key: 'keyword', label: '标题 / 摘要', type: 'text', group: '内容', defaultVisible: true, placeholder: '模糊匹配' },
      {
        key: 'definition',
        label: '流程',
        type: 'select',
        group: '内容',
        defaultVisible: true,
        param: 'definition_id',
        optionsLoading: defs.isPending,
        // ⚠️ 雪花 ID 当字符串（硬纪律 6）
        options: (defs.data ?? []).map((d) => ({ value: d.id, label: d.name })),
      },
      { key: 'initiator', label: '发起人', type: 'text', group: '人', defaultVisible: true, placeholder: '姓名或用户名' },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        group: '状态',
        defaultVisible: true,
        options: Object.entries(INSTANCE_STATUS).map(([value, v]) => ({ value, label: v.label })),
      },
      {
        key: 'time',
        label: '发起时间',
        type: 'dateTimeRange',
        group: '时间',
        defaultVisible: true,
        rangeParams: ['start_time', 'end_time'],
      },
    ],
    [defs.data, defs.isPending]
  )

  const q = useQuerySearch({ fields, search, onSearchChange, keep: ['hide', 'cols'], refreshKey: workflowKeys.all })
  const listQuery = useQuery(monitorQuery({ page, size, ...(q.params as Record<string, string | number | undefined>) }))
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []
  const total = data?.total ?? 0

  const columns = React.useMemo(() => buildColumns((r) => patch({ id: r.id }), t), [patch, t])
  // 列顺序进 URL（同列显隐）—— 走 onSearchChange 而不是 patch：换列序不该清勾选、也不该跳回第一页
  const [columnOrder, setColumnOrder] = useUrlColumnOrder(
    search.cols,
    React.useCallback((cols) => onSearchChange?.({ ...search, cols }), [onSearchChange, search]),
    columns
  )

  const table = useTable({
    features: logFeatures,
    data: rows,
    columns: columns as never,
    state: { columnVisibility, columnOrder },
    getRowId: (row) => row.id,
    manualPagination: true,
    rowCount: total,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
  })
  const hasFilter = countActive(q.applied, fields) > 0

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t('实例监控')} description={t('查看全部审批单，处理卡住的待办。')} />
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            <QueryBar
              fields={fields}
              value={q.value}
              onChange={q.setValue}
              onSearch={q.submit}
              onReset={q.reset}
              applied={q.applied}
              loading={isFetching}
              viewsStorageKey="qb:wf-monitor"
              actions={
                <>
                  {/* 离职交接 = 批量改办理人，权限码同详情里的「改办理人」 */}
                  <Can perm="workflow:instance:reassign">
                    <Button size="sm" variant="outline" onClick={() => setHandover(true)} data-testid="wf-handover">
                      <IconUserShare className="size-4" />
                      {t('离职交接')}
                    </Button>
                  </Can>
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                </>
              }
            />
            <div
              data-testid="wf-monitor-table"
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                columnLabels={COLUMN_LABELS}
                rowAttributes={(row) => ({ 'data-testid': `wf-monitor-row-${row.original.id}` })}
                emptyMessage={t('没有匹配的审批单')}
                emptyAction={
                  hasFilter ? (
                    <ResetButton variant="outline" label={t('清除筛选')} onClick={q.reset} />
                  ) : undefined
                }
                {...list}
                pagination={{
                  pageIndex: page - 1,
                  pageCount: Math.max(1, data?.total_pages ?? 1),
                  pageSize: size,
                  totalCount: total,
                  onPageChange: (i) => patch({ page: i === 0 ? undefined : i + 1 }),
                  onPageSizeChange: (s) => patch({ size: s, page: undefined }),
                }}
              />
            </div>
          </div>
        </div>
      </div>
      <InstanceSheet id={search.id ?? null} onClose={() => patch({ id: undefined })} />
      <HandoverDialog open={handover} onOpenChange={setHandover} />
    </div>
  )
}

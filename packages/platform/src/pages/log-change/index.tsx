import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import { IconExternalLink } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { CopyButton } from '@admin/ui/components/copy-button'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'

import { api, type PageData } from '../../api-client/client'
import { Can } from '../../auth/can'
import { usePerm } from '../../auth/use-perm'
import { PageHeader } from '../../shell/page-header'
import { EmptyCell, TimeCell } from '../_shared/cells'
import {
  type DataChange,
  type DataChangeItem,
  type DataChangeMeta,
  dataChangeKeys,
  dataChangeMetaQuery,
} from '../_shared/data-change/api'
import { ACTION_LABEL, ActionPill, ChangeList } from '../_shared/data-change/change-list'
import { ChangeMeta, useSourceLabel } from '../_shared/data-change/history-sheet'
import { ExportButton } from '../_shared/data-io/export-button'
import { DetailSection } from '../_shared/detail-sheet'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState, usePageRecovery } from '../_shared/list-query'
import { logFeatures as features } from '../_shared/log-features'
import { ListBody, PageShell } from '../_shared/page-shell'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { StatusPill } from '../_shared/status'
import { useUrlColumnOrder } from '../_shared/use-column-order'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useQuerySearch } from '../_shared/use-query-search'
import { IntegrityCheck } from './integrity'

export type DataChangeSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key */
  entity_type?: string
  /** 雪花 ID：字符串，不许 Number()（硬纪律 6） */
  entity_id?: string
  actor?: string
  action?: string
  source?: string
  field?: string
  trace_id?: string
  time?: string
  f?: string
  hide?: string
  cols?: string
}

const col = createColumnHelper<typeof features, DataChange>()

const COLUMN_LABELS = {
  created_time: '时间',
  entity: '对象',
  action: '动作',
  fields: '改了什么',
  actor_name: '操作人',
  source: '来源',
  ip: 'IP 地址',
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

function useFields(meta: DataChangeMeta | undefined, pending: boolean): FilterField[] {
  return React.useMemo<FilterField[]>(() => {
    // 不同对象有同名字段（状态 / 备注…），按字段名去重；中文名取第一个
    const fieldOptions = new Map<string, string>()
    for (const e of meta?.entities ?? []) {
      for (const f of e.fields) if (!fieldOptions.has(f.field)) fieldOptions.set(f.field, f.label)
    }
    return [
      {
        key: 'entity_type',
        label: '对象类型',
        type: 'select',
        group: '对象',
        defaultVisible: true,
        optionsLoading: pending,
        options: (meta?.entities ?? []).map((e) => ({ value: e.entity, label: e.title })),
      },
      {
        key: 'field',
        label: '改过的字段',
        type: 'select',
        group: '对象',
        defaultVisible: true,
        optionsLoading: pending,
        options: [...fieldOptions].map(([value, label]) => ({ value, label, hint: value })),
      },
      { key: 'entity_id', label: '对象 ID', type: 'text', group: '对象' },
      { key: 'actor', label: '操作人', type: 'text', group: '谁', defaultVisible: true, placeholder: '模糊匹配' },
      {
        key: 'source',
        label: '来源',
        type: 'select',
        group: '谁',
        optionsLoading: pending,
        options: (meta?.sources ?? []).map((s) => ({ value: s.value, label: s.label })),
      },
      {
        key: 'action',
        label: '动作',
        type: 'select',
        group: '对象',
        options: Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label })),
      },
      { key: 'trace_id', label: '请求跟踪 ID', type: 'text', group: '谁' },
      {
        key: 'time',
        label: '时间',
        type: 'dateTimeRange',
        group: '时间',
        defaultVisible: true,
        rangeParams: ['start_time', 'end_time'],
      },
    ]
  }, [meta, pending])
}

/** 「数据变更」页（#260）：谁、什么时候、从哪来，把哪个对象的哪个字段从什么改成了什么。只读审计记录，不给删 */
export function LogChangePage({
  search = {},
  onSearchChange,
}: {
  search?: DataChangeSearch
  onSearchChange?: (n: DataChangeSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<DataChangeSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  const meta = useQuery(dataChangeMetaQuery())
  const fields = useFields(meta.data, meta.isPending)
  const entityTitle = React.useCallback(
    (entity: string) => {
      const title = meta.data?.entities.find((e) => e.entity === entity)?.title
      return title ? t(title) : entity
    },
    [meta.data, t]
  )
  const sourceLabel = useSourceLabel()
  const { isSuperuser } = usePerm()

  const q = useQuerySearch({ fields, search, onSearchChange, refreshKey: dataChangeKeys.all, keep: ['hide', 'cols'] })
  const qs = buildQuery(q.params, search.page, search.size)
  const listQuery = useQuery({
    queryKey: [...dataChangeKeys.all, 'list', qs],
    queryFn: () => api.GET<PageData<DataChange>>(`/api/v1/logs/changes?${qs}`),
    placeholderData: (prev) => prev,
  })
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  usePageRecovery(listQuery, { page, size, onPageChange: (page) => patch({ page: page === 1 ? undefined : page }) })
  const rows = data?.items ?? []

  // 详情抽屉：挂载（`detail`）和打开（`detailOpen`）分开管。正常关只翻 `detailOpen`，留着内容走完退场动画；
  // 从抽屉里的链接跳去别的页时连 `detail` 一起清 —— 整个卸载，不等动画（见 `DataChangeDetailSheet` 的 `onLeave`）
  const [detail, setDetail] = React.useState<DataChange | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)
  const openDetail = React.useCallback((r: DataChange) => {
    setDetail(r)
    setDetailOpen(true)
  }, [])
  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search])
  )

  /** 详情里点字段名 = 这个对象这一个字段的历史（单字段历史，条件进地址栏，能分享） */
  const focusField = React.useCallback(
    (r: DataChange, c: DataChangeItem) => {
      if (!r.entity_id) return
      setDetailOpen(false)
      // 🔴 只留对象 + 字段，别的筛选条件（trace_id、动作、时间段…）一律清掉：带着它们的话「这个字段的历史」
      // 被悄悄缩成原来那个筛选范围里的一两条，分享出去的链接也带着（评审抓到的）。列显隐 / 顺序 / 每页条数是视图状态，留着
      onSearchChange?.({
        size: search.size,
        hide: search.hide,
        cols: search.cols,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        field: c.field,
      })
    },
    [onSearchChange, search]
  )

  /** 点对象名 = 只看这一个对象的记录（换条件就回到第一页） */
  const focusEntity = React.useCallback(
    (r: DataChange) => {
      if (!r.entity_id) return
      onSearchChange?.({ ...search, entity_type: r.entity_type, entity_id: r.entity_id, page: undefined })
    },
    [onSearchChange, search]
  )

  const columns = React.useMemo(
    () => [
      col.accessor('created_time', {
        header: t('时间'),
        cell: ({ row, getValue }) => (
          <TimeCell value={getValue()} onOpen={() => openDetail(row.original)} testId={`open-change-${row.original.id}`} />
        ),
      }),
      col.accessor((r) => r.entity_label ?? '', {
        id: 'entity',
        header: t('对象'),
        cell: ({ row }) => {
          const r = row.original
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              <StatusPill tone="muted">{entityTitle(r.entity_type)}</StatusPill>
              {r.action === 'bulk' ? (
                <span className="text-sm text-muted-foreground">{t('{{n}} 条', { n: r.entity_label ?? '?' })}</span>
              ) : (
                <button
                  type="button"
                  className="max-w-40 truncate text-sm font-medium hover:underline"
                  title={t('只看这个对象的记录')}
                  onClick={() => focusEntity(r)}
                  data-testid={`focus-entity-${r.id}`}
                >
                  {r.entity_label ?? r.entity_id}
                </button>
              )}
            </span>
          )
        },
      }),
      col.accessor('action', {
        header: t('动作'),
        cell: ({ getValue }) => <ActionPill action={getValue()} />,
      }),
      col.accessor((r) => (r.changes ?? []).map((c) => c.label), {
        id: 'fields',
        header: t('改了什么'),
        cell: ({ getValue }) => {
          const labels = getValue().map((l) => t(l))
          return labels.length ? (
            <span className="block max-w-72 truncate text-sm" title={labels.join('、')}>
              {labels.join('、')}
            </span>
          ) : (
            <EmptyCell />
          )
        },
      }),
      col.accessor((r) => r.actor_name ?? '', {
        id: 'actor_name',
        header: t('操作人'),
        cell: ({ getValue }) => <span className="text-sm">{getValue() || t('系统')}</span>,
      }),
      col.accessor('source', {
        header: t('来源'),
        cell: ({ row, getValue }) => (
          <span className="text-sm text-muted-foreground" title={row.original.source_ref ?? undefined}>
            {sourceLabel(getValue())}
          </span>
        ),
      }),
      col.accessor((r) => r.ip ?? '', {
        id: 'ip',
        header: t('IP 地址'),
        cell: ({ getValue }) =>
          getValue() ? <span className="font-mono text-xs tabular-nums">{getValue()}</span> : <EmptyCell />,
      }),
    ],
    [t, entityTitle, sourceLabel, focusEntity, openDetail]
  )

  const [columnOrder, setColumnOrder] = useUrlColumnOrder(
    search.cols,
    React.useCallback((cols) => onSearchChange?.({ ...search, cols }), [onSearchChange, search]),
    columns
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility, columnOrder },
    getRowId: (r: DataChange) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    // 审计记录只读：不给勾选删除（删单条审计记录等于篡改审计，pages 分册「批量操作」那张表）
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
  })

  const hasFilter = countActive(q.applied, fields) > 0

  return (
    <PageShell fill="always">
      <PageHeader
        title={t('数据变更')}
        description={t('谁、什么时候、从哪来，把哪个对象的哪个字段从什么改成了什么。点时间看完整的字段对比。')}
      />
      <ListBody>
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
              <Can perm="log:change:export">
                <ExportButton
                  path="/api/v1/logs/changes/export"
                  filters={q.params}
                  total={data?.total}
                  iconOnly
                  testId="export-changes"
                />
              </Can>
              {isSuperuser && <IntegrityCheck />}
              <RefreshButton busy={isFetching} onClick={list.onRetry} />
              <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
            </>
          }
          viewsStorageKey="qb:log-change"
        />
        <div
          data-testid="change-table"
          data-fetching={isFetching}
          className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
        >
          <DataTable
            table={table}
            showColumnVisibility={false}
            rows={table.getRowModel().rows}
            columnCount={columns.length}
            emptyMessage={hasFilter ? t('没有匹配的变更记录') : t('还没有变更记录。这个功能上线之前的修改没有记录')}
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
      </ListBody>

      {detail && (
        <DataChangeDetailSheet
          record={detail}
          open={detailOpen}
          entityTitle={entityTitle(detail.entity_type)}
          onOpenChange={setDetailOpen}
          onFieldHistory={focusField}
          onLeave={() => setDetail(null)}
        />
      )}
    </PageShell>
  )
}

/**
 * 一条变更记录的详情：字段对比 + 出处。
 *
 * 🔴 从这里的链接跳去操作日志时要 `onLeave` —— 父组件把整个抽屉卸载掉，不是只关。
 * 关闭和切 tab 落在同一次提交里：抽屉刚翻成「关」，这个 tab 就进了后台、effect 被 `<Activity>` 销毁，
 * Base UI 等不到退场动画结束，portal（挂在 `<body>` 上）就一直留在前台，关不掉也点不动。
 * 原来连「关」都没做，抽屉开着压在操作日志页上（见 shell 分册「从浮层里 `<Link>` 跳走」）
 */
function DataChangeDetailSheet({
  record,
  open,
  entityTitle,
  onOpenChange,
  onFieldHistory,
  onLeave,
}: {
  record: DataChange
  open: boolean
  entityTitle: string
  onOpenChange: (o: boolean) => void
  onFieldHistory: (record: DataChange, change: DataChangeItem) => void
  onLeave: () => void
}) {
  const { t } = useTranslation()
  // 定时任务 / CLI 里的修改没有请求，trace_id 是占位的 `-`（`TRACE_ID_LOG_DEFAULT_VALUE`）
  const traced = !!record.trace_id && record.trace_id !== '-'
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl" data-testid="data-change-detail">
        <SheetHeader>
          <SheetTitle>
            {entityTitle} · {record.action === 'bulk' ? t('{{n}} 条', { n: record.entity_label ?? '?' }) : record.entity_label}
          </SheetTitle>
          <SheetDescription className="sr-only">{t('这一条变更记录的字段对比和出处')}</SheetDescription>
          <ChangeMeta record={record} />
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
          <DetailSection title={t('字段变化')}>
            <ChangeList
              record={record}
              // 批量汇总行没有具体对象，看不了「这个对象的这个字段」
              onFieldClick={record.entity_id ? (c) => onFieldHistory(record, c) : undefined}
            />
          </DetailSection>
          <DetailSection title={t('出处')}>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t('IP 地址')}</dt>
              <dd className="font-mono text-xs">{record.ip ?? '—'}</dd>
              {record.source_ref && (
                <>
                  <dt className="text-muted-foreground">{t('来源的引用')}</dt>
                  <dd className="font-mono text-xs break-all">{record.source_ref}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('请求跟踪 ID')}</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-xs">{record.trace_id}</span>
                <CopyButton text={record.trace_id} />
                {traced && (
                  // 跟在复制按钮后面，和它同一个形状（图标 + 悬停提示）：拿着这个 ID 能做的两件事放在一起
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    nativeButton={false}
                    render={<Link to="/log/opera" search={{ trace_id: record.trace_id }} onClick={onLeave} />}
                    aria-label={t('看这次请求的操作日志')}
                    title={t('看这次请求的操作日志')}
                    data-testid="change-to-opera-log"
                  >
                    <IconExternalLink className="size-3.5" />
                  </Button>
                )}
              </dd>
            </dl>
          </DetailSection>
        </div>
      </SheetContent>
    </Sheet>
  )
}

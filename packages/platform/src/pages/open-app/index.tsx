import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import {
  IconDotsVertical,
  IconFileDescription,
  IconHistory,
  IconLoader2,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { logFeatures as features } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { StatusPill, type Tone } from '../_shared/status'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useUrlColumnOrder } from '../_shared/use-column-order'
import { useQuerySearch } from '../_shared/use-query-search'
import {
  downloadOpenApiDoc,
  openAppKeys,
  openAppsQuery,
  useDeleteOpenApp,
  useResetOpenAppSecret,
  type IssuedSecret,
  type OpenApp,
} from './api'
import { OpenAppFormSheet } from './form'
import { SecretDialog } from './secret-dialog'

const col = createColumnHelper<typeof features, OpenApp>()

/** 「已过期」不是库里的状态（库里只有启用 / 停用），后端按失效时间算 —— 筛选值 2 也由后端解释 */
const FIELDS: FilterField[] = [
  {
    key: 'name',
    label: '应用',
    type: 'text',
    group: '应用',
    defaultVisible: true,
    placeholder: '名称或编码',
  },
  {
    key: 'status',
    label: '状态',
    type: 'select',
    group: '应用',
    defaultVisible: true,
    options: [
      { value: 1, label: '正常' },
      { value: 0, label: '停用' },
      { value: 2, label: '已过期' },
    ],
  },
]

const STATE_META: Record<OpenApp['state'], { label: string; tone: Tone }> = {
  enabled: { label: '正常', tone: 'success' },
  disabled: { label: '停用', tone: 'muted' },
  expired: { label: '已过期', tone: 'warning' },
}

const COLUMN_LABELS = {
  name: '应用',
  access_key: 'Access Key',
  scopes: '授权接口',
  rate_per_minute: '限流',
  state: '状态',
  expire_time: '失效时间',
  last_used_time: '最近调用',
}

export type OpenAppSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key */
  name?: string
  status?: number
  f?: string
  hide?: string
  /** 可移动列的顺序（和默认一样时不写），逗号分隔 */
  cols?: string
}

function buildQuery(params: Record<string, unknown>, page: number, size: number): string {
  const q = new URLSearchParams({ page: String(page), size: String(size) })
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  return q.toString()
}

export function OpenAppPage({
  search = {},
  onSearchChange,
}: {
  search?: OpenAppSearch
  onSearchChange?: (n: OpenAppSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<OpenAppSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )
  const q = useQuerySearch({ fields: FIELDS, search, onSearchChange, refreshKey: openAppKeys.all, keep: ['hide', 'cols'] })

  const listQuery = useQuery(openAppsQuery(buildQuery(q.params, page, size)))
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  const reset = useResetOpenAppSecret()
  const del = useDeleteOpenApp()
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<OpenApp | null>(null)
  const [issued, setIssued] = React.useState<IssuedSecret | null>(null)
  const [pendingReset, setPendingReset] = React.useState<OpenApp | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<OpenApp | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [exporting, setExporting] = React.useState(false)

  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search])
  )

  function openSheet(target: OpenApp | null) {
    setEditing(target)
    setSheetOpen(true)
  }

  async function exportDoc() {
    if (exporting) return
    setExporting(true)
    setActionError(null)
    try {
      await downloadOpenApiDoc()
    } catch (e) {
      // 硬纪律 9：失败要看得见，不能和「点了没反应」长得一样
      setActionError(e instanceof Error ? e.message : t('导出失败'))
    } finally {
      setExporting(false)
    }
  }

  const columns = React.useMemo(
    () => [
      col.accessor('name', {
        header: t('应用'),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-sm font-medium leading-tight">{row.original.name}</span>
            <span className="font-mono text-xs leading-tight text-muted-foreground">{row.original.code}</span>
          </div>
        ),
      }),
      col.accessor('access_key', {
        header: 'Access Key',
        cell: ({ getValue }) => (
          <span className="flex items-center gap-1">
            <code className="font-mono text-xs" title={getValue()}>
              {getValue().slice(0, 13)}…{getValue().slice(-4)}
            </code>
            <CopyButton text={getValue()} label={t('复制 Access Key')} className="size-6" />
          </span>
        ),
      }),
      col.accessor('scopes', {
        header: t('授权接口'),
        cell: ({ getValue }) => (
          <div className="flex flex-wrap gap-1">
            {getValue().map((s) => (
              <Badge key={s} variant="outline" className="font-mono font-normal">
                {s}
              </Badge>
            ))}
          </div>
        ),
      }),
      col.accessor('rate_per_minute', {
        header: t('限流'),
        cell: ({ getValue }) => (
          <span className="text-sm text-muted-foreground">
            {getValue() ? t('每分钟 {{n}} 次', { n: getValue() }) : t('全局默认')}
          </span>
        ),
      }),
      col.accessor('state', {
        header: t('状态'),
        cell: ({ getValue }) => {
          const meta = STATE_META[getValue()]
          return <StatusPill tone={meta.tone}>{t(meta.label)}</StatusPill>
        },
      }),
      col.accessor('expire_time', {
        header: t('失效时间'),
        cell: ({ getValue }) => (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {getValue() ? formatDateTime(getValue()) : t('永不过期')}
          </span>
        ),
      }),
      col.accessor('last_used_time', {
        header: t('最近调用'),
        cell: ({ row, getValue }) => (
          <Can perm="open:log:list" fallback={<span className="font-mono text-xs">{formatDateTime(getValue())}</span>}>
            {/* 🔴 用 `<Link>` 不用 `useNavigate()`：页面组件要 router-独立（硬纪律 1） */}
            <Link
              to="/open/log"
              search={{ app: row.original.id }}
              className="font-mono text-xs tabular-nums text-primary underline-offset-2 hover:underline"
              data-testid={`open-app-last-used-${row.original.code}`}
            >
              {getValue() ? formatDateTime(getValue()) : t('从未调用')}
            </Link>
          </Can>
        ),
      }),
      col.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('操作')}</span>,
        cell: ({ row }) => {
          const a = row.original
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: a.name })} />
                }
                data-testid={`row-actions-${a.code}`}
              >
                <IconDotsVertical className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <Can perm="open:app:edit">
                  <DropdownMenuItem onClick={() => openSheet(a)} data-testid={`edit-${a.code}`}>
                    <IconPencil className="size-4" />
                    {t('编辑')}
                  </DropdownMenuItem>
                </Can>
                <Can perm="open:log:list">
                  <DropdownMenuItem
                    render={<Link to="/open/log" search={{ app: a.id }} />}
                    data-testid={`logs-${a.code}`}
                  >
                    <IconHistory className="size-4" />
                    {t('调用日志')}
                  </DropdownMenuItem>
                </Can>
                <Can perm="open:app:reset">
                  <DropdownMenuItem onClick={() => setPendingReset(a)} data-testid={`reset-${a.code}`}>
                    <IconRefresh className="size-4" />
                    {t('重置密钥')}
                  </DropdownMenuItem>
                </Can>
                <Can perm="open:app:del">
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setPendingDelete(a)}
                    data-testid={`delete-${a.code}`}
                  >
                    <IconTrash className="size-4" />
                    {t('删除')}
                  </DropdownMenuItem>
                </Can>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      }),
    ],
    [t]
  )

  // 列顺序进 URL（同列显隐）—— 走 onSearchChange 而不是 patch：换列序不该清勾选、也不该跳回第一页
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
    getRowId: (r: OpenApp) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
  })

  const hasFilter = countActive(q.applied, FIELDS) > 0

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          {/* PageHeader 只渲染 sr-only 的 <h1>；说明要让人看见，单独一行（同 MCP 凭据页） */}
          <PageHeader title={t('应用管理')} />
          <p className="text-sm text-muted-foreground">
            {t('给对接的外部系统发一对 AK/SK，它就能带签名调用勾选的开放接口。SK 加密存储，明文只在创建和重置时显示一次。')}
          </p>

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
                  <Can perm="open:app:add">
                    <Button size="sm" onClick={() => openSheet(null)} data-testid="open-app-add">
                      <IconPlus className="size-4" />
                      {t('新增应用')}
                    </Button>
                  </Can>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={exportDoc}
                    aria-busy={exporting}
                    data-testid="open-app-doc"
                  >
                    {exporting ? <IconLoader2 className="size-4 animate-spin" /> : <IconFileDescription className="size-4" />}
                    {t('开放接口文档')}
                  </Button>
                  <Can perm="open:log:list">
                    <Button
                      size="sm"
                      variant="outline"
                      render={<Link to="/open/log" search={{}} />}
                      data-testid="open-app-logs"
                    >
                      <IconHistory className="size-4" />
                      {t('调用日志')}
                    </Button>
                  </Can>
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                </>
              }
              viewsStorageKey="qb:open-app"
            />

            {actionError && (
              <Alert tone="danger" data-testid="open-app-action-error">
                {actionError}
              </Alert>
            )}

            <div
              data-testid="open-app-table"
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                emptyMessage={hasFilter ? t('没有匹配的应用') : t('还没有应用。点「新增应用」给对接的系统发一对密钥')}
                emptyAction={
                  hasFilter ? (
                    <ResetButton variant="outline" testId="empty-clear-filter" label={t('清除筛选')} onClick={q.reset} />
                  ) : undefined
                }
                {...list}
                skeletonRows={5}
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

      <OpenAppFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} onIssued={setIssued} />
      <SecretDialog issued={issued} onClose={() => setIssued(null)} />

      <ConfirmDialog
        open={pendingReset !== null}
        onOpenChange={(o) => !o && setPendingReset(null)}
        title={t('重置密钥')}
        description={t('「{{name}}」现在用的 Secret Key 会立即失效。对方系统换成新的 SK 之前，所有调用都会被拒绝。Access Key 不变。', {
          name: pendingReset?.name ?? '',
        })}
        confirmText={t('确定重置')}
        pending={reset.isPending}
        onConfirm={async () => {
          setActionError(null)
          try {
            if (pendingReset) setIssued(await reset.mutateAsync(pendingReset.id))
          } catch (e) {
            setActionError(e instanceof Error ? e.message : t('重置失败'))
          }
          setPendingReset(null)
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除应用')}
        description={t('确定删除「{{name}}」？它的密钥会立即失效，已有的调用日志保留。', { name: pendingDelete?.name ?? '' })}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          setActionError(null)
          try {
            if (pendingDelete) await del.mutateAsync(pendingDelete.id)
          } catch (e) {
            setActionError(e instanceof Error ? e.message : t('删除失败'))
          }
          setPendingDelete(null)
        }}
      />
    </div>
  )
}

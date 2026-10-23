import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'
import { cn } from '@admin/ui/lib/utils'

import { api, type PageData } from '../../api-client/client'
import { Can } from '../../auth/can'
import { PageHeader } from '../../shell/page-header'
import { ClearLogsButton } from '../_shared/clear-logs'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { useQuerySearch } from '../_shared/use-query-search'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { useUrlColumnOrder } from '../_shared/use-column-order'
import { logFeatures as features } from '../_shared/log-features'
import { StatusPill } from '../_shared/status'
import { LoginLogDetailSheet, formatLocation } from './detail-sheet'
import type { LoginLog } from '../_shared/login-log'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { ExportButton } from '../_shared/data-io/export-button'

/** 这一页列表 query 的 key 前缀。`useQuerySearch` 的 `refreshKey` 也用它 ——
 *  「点搜索必须真的重取」靠让这个前缀失效实现（见 use-query-search.ts） */
const LOG_KEY = ['logs', 'login'] as const

export type { LoginLog }

const col = createColumnHelper<typeof features, LoginLog>()

/**
 * 可筛字段的声明。
 *
 * `key` 是**地址栏里的参数名**，`rangeParams` 才是接口入参名 —— 两者刻意分开：
 * 一个「登录时间」在 URL 里是一个参数、发给后端是两个。
 *
 * ```
 * URL   /log/login?time=2026-08-16~2026-08-22
 * 请求  ?start_time=2026-08-16 00:00:00&end_time=2026-08-22 23:59:59
 * ```
 *
 * 换掉的老写法是 `start_time` / `end_time` 直接当 URL 参数用，地址栏长这样
 * （74 个字符，用户指出过「很乱」）：
 * `?start_time=2026-08-16+00%3A00%3A00&end_time=2026-08-22+23%3A59%3A59&page=1`
 */
const FIELDS: FilterField[] = [
  {
    key: 'username',
    label: '登录账号',
    type: 'text',
    group: '账号',
    defaultVisible: true,
    placeholder: '模糊匹配',
  },
  {
    key: 'ip',
    label: '登录 IP',
    type: 'text',
    group: '账号',
    defaultVisible: true,
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
    key: 'time',
    label: '登录时间',
    type: 'dateTimeRange',
    group: '时间',
    defaultVisible: true,
    rangeParams: ['start_time', 'end_time'],
  },
]

const COLUMN_LABELS = {
  seq: '序号',
  login_time: '登录时间',
  username: '登录账号',
  status: '结果',
  msg: '说明',
  ip: '登录 IP',
  location: '登录地点',
  browser: '浏览器',
  os: '终端系统',
}

export type LoginLogSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key */
  username?: string
  ip?: string
  status?: number
  time?: string
  /** 摆开但没填值的格子（`_shared/use-query-search`） */
  f?: string
  /** 被隐藏的列 id，逗号分隔 */
  hide?: string
  /** 可移动列的顺序（和默认一样时不写），逗号分隔 */
  cols?: string
}

/** 接口入参 —— 名字和精度由后端定，和地址栏那一份没关系 */
function buildQuery(
  params: Record<string, unknown>,
  page: number | undefined,
  size: number | undefined
): string {
  const q = new URLSearchParams()
  q.set('page', String(page ?? 1))
  q.set('size', String(size ?? DEFAULT_PAGE_SIZE))
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  return q.toString()
}

export function LogLoginPage({
  search = {},
  onSearchChange,
}: {
  search?: LoginLogSearch
  onSearchChange?: (n: LoginLogSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<LoginLogSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  /** URL ↔ QueryBar 的胶水：恢复条件、写回地址栏、拼接口入参、搜索时跳回第一页 */
  const q = useQuerySearch({
    fields: FIELDS,
    search,
    onSearchChange,
    refreshKey: LOG_KEY,
    keep: ['hide', 'cols'],
  })

  const qs = buildQuery(q.params, search.page, search.size)
  const listQuery = useQuery({
    queryKey: [...LOG_KEY, qs],
    queryFn: () => api.GET<PageData<LoginLog>>(`/api/v1/logs/login?${qs}`),
    placeholderData: (prev) => prev,
  })
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  const [detail, setDetail] = React.useState<LoginLog | null>(null)
  // 列显隐进 URL —— 12 列的表隐掉几列后刷新全冒出来，等于每次都要重新点一遍
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
      col.accessor('login_time', {
        header: t('登录时间'),
        cell: ({ row, getValue }) => (
          <button
            type="button"
            data-testid={`open-detail-${row.original.id}`}
            onClick={() => setDetail(row.original)}
            className="font-mono text-xs text-primary tabular-nums underline-offset-2 hover:underline"
          >
            {formatDateTime(getValue())}
          </button>
        ),
      }),
      col.accessor('username', {
        header: t('登录账号'),
        cell: ({ getValue }) => <span className="text-sm font-medium">{getValue()}</span>,
      }),
      col.accessor('status', {
        header: t('结果'),
        cell: ({ getValue }) => {
          const ok = getValue() === 1
          return (
            <StatusPill tone={ok ? 'success' : 'danger'} className="gap-1">
              <span className={cn('size-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-destructive')} />
              {ok ? t('成功') : t('失败')}
            </StatusPill>
          )
        },
      }),
      col.accessor('msg', {
        header: t('说明'),
        cell: ({ row, getValue }) => (
          <span
            className={cn('block max-w-40 truncate text-sm', row.original.status === 0 && 'text-destructive')}
            title={t(getValue())}
          >
            {t(getValue())}
          </span>
        ),
      }),
      col.accessor('ip', {
        header: t('登录 IP'),
        cell: ({ getValue }) => <span className="font-mono text-xs tabular-nums">{getValue()}</span>,
      }),
      col.accessor((r) => formatLocation(r), {
        id: 'location',
        header: t('登录地点'),
        cell: ({ getValue }) => <span className="text-sm text-muted-foreground">{getValue()}</span>,
      }),
      col.accessor((r) => r.browser ?? '—', {
        id: 'browser',
        header: t('浏览器'),
        cell: ({ getValue }) => (
          <span className="block max-w-28 truncate text-sm text-muted-foreground" title={getValue()}>
            {getValue()}
          </span>
        ),
      }),
      col.accessor((r) => r.os ?? '—', {
        id: 'os',
        header: t('终端系统'),
        cell: ({ row, getValue }) => (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {getValue()}
            {row.original.device && (
              <Badge variant="outline" className="font-normal">
                {row.original.device}
              </Badge>
            )}
          </span>
        ),
      }),
    ],
    [page, size, t]
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
    getRowId: (r: LoginLog) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    // 只读列表 —— 没有批量操作就不开行选中（开着但没有复选框列，
    // 分页条上那句「已选 N 项」会永远显示 0）
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
  })

  const hasFilter = countActive(q.applied, FIELDS) > 0

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t('登录日志')} description={t('安全审计入口。失败尝试比成功登录更值得看。')} />

          {/*
            🔴 查询区和表格是**同一个块的两半**（筛选 → 结果），所以包一层、
            用 `gap-4`（16px）而不是页面级块之间的 `gap-4 md:gap-6`（24px）：
            查询区内部两行只隔 8px，紧接着就跳 24px 到表格，节奏是断的。

            ⚠️ 这一层也必须能收缩（`content-scroll:min-h-0 flex-1 flex-col`）——
            「只滚表格行」那条链从外壳一直到 `<table>`，中间**断一层就整条失效**
            （表现是「设置生效了，但还是整块在滚」）。
          */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            {/* 查询区不塞进 DataTable 的 toolbar 槽 ——
              toolbar 是一行（和「列」下拉、导出按钮同排），条件网格铺不进去 */}
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
                  {/*
                  这三个是**次要的工具动作**，只留图标：这一行已经有六个控件，
                  留着文字会把主动作（搜索）挤到边上。图标按钮一律配
                  tooltip + aria-label。
                */}
                  {/* 导出走后端（#11）：原来是前端按页拉全量拼 CSV —— 拉到 20 页就停（4,000 行之后静默截断），
                      失败登录记的是**请求里填的**用户名，`=…` 原样进了 CSV（公式注入）。
                      权限码是独立的 log:login:export（原来复用 log:login:del） */}
                  <Can perm="log:login:export">
                    <ExportButton
                      path="/api/v1/logs/login/export"
                      filters={q.params}
                      total={data?.total}
                      iconOnly
                      testId="export-logs"
                    />
                  </Can>
                  {/* 日志只增不减，之前界面上没有任何清理入口 —— 权限码 log:login:clear 一直闲置 */}
                  <ClearLogsButton kind="login" filtered={hasFilter} total={data?.total ?? 0} iconOnly />
                  {/* 「列」下拉从 DataTable 搬过来 —— 它自己那一行就整行消失了 */}
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                </>
              }
              viewsStorageKey="qb:log-login"
            />


            {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
            <div
              data-testid="login-table"
              data-fetching={isFetching}
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                emptyMessage={t('没有匹配的登录记录')}
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

      <LoginLogDetailSheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} log={detail} />
    </div>
  )
}

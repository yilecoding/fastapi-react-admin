import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import { IconDownload, IconLoader2 } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { api, type PageData } from '../../api-client/client'
import { Can } from '../../auth/can'
import { PageHeader } from '../../shell/page-header'
import { ClearLogsButton } from '../_shared/clear-logs'
import { RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { useQuerySearch } from '../_shared/use-query-search'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { logFeatures as features } from '../_shared/log-features'
import { StatusPill } from '../_shared/status'
import { OperaLogDetailSheet, formatLocation } from './detail-sheet'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

/** 这一页列表 query 的 key 前缀。`useQuerySearch` 的 `refreshKey` 也用它 ——
 *  「点搜索必须真的重取」靠让这个前缀失效实现（见 use-query-search.ts） */
const LOG_KEY = ['logs', 'opera'] as const

export type OperaLog = {
  id: string
  trace_id: string
  username: string | null
  method: string
  title: string
  path: string
  ip: string
  country: string | null
  region: string | null
  city: string | null
  user_agent: string | null
  os: string | null
  browser: string | null
  device: string | null
  args: Record<string, unknown> | null
  request_headers: Record<string, string> | null
  response_headers: Record<string, string> | null
  response_body: string | null
  status: number
  code: string
  msg: string | null
  cost_time: number
  opera_time: string
}

const col = createColumnHelper<typeof features, OperaLog>()
const METHOD_CLASS: Record<string, string> = {
  GET: 'text-sky-700 dark:text-sky-300 bg-sky-500/10 ring-sky-500/25',
  POST: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 ring-emerald-500/25',
  PUT: 'text-amber-700 dark:text-amber-300 bg-amber-500/10 ring-amber-500/25',
  DELETE: 'text-destructive bg-destructive/10 ring-destructive/25',
}

/** 和登录日志同一套写法：`key` 是地址栏参数名，`rangeParams` 才是接口入参名 */
const FIELDS: FilterField[] = [
  {
    key: 'username',
    label: '操作人',
    type: 'text',
    group: '账号',
    defaultVisible: true,
    placeholder: '模糊匹配',
  },
  {
    key: 'ip',
    label: '操作 IP',
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
      { value: 0, label: '异常' },
    ],
  },
  {
    key: 'time',
    label: '操作时间',
    type: 'dateTimeRange',
    group: '时间',
    defaultVisible: true,
    rangeParams: ['start_time', 'end_time'],
  },
]

const COLUMN_LABELS = {
  seq: '序号',
  opera_time: '操作时间',
  username: '操作人',
  title: '操作内容',
  method: '方法',
  path: '接口',
  status: '状态',
  ip: '操作 IP',
  location: '操作地点',
  cost_time: '耗时',
  browser: '浏览器',
  os: '终端系统',
}

export type OperaLogSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key */
  username?: string
  ip?: string
  status?: number
  time?: string
  /** 摆开但没填值的格子 */
  f?: string
  /** 被隐藏的列 id，逗号分隔 */
  hide?: string
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

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function LogOperaPage({
  search = {},
  onSearchChange,
}: {
  search?: OperaLogSearch
  onSearchChange?: (n: OperaLogSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<OperaLogSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  const q = useQuerySearch({
    fields: FIELDS,
    search,
    onSearchChange,
    refreshKey: LOG_KEY,
    keep: ['hide'],
  })

  const qs = buildQuery(q.params, search.page, search.size)
  const listQuery = useQuery({
    queryKey: [...LOG_KEY, qs],
    queryFn: () => api.GET<PageData<OperaLog>>(`/api/v1/logs/opera?${qs}`),
    placeholderData: (prev) => prev,
  })
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  const [detail, setDetail] = React.useState<OperaLog | null>(null)
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
      col.accessor('opera_time', {
        header: t('操作时间'),
        // 点时间开详情 —— 与 ContiNew 的交互一致，比额外加一列「查看」省地方
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
      col.accessor((r) => r.username ?? t('匿名'), {
        id: 'username',
        header: t('操作人'),
        cell: ({ getValue }) => <span className="text-sm">{getValue()}</span>,
      }),
      col.accessor('title', {
        header: t('操作内容'),
        // title 是后端接口的 summary（中文），库里存的就是中文原文 ——
        // 而「中文原文即 key」，所以在渲染处 t() 就能翻，历史记录也一样能翻
        cell: ({ getValue }) => (
          <span className="block max-w-44 truncate text-sm font-medium" title={t(getValue())}>
            {t(getValue())}
          </span>
        ),
      }),
      col.accessor('method', {
        header: t('方法'),
        cell: ({ getValue }) => (
          <span
            className={cn(
              'inline-flex rounded px-1.5 py-0.5 font-mono text-xs ring-1',
              METHOD_CLASS[getValue()] ?? 'bg-muted ring-border'
            )}
          >
            {getValue()}
          </span>
        ),
      }),
      col.accessor('path', {
        header: t('接口'),
        cell: ({ getValue }) => (
          <span className="block max-w-52 truncate font-mono text-xs text-muted-foreground" title={getValue()}>
            {getValue()}
          </span>
        ),
      }),
      col.accessor('status', {
        header: t('状态'),
        cell: ({ row, getValue }) => {
          const ok = getValue() === 1
          return (
            <div className="flex items-center gap-1.5">
              <StatusPill tone={ok ? 'success' : 'danger'} className="gap-1">
                <span className={cn('size-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-destructive')} />
                {ok ? t('成功') : t('异常')}
              </StatusPill>
              <Badge variant="outline" className="font-mono font-normal">
                {row.original.code}
              </Badge>
            </div>
          )
        },
      }),
      col.accessor('ip', {
        header: t('操作 IP'),
        cell: ({ getValue }) => <span className="font-mono text-xs tabular-nums">{getValue()}</span>,
      }),
      col.accessor((r) => formatLocation(r), {
        id: 'location',
        header: t('操作地点'),
        cell: ({ getValue }) => <span className="text-sm text-muted-foreground">{getValue()}</span>,
      }),
      col.accessor('cost_time', {
        header: t('耗时'),
        cell: ({ getValue }) => {
          const ms = getValue()
          return (
            <span
              className={cn(
                'font-mono text-xs tabular-nums',
                ms > 500 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
              )}
            >
              {ms.toFixed(1)} ms
            </span>
          )
        },
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
        cell: ({ getValue }) => <span className="text-sm text-muted-foreground">{getValue()}</span>,
      }),
    ],
    [page, size, t]
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility },
    getRowId: (r: OperaLog) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    // 只读列表 —— 没有批量操作就不开行选中（开着但没有复选框列，
    // 分页条上那句「已选 N 项」会永远显示 0）
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
  })

  const hasFilter = countActive(q.applied, FIELDS) > 0

  /** 导出当前筛选条件下的全部记录为 CSV（后端没有导出接口，前端按分页拉全量） */
  const [exporting, setExporting] = React.useState(false)
  const [exportError, setExportError] = React.useState<string | null>(null)
  async function handleExport() {
    if (exporting) return // 按钮不再 disabled（见下方 tooltip 处注释），重入守卫挪到这里
    setExporting(true)
    setExportError(null)
    try {
      const all: OperaLog[] = []
      let p = 1
      // 上限 20 页 ×200 = 4000 条，避免误点导出把几十万条日志拉下来
      for (; p <= 20; p += 1) {
        const chunk = await api.GET<PageData<OperaLog>>(`/api/v1/logs/opera?${buildQuery(q.params, p, 200)}`)
        all.push(...chunk.items)
        if (p >= chunk.total_pages) break
      }
      // ⚠️ 逐条写字面量而不是 `[...].map(t)` —— `t(变量)` 校验器看不见（硬规则 2）
      const head = [
        t('序号'),
        t('操作时间'),
        t('操作人'),
        t('操作内容'),
        t('方法'),
        t('接口'),
        t('状态'),
        t('状态码'),
        t('操作 IP'),
        t('操作地点'),
        t('耗时(ms)'),
        t('浏览器'),
        t('终端系统'),
        'Trace ID',
      ]
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const lines = [head.join(',')]
      all.forEach((r, i) => {
        lines.push(
          [
            i + 1,
            formatDateTime(r.opera_time),
            r.username ?? t('匿名'),
            t(r.title),
            r.method,
            r.path,
            r.status === 1 ? t('成功') : t('异常'),
            r.code,
            r.ip,
            formatLocation(r),
            r.cost_time.toFixed(1),
            r.browser ?? '',
            r.os ?? '',
            r.trace_id,
          ]
            .map(esc)
            .join(',')
        )
      })
      // ﻿ 是 BOM —— 没有它 Excel 打开中文会乱码
      const blob = new Blob(['﻿' + lines.join('\n')], {
        type: 'text/csv;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${t('操作日志')}_${iso(new Date())}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      // 硬纪律 9：请求失败必须是可见状态。原来这里没有 catch，失败时按钮
      // 复位但界面上什么都不说，和「导出功能不存在」长得一样
      setExportError(e instanceof Error ? e.message : t('导出失败'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader
            title={t('操作日志')}
            description={t('记录后台每一次接口调用的请求、响应与耗时。点操作时间看完整详情。')}
          />

          {/*
            🔴 查询区和表格是**同一个块的两半**（筛选 → 结果），所以包一层、
            用 `gap-4`（16px）而不是页面级块之间的 `gap-4 md:gap-6`（24px）：
            查询区内部两行只隔 8px，紧接着就跳 24px 到表格，节奏是断的。

            ⚠️ 这一层也必须能收缩 —— 「只滚表格行」那条链断一层就整条失效。
          */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            {/* 查询区不塞进 DataTable 的 toolbar 槽（那是一行） */}
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
                  {/* 种子里没有独立的导出权限码，复用 log:opera:del ——
                      之前完全没包，只靠页面路由的 requirePerm('log:opera:del') 兜底：
                      以后谁把路由权限放宽，导出这个数据外泄面会跟着无声放宽 */}
                  <Can perm="log:opera:del">
                    <Tooltip>
                      {/*
                      ⚠️ 不能用 disabled 挡重复点击：buttonVariants 基础类带
                      disabled:pointer-events-none，hover 打不开 tooltip —— 图标按钮
                      一旦禁用就只剩一个转圈图标、任何地方都没有文字。改成
                      aria-busy + handleExport 里的重入守卫。
                    */}
                      <TooltipTrigger
                        render={
                          <Button
                            size="sm"
                            variant="outline"
                            className="size-8 p-0"
                            aria-busy={exporting}
                            data-testid="export-csv"
                            aria-label={exporting ? t('导出中…') : t('导出 CSV')}
                            onClick={handleExport}
                          />
                        }
                      >
                        {exporting ? (
                          <IconLoader2 className="size-4 animate-spin" />
                        ) : (
                          <IconDownload className="size-4" />
                        )}
                      </TooltipTrigger>
                      <TooltipContent>{exporting ? t('导出中…') : t('导出 CSV')}</TooltipContent>
                    </Tooltip>
                  </Can>
                  {/* 日志只增不减，之前界面上没有任何清理入口 —— 权限码 log:opera:clear 一直闲置 */}
                  <ClearLogsButton kind="opera" filtered={hasFilter} total={data?.total ?? 0} iconOnly />
                  {/* 「列」下拉从 DataTable 搬过来 —— 它自己那一行就整行消失了 */}
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                </>
              }
              viewsStorageKey="qb:log-opera"
            />

            {exportError && (
              <p
                role="alert"
                data-testid="export-error"
                className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {exportError}
              </p>
            )}

            {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
            <div
              data-testid="opera-table"
              data-fetching={isFetching}
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                emptyMessage={t('没有匹配的操作记录')}
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

      <OperaLogDetailSheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} log={detail} />
    </div>
  )
}

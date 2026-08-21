import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import { IconDownload } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { DataTable } from '@admin/ui/components/data-table'
import { DateRangePicker } from '@admin/ui/components/date-range-picker'
import { cn } from '@admin/ui/lib/utils'

import { api, type PageData } from '../../api-client/client'
import { PageHeader } from '../../shell/page-header'
import { ClearLogsButton } from '../_shared/clear-logs'
import { DateQuickPick } from '../_shared/date-quick-pick'
import { ResetButton, SelectFilter, TextFilter } from '../_shared/filters'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import { logFeatures as features } from '../_shared/log-features'
import { StatusPill } from '../_shared/status'
import { OperaLogDetailSheet, formatLocation } from './detail-sheet'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

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
const STATUS_ITEMS = { all: '全部状态', '1': '成功', '0': '异常' }
const METHOD_CLASS: Record<string, string> = {
  GET: 'text-sky-700 dark:text-sky-300 bg-sky-500/10 ring-sky-500/25',
  POST: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 ring-emerald-500/25',
  PUT: 'text-amber-700 dark:text-amber-300 bg-amber-500/10 ring-amber-500/25',
  DELETE: 'text-destructive bg-destructive/10 ring-destructive/25',
}

export type OperaLogSearch = {
  page?: number
  size?: number
  username?: string
  ip?: string
  status?: number
  start_time?: string
  end_time?: string
  /** 被隐藏的列 id，逗号分隔 */
  hide?: string
}

function buildQuery(s: OperaLogSearch): string {
  const q = new URLSearchParams()
  q.set('page', String(s.page ?? 1))
  q.set('size', String(s.size ?? DEFAULT_PAGE_SIZE))
  if (s.username) q.set('username', s.username)
  if (s.ip) q.set('ip', s.ip)
  if (s.status !== undefined) q.set('status', String(s.status))
  if (s.start_time) q.set('start_time', s.start_time)
  if (s.end_time) q.set('end_time', s.end_time)
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

  const qs = buildQuery(search)
  const { data, isPending, isFetching } = useQuery({
    queryKey: ['logs', 'opera', qs],
    queryFn: () => api.GET<PageData<OperaLog>>(`/api/v1/logs/opera?${qs}`),
    placeholderData: (prev) => prev,
  })
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
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
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
            className="font-mono text-xs tabular-nums text-primary underline-offset-2 hover:underline"
          >
            {getValue()}
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
          <span className="block max-w-44 truncate text-sm font-medium" title={t(getValue())}>{t(getValue())}</span>
        ),
      }),
      col.accessor('method', {
        header: t('方法'),
        cell: ({ getValue }) => (
          <span className={cn('inline-flex rounded px-1.5 py-0.5 font-mono text-[11px] ring-1', METHOD_CLASS[getValue()] ?? 'bg-muted ring-border')}>
            {getValue()}
          </span>
        ),
      }),
      col.accessor('path', {
        header: t('接口'),
        cell: ({ getValue }) => (
          <span className="block max-w-52 truncate font-mono text-xs text-muted-foreground" title={getValue()}>{getValue()}</span>
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
              <Badge variant="outline" className="font-mono font-normal">{row.original.code}</Badge>
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
            <span className={cn('font-mono text-xs tabular-nums', ms > 500 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
              {ms.toFixed(1)} ms
            </span>
          )
        },
      }),
      col.accessor((r) => r.browser ?? '—', {
        id: 'browser',
        header: t('浏览器'),
        cell: ({ getValue }) => (
          <span className="block max-w-28 truncate text-sm text-muted-foreground" title={getValue()}>{getValue()}</span>
        ),
      }),
      col.accessor((r) => r.os ?? '—', {
        id: 'os',
        header: t('终端系统'),
        cell: ({ getValue }) => <span className="text-sm text-muted-foreground">{getValue()}</span>,
      }),
    ],
    [page, size]
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

  const hasFilter = Boolean(
    search.username || search.ip || search.status !== undefined || search.start_time || search.end_time
  )

  /** 导出当前筛选条件下的全部记录为 CSV（后端没有导出接口，前端按分页拉全量） */
  const [exporting, setExporting] = React.useState(false)
  async function handleExport() {
    setExporting(true)
    try {
      const all: OperaLog[] = []
      let p = 1
      // 上限 20 页 ×200 = 4000 条，避免误点导出把几十万条日志拉下来
      for (; p <= 20; p += 1) {
        const chunk = await api.GET<PageData<OperaLog>>(
          `/api/v1/logs/opera?${buildQuery({ ...search, page: p, size: 200 })}`
        )
        all.push(...chunk.items)
        if (p >= chunk.total_pages) break
      }
      // ⚠️ 逐条写字面量而不是 `[...].map(t)` —— `t(变量)` 校验器看不见（硬规则 2）
      const head = [
        t('序号'), t('操作时间'), t('操作人'), t('操作内容'), t('方法'), t('接口'),
        t('状态'), t('状态码'), t('操作 IP'), t('操作地点'), t('耗时(ms)'),
        t('浏览器'), t('终端系统'), 'Trace ID',
      ]
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const lines = [head.join(',')]
      all.forEach((r, i) => {
        lines.push([
          i + 1, r.opera_time, r.username ?? t('匿名'), t(r.title), r.method, r.path,
          r.status === 1 ? t('成功') : t('异常'), r.code, r.ip, formatLocation(r),
          r.cost_time.toFixed(1), r.browser ?? '', r.os ?? '', r.trace_id,
        ].map(esc).join(','))
      })
      // ﻿ 是 BOM —— 没有它 Excel 打开中文会乱码
      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${t('操作日志')}_${iso(new Date())}.csv`
      a.click()
      URL.revokeObjectURL(url)
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
          <PageHeader title={t("操作日志")} description={t("记录后台每一次接口调用的请求、响应与耗时。点操作时间看完整详情。")} />

          {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
          <div
            data-testid="opera-table"
            data-fetching={isFetching}
            className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
          >
            <DataTable
              table={table}
              rows={table.getRowModel().rows}
              columnCount={columns.length}
              emptyMessage={t("没有匹配的操作记录")}
              emptyAction={
                hasFilter ? (
                  <ResetButton
                    variant="outline" testId="empty-clear-filter" label={t("清除筛选")}
                    onClick={() =>
                      patch({
                        username: undefined, ip: undefined, status: undefined,
                        start_time: undefined, end_time: undefined, page: undefined,
                      })
                    }
                  />
                ) : undefined
              }
              loading={isPending}
              busy={isFetching && !isPending}
              skeletonRows={8}
              actions={
                <>
                  <Button size="sm" variant="outline" disabled={exporting} data-testid="export-csv" onClick={handleExport}>
                    <IconDownload className="size-4" />
                    {exporting ? t('导出中…') : t('导出 CSV')}
                  </Button>
                  {/* 日志只增不减，之前界面上没有任何清理入口 —— 权限码 log:opera:clear 一直闲置 */}
                  <ClearLogsButton kind="opera" filtered={hasFilter} total={data?.total ?? 0} />
                </>
              }
              columnLabels={{
                seq: '序号', opera_time: '操作时间', username: '操作人', title: '操作内容',
                method: '方法', path: '接口', status: '状态', ip: '操作 IP',
                location: '操作地点', cost_time: '耗时', browser: '浏览器', os: '终端系统',
              }}
              toolbar={
                <>
                  <TextFilter
                    value={search.username ?? ''}
                    placeholder={t("搜索操作人…")}
                    testId="filter-username"
                    width="w-40"
                    onCommit={(v) => patch({ username: v || undefined, page: undefined })}
                  />
                  <TextFilter
                    value={search.ip ?? ''}
                    placeholder={t("搜索 IP…")}
                    testId="filter-ip"
                    width="w-36"
                    onCommit={(v) => patch({ ip: v || undefined, page: undefined })}
                  />
                  <DateQuickPick
                    value={{ start: search.start_time, end: search.end_time }}
                    onChange={(r) => patch({ start_time: r.start, end_time: r.end, page: undefined })}
                  />
                  <DateRangePicker
                    className="h-8"
                    label={t("操作时间范围")}
                    date={
                      search.start_time
                        ? { from: new Date(search.start_time), to: search.end_time ? new Date(search.end_time) : undefined }
                        : undefined
                    }
                    onSelect={(r) =>
                      patch({
                        start_time: r?.from ? `${iso(r.from)} 00:00:00` : undefined,
                        end_time: r?.to ? `${iso(r.to)} 23:59:59` : undefined,
                        page: undefined,
                      })
                    }
                  />
                  <SelectFilter
                    value={search.status}
                    items={STATUS_ITEMS}
                    testId="filter-status"
                    onChange={(v) => patch({ status: v === undefined ? undefined : Number(v), page: undefined })}
                  />
                  {hasFilter && (
                    <ResetButton
                      onClick={() =>
                        patch({
                          username: undefined, ip: undefined, status: undefined,
                          start_time: undefined, end_time: undefined, page: undefined,
                        })
                      }
                    />
                  )}
                </>
              }
              pagination={{
                pageIndex: page - 1,
                pageCount: data?.total_pages ?? 1,
                pageSize: size,
                totalCount: data?.total ?? 0,
                onPageChange: (i) => patch({ page: i + 1 }),
                onPageSizeChange: (s) => patch({ size: s, page: undefined }),
              }}
            />
          </div>
        </div>
      </div>

      <OperaLogDetailSheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} log={detail} />
    </div>
  )
}

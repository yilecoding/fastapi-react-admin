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
import { LoginLogDetailSheet, formatLocation } from './detail-sheet'
import type { LoginLog } from '../_shared/login-log'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

export type { LoginLog }

const col = createColumnHelper<typeof features, LoginLog>()
const STATUS_ITEMS = { all: '全部状态', '1': '成功', '0': '失败' }

export type LoginLogSearch = {
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

function buildQuery(s: LoginLogSearch, override: Partial<LoginLogSearch> = {}): string {
  const m = { ...s, ...override }
  const q = new URLSearchParams()
  q.set('page', String(m.page ?? 1))
  q.set('size', String(m.size ?? DEFAULT_PAGE_SIZE))
  if (m.username) q.set('username', m.username)
  if (m.ip) q.set('ip', m.ip)
  if (m.status !== undefined) q.set('status', String(m.status))
  if (m.start_time) q.set('start_time', m.start_time)
  if (m.end_time) q.set('end_time', m.end_time)
  return q.toString()
}

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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

  const qs = buildQuery(search)
  const { data, isPending, isFetching } = useQuery({
    queryKey: ['logs', 'login', qs],
    queryFn: () => api.GET<PageData<LoginLog>>(`/api/v1/logs/login?${qs}`),
    placeholderData: (prev) => prev,
  })
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
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
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
            className="font-mono text-xs tabular-nums text-primary underline-offset-2 hover:underline"
          >
            {getValue()}
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
          <span className={cn('block max-w-40 truncate text-sm', row.original.status === 0 && 'text-destructive')} title={t(getValue())}>
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
          <span className="block max-w-28 truncate text-sm text-muted-foreground" title={getValue()}>{getValue()}</span>
        ),
      }),
      col.accessor((r) => r.os ?? '—', {
        id: 'os',
        header: t('终端系统'),
        cell: ({ row, getValue }) => (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {getValue()}
            {row.original.device && <Badge variant="outline" className="font-normal">{row.original.device}</Badge>}
          </span>
        ),
      }),
    ],
    [page, size]
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility },
    getRowId: (r: LoginLog) => r.id,
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

  const [exporting, setExporting] = React.useState(false)
  async function handleExport() {
    setExporting(true)
    try {
      const all: LoginLog[] = []
      for (let p = 1; p <= 20; p += 1) {
        const chunk = await api.GET<PageData<LoginLog>>(`/api/v1/logs/login?${buildQuery(search, { page: p, size: 200 })}`)
        all.push(...chunk.items)
        if (p >= chunk.total_pages) break
      }
      // ⚠️ 逐条写字面量而不是 `[...].map(t)` —— `t(变量)` 校验器看不见，
      // 漏进语言包的表头在英文界面上会是中文（硬规则 2）
      const head = [
        t('序号'), t('登录时间'), t('登录账号'), t('结果'), t('说明'), t('登录 IP'),
        t('登录地点'), t('浏览器'), t('终端系统'), t('设备'), t('用户 UUID'),
      ]
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const lines = [head.join(',')]
      all.forEach((r, i) => {
        lines.push([
          i + 1, r.login_time, r.username, r.status === 1 ? t('成功') : t('失败'), t(r.msg),
          r.ip, formatLocation(r), r.browser ?? '', r.os ?? '', r.device ?? '', r.user_uuid,
        ].map(esc).join(','))
      })
      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${t('登录日志')}_${iso(new Date())}.csv`
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
          <PageHeader title={t("登录日志")} description={t("安全审计入口。失败尝试比成功登录更值得看。")} />

          {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
          <div
            data-testid="login-table"
            data-fetching={isFetching}
            className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
          >
            <DataTable
              table={table}
              rows={table.getRowModel().rows}
              columnCount={columns.length}
              emptyMessage={t("没有匹配的登录记录")}
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
                  {/* 日志只增不减，之前界面上没有任何清理入口 —— 权限码 log:login:clear 一直闲置 */}
                  <ClearLogsButton kind="login" filtered={hasFilter} total={data?.total ?? 0} />
                </>
              }
              columnLabels={{
                seq: '序号', login_time: '登录时间', username: '登录账号', status: '结果',
                msg: '说明', ip: '登录 IP', location: '登录地点', browser: '浏览器', os: '终端系统',
              }}
              toolbar={
                <>
                  <TextFilter
                    value={search.username ?? ''}
                    placeholder={t("搜索登录账号…")}
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
                    label={t("登录时间范围")}
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

      <LoginLogDetailSheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} log={detail} />
    </div>
  )
}


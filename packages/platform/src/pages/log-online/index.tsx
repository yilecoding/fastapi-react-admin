import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTable, type ColumnVisibilityState, type RowSelectionState } from '@tanstack/react-table'
import { IconLogout } from '@tabler/icons-react'

import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { BulkBar } from '../_shared/filters'
import { useQuerySearch } from '../_shared/use-query-search'
import { DEFAULT_REFRESH, MetricCard, MonitorError, RefreshBar } from '../_shared/monitor'
import {
  currentSessionUuid,
  onlineKeys,
  sessionsQuery,
  useKickSession,
  useKickSessions,
  type OnlineSession,
} from './api'
import { COLUMN_LABELS, buildColumns } from './columns'
import { features } from './table-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

/**
 * 在线用户（会话监控）。
 *
 * 与其他列表页最大的不同：**接口不分页也不搜索**（它扫的是 Redis 里的 token key，
 * 一次全给）。后端那个 `username` 入参是**全等匹配**，做不了「输入 adm 搜出 admin」，
 * 所以筛选与分页一律在前端做 —— 但游标仍然写进 URL（硬纪律 2），刷新后回到原页。
 *
 * 硬纪律：组件 router-独立（search 走 props，不读 Route.useSearch()）。
 */
export type LogOnlineSearch = {
  page?: number
  size?: number
  /** 关键字：匹配用户名 / 昵称 / IP */
  q?: string
  /** 1 = 只看有实时连接的，0 = 只看离线的 */
  online?: number
  refresh?: number
  /** 摆开但还没填值的格子（见 `_shared/use-query-search`） */
  f?: string
}

/**
 * 可筛字段。**这一页的筛选全在前端做** —— 接口一次把 Redis 里的
 * `fba:token:*` 全给（不分页，且它的 `username` 入参是全等匹配），
 * 所以 `q.params` 不发给后端，直接喂给下面那个 `filtered`。
 * 游标照样进 URL（硬纪律 2）。
 */
const FIELDS: FilterField[] = [
  {
    key: 'q',
    label: '关键词',
    type: 'text',
    group: '会话',
    defaultVisible: true,
    placeholder: '账号 / 昵称 / IP',
  },
  {
    key: 'online',
    label: '连接',
    type: 'select',
    group: '会话',
    defaultVisible: true,
    options: [
      { value: 1, label: '在线' },
      { value: 0, label: '离线' },
    ],
  },
]

export function LogOnlinePage({
  search = {},
  onSearchChange,
}: {
  search?: LogOnlineSearch
  onSearchChange?: (n: LogOnlineSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const refresh = search.refresh ?? DEFAULT_REFRESH
  const qc = useQueryClient()

  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({
    // UUID 平时没人看，但排查「同一个人开了几个端」时要 —— 放进列显隐里默认收起
    session_uuid: false,
  })

  const patch = React.useCallback(
    (n: Partial<LogOnlineSearch>) => {
      setRowSelection({})
      onSearchChange?.({ ...search, ...n })
    },
    [onSearchChange, search]
  )

  /**
   * URL ↔ QueryBar 的胶水。`keep: ['refresh']` —— 刷新间隔不是筛选条件，
   * 但它在同一份 search 里，不保就会被一次搜索清掉。
   *
   * ⚠️ 搜索/重置要清选中行：这一页的「批量下线」同理会打到看不见的会话上。
   */
  const qb = useQuerySearch({ fields: FIELDS, search, onSearchChange, keep: ['refresh'] })
  const submitQuery = React.useCallback(
    (v: Parameters<typeof qb.submit>[0]) => {
      setRowSelection({})
      qb.submit(v)
    },
    [qb]
  )
  const clearFilters = React.useCallback(() => {
    setRowSelection({})
    qb.reset()
  }, [qb])

  const { data, isPending, isFetching, error, dataUpdatedAt } = useQuery(sessionsQuery(refresh * 1000))
  const all = data ?? []
  const currentUuid = currentSessionUuid()

  // 「剩余有效期」的基准时刻。跟着取数走而不是每渲染一次读一次 Date.now() ——
  // 后者会让隐藏 tab 切回来时整列跳一下，也没法做快照测试
  const now = dataUpdatedAt || Date.now()

  const filtered = React.useMemo(() => {
    const kw = String(qb.params.q ?? '')
      .trim()
      .toLowerCase()
    let list = all
    if (kw) {
      list = list.filter(
        (s) =>
          s.username.toLowerCase().includes(kw) ||
          s.nickname.toLowerCase().includes(kw) ||
          s.ip.toLowerCase().includes(kw)
      )
    }
    const online = qb.params.online
    if (online !== undefined) list = list.filter((s) => s.status === Number(online))
    /**
     * 接口给的是 Redis SCAN 顺序（等于随机），必须自己排。
     *
     * 排序键用 **expire_time** 而不是 last_login_time：
     * `last_login_time` 是**用户**的最后登录时间，同一个人的多个会话经常一模一样
     * （刷新 token 也会把旧的 last_login_time 抄进新 token），排出来是一堆并列；
     * 而 expire_time = 会话创建时间 + 固定 TTL，**每个会话都不同**，倒序就是
     * 「最新的会话在最前」。并列时再用 last_login_time 兜一层。
     *
     * 两个字段都是 'YYYY-MM-DD HH:mm:ss'，可以直接字典序比。
     */
    return [...list].sort(
      (a, b) => b.expire_time.localeCompare(a.expire_time) || b.last_login_time.localeCompare(a.last_login_time)
    )
  }, [all, qb.params])

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / size))
  // 删到最后一页空了要退回去，否则停在一页空表上
  const safePage = Math.min(page, totalPages)
  const rows = React.useMemo(
    () => filtered.slice((safePage - 1) * size, safePage * size),
    [filtered, safePage, size]
  )

  const [pendingKick, setPendingKick] = React.useState<OnlineSession | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [bulkError, setBulkError] = React.useState<string | null>(null)
  const kick = useKickSession()
  const kickMany = useKickSessions()

  const columns = React.useMemo(
    () => buildColumns({ page: safePage, size, now, currentUuid, onKick: setPendingKick, t }),
    [safePage, size, now, currentUuid, t]
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility, rowSelection },
    // ⚠️ 必须是 session_uuid：`id` 是用户 ID，同一个人多端登录会重复，
    // 用它当行 ID 会让多行共享同一个选中态
    getRowId: (s: OnlineSession) => s.session_uuid,
    manualPagination: true,
    rowCount: total,
    enableRowSelection: (row) => row.original.session_uuid !== currentUuid,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
  })

  const selectedUuids = Object.keys(rowSelection).filter((k) => rowSelection[k])
  const selected = React.useMemo(
    () => filtered.filter((s) => selectedUuids.includes(s.session_uuid)),
    [filtered, selectedUuids]
  )
  const hasFilter = countActive(qb.applied, FIELDS) > 0

  // 统计条：全量口径（不受筛选影响，否则「在线 3」会随搜索词跳）
  const stats = React.useMemo(() => {
    const online = all.filter((s) => s.status === 1).length
    return {
      total: all.length,
      online,
      users: new Set(all.map((s) => s.username)).size,
      ips: new Set(all.map((s) => s.ip)).size,
    }
  }, [all])

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          {/* 标题/描述是 sr-only 的（页名在 tab 上）；刷新条走 DataTable 的 actions 槽 */}
          <PageHeader
            title={t('在线用户')}
            description={t('Redis 里仍然有效的登录会话。可强制下线，被踢的人下次请求即失效。')}
          />

          {error && <MonitorError error={error} />}

          {/* ── 统计条 ── */}
          <div
            className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @4xl/main:grid-cols-4"
            data-testid="online-stats"
          >
            <MetricCard
              label={t('有效会话')}
              testId="stat-total"
              value={stats.total}
              tone="info"
              hint={t('token 未过期的全部会话')}
            />
            <MetricCard
              label={t('实时在线')}
              testId="stat-online"
              value={stats.online}
              tone={stats.online > 0 ? 'success' : 'muted'}
              hint={t('有活跃 WebSocket 连接')}
            />
            <MetricCard
              label={t('独立账号')}
              testId="stat-users"
              value={stats.users}
              tone="info"
              hint={t('去重后的登录用户数')}
            />
            <MetricCard
              label={t('独立 IP')}
              testId="stat-ips"
              value={stats.ips}
              tone="info"
              hint={t('去重后的来源地址数')}
            />
          </div>

          {/* 查询区和表格是同一个块的两半；这一层也要能收缩，否则「只滚表格行」那条链断在这里 */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            <QueryBar
              fields={FIELDS}
              value={qb.value}
              onChange={qb.setValue}
              onSearch={submitQuery}
              onReset={clearFilters}
              applied={qb.applied}
              loading={isFetching}
              viewsStorageKey="qb:log-online"
              actions={
                <>
                  <RefreshBar
                    interval={refresh}
                    updatedAt={dataUpdatedAt || undefined}
                    fetching={isFetching}
                    onIntervalChange={(v) => patch({ refresh: v })}
                    onRefresh={() => void qc.invalidateQueries({ queryKey: onlineKeys.all })}
                  />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                  {/* 批量条放左组末尾：它随选中行出现/消失，放右组会让「搜索/重置」横向位移 */}
                  <BulkBar
                    count={selected.length}
                    label={t('批量下线')}
                    icon={<IconLogout className="size-4" />}
                    pending={kickMany.isPending}
                    onDelete={() => {
                      setBulkError(null)
                      setBulkOpen(true)
                    }}
                  />
                </>
              }
            />

            {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
            <div
              data-testid="online-table"
              data-fetching={isFetching}
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                emptyMessage={hasFilter ? t('没有匹配的会话') : t('当前没有有效会话')}
                loading={isPending}
                busy={isFetching && !isPending}
                skeletonRows={6}
                columnLabels={COLUMN_LABELS}
                rowAttributes={(row) => ({ 'data-testid': `session-row-${row.original.session_uuid}` })}
                pagination={{
                  pageIndex: safePage - 1,
                  pageCount: totalPages,
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

      {/* 二次确认必须是触发器的兄弟节点 —— 放进 DropdownMenuContent 会被一起卸载 */}
      <ConfirmDialog
        open={pendingKick !== null}
        onOpenChange={(o) => !o && setPendingKick(null)}
        title={t('强制下线')}
        destructive
        confirmText={t('确认下线')}
        pending={kick.isPending}
        description={
          pendingKick && (
            <>
              {t(
                '将吊销 {{who}} 来自 {{ip}} 的这个会话（{{browser}} · {{os}}）。对方下一次请求就会被要求重新登录。',
                {
                  who: pendingKick.nickname || pendingKick.username,
                  ip: pendingKick.ip,
                  browser: pendingKick.browser,
                  os: pendingKick.os,
                }
              )}
            </>
          )
        }
        onConfirm={async () => {
          if (!pendingKick) return
          await kick.mutateAsync(pendingKick)
          setPendingKick(null)
        }}
      />

      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => {
          setBulkOpen(o)
          if (!o) setBulkError(null)
        }}
        title={t('批量下线 {{n}} 个会话', { n: selected.length })}
        destructive
        confirmText={t('确认下线')}
        pending={kickMany.isPending}
        description={
          <>
            {t('这些会话的 token 会被立即吊销。当前会话不在其中（自己踢不了自己）。')}
            {bulkError && <p className="mt-2 text-destructive">{bulkError}</p>}
          </>
        }
        onConfirm={async () => {
          try {
            await kickMany.mutateAsync(selected.map((s) => ({ id: s.id, session_uuid: s.session_uuid })))
            setRowSelection({})
            setBulkOpen(false)
          } catch (e) {
            setBulkError(e instanceof Error ? e.message : t('批量下线失败'))
          }
        }}
      />
    </div>
  )
}

import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { Pagination } from '@admin/ui/components/pagination'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@admin/ui/components/table'
import { cn } from '@admin/ui/lib/utils'
import { formatDateTime } from '@admin/i18n'

import { PageHeader } from '../../shell/page-header'
import { RefreshButton, SelectFilter, TextFilter } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { monitorQuery, type InstanceStatus } from '../workflow/api'
import { InstanceSheet } from '../workflow/instance-sheet'
import { INSTANCE_STATUS, InstanceStatusPill } from '../workflow/status'
import { PersonAvatar } from '../workflow/track'

export type WorkflowMonitorSearch = {
  page?: number
  size?: number
  keyword?: string
  status?: InstanceStatus
  id?: string
}

/**
 * 实例监控：管理员看全部审批单、终止在途的。
 *
 * 详情和审批中心是同一个抽屉 —— 终止按钮来自能力信封（有 `workflow:instance:terminate`
 * 才会出现），这里不额外判断。
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
  const patch = (p: Partial<WorkflowMonitorSearch>) => onSearchChange?.({ ...search, ...p })
  const query = useQuery(monitorQuery({ page, size, keyword: search.keyword, status: search.status }))
  const list = listState(query)
  const rows = query.data?.items ?? []
  const statusItems = {
    all: t('全部状态'),
    ...Object.fromEntries(Object.entries(INSTANCE_STATUS).map(([k, v]) => [k, t(v.label)])),
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:py-6">
      <PageHeader title={t('实例监控')} />
      <div className="flex flex-wrap items-center gap-2">
        <TextFilter
          value={search.keyword ?? ''}
          placeholder="搜索标题或摘要"
          onCommit={(v) => patch({ keyword: v.trim() || undefined, page: 1 })}
          testId="wf-monitor-search"
        />
        <SelectFilter
          value={search.status ?? 'all'}
          items={statusItems}
          onChange={(v) => patch({ status: v === 'all' ? undefined : (v as InstanceStatus), page: 1 })}
        />
        <span className="ms-auto">
          <RefreshButton onClick={list.onRetry} busy={list.busy} />
        </span>
      </div>
      <div className={cn('overflow-hidden rounded-xl border bg-card', list.busy && 'opacity-60')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('标题')}</TableHead>
              <TableHead>{t('流程')}</TableHead>
              <TableHead>{t('发起人')}</TableHead>
              <TableHead>{t('状态')}</TableHead>
              <TableHead>{t('发起时间')}</TableHead>
              <TableHead>{t('结束时间')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><Skeleton className="h-6" /></TableCell></TableRow>
              ))
            ) : list.error ? (
              <TableRow><TableCell colSpan={6}><QueryError error={list.error} onRetry={list.onRetry} /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">{t('暂无数据')}</TableCell></TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => patch({ id: r.id })}
                  data-testid={`wf-monitor-row-${r.id}`}
                >
                  <TableCell className="max-w-72 truncate font-medium">{r.title}</TableCell>
                  <TableCell>{r.definition_name}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <PersonAvatar name={r.initiator_name ?? ''} />
                      {r.initiator_name ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell><InstanceStatusPill status={r.status} /></TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(r.created_time)}</TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(r.finished_time)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {(query.data?.total ?? 0) > 0 && (
        <Pagination
          pageIndex={page - 1}
          pageCount={Math.max(1, query.data?.total_pages ?? 1)}
          pageSize={size}
          totalCount={query.data?.total ?? 0}
          onPageChange={(i) => patch({ page: i + 1 })}
          onPageSizeChange={(s) => patch({ size: s, page: 1 })}
        />
      )}
      <InstanceSheet id={search.id ?? null} onClose={() => patch({ id: undefined })} />
    </div>
  )
}

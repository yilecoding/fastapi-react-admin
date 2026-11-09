import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { StatusPill } from '../status'
import { dataChangeMetaQuery, traceChangesQuery } from './api'
import { ActionPill, ChangeList } from './change-list'

/** 一次请求（按 trace_id）改了哪些对象的哪些字段 —— 操作日志详情里用（#260） */
export function TraceChanges({ traceId }: { traceId: string }) {
  const { t } = useTranslation()
  const query = useQuery(traceChangesQuery(traceId))
  const meta = useQuery(dataChangeMetaQuery())
  if (query.isPending) return <Skeleton className="h-16 w-full" />
  if (query.error) return <QueryError error={query.error} onRetry={() => void query.refetch()} />
  const records = query.data.items
  if (records.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="trace-changes-empty">
        {t('这次请求没有改动登记过变更记录的数据')}
      </p>
    )
  }
  return (
    <ol className="flex flex-col gap-3" data-testid="trace-changes">
      {records.map((r) => {
        const title = meta.data?.entities.find((e) => e.entity === r.entity_type)?.title
        return (
          <li key={r.id} className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
            <span className="flex flex-wrap items-center gap-1.5 text-sm">
              <StatusPill tone="muted">{title ? t(title) : r.entity_type}</StatusPill>
              <span className="font-medium">
                {r.action === 'bulk' ? t('{{n}} 条', { n: r.entity_label ?? '?' }) : r.entity_label}
              </span>
              <ActionPill action={r.action} />
            </span>
            <ChangeList record={r} />
          </li>
        )
      })}
    </ol>
  )
}

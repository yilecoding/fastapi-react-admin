import * as React from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'

import { StatusPill } from '../status'
import { type DataChange, type DataChangeItem, dataChangeMetaQuery, entityChangesQuery } from './api'
import { ActionPill, ChangeList } from './change-list'

/** 来源的中文名从元数据接口来（后端 `registry.SOURCES`），取不到时退回原值 */
export function useSourceLabel(): (source: string) => string {
  const { t } = useTranslation()
  const meta = useQuery(dataChangeMetaQuery())
  return React.useCallback(
    (source: string) => {
      const label = meta.data?.sources.find((s) => s.value === source)?.label
      return label ? t(label) : source
    },
    [meta.data, t]
  )
}

export function ChangeMeta({ record }: { record: DataChange }) {
  const { t } = useTranslation()
  const sourceLabel = useSourceLabel()
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="font-mono tabular-nums">{formatDateTime(record.created_time)}</span>
      <ActionPill action={record.action} />
      <span className="font-medium text-foreground">{record.actor_name ?? t('系统')}</span>
      {record.source !== 'web' && (
        <StatusPill tone="muted" title={record.source_ref ?? undefined}>
          {sourceLabel(record.source)}
        </StatusPill>
      )}
    </div>
  )
}

/**
 * 某一个对象的变更记录（#260）：用户 / 角色 / 部门 / 菜单 / 参数页行操作里的「变更记录」打开它。
 *
 * 开关和操作日志详情、用户「权限与安全」一样留在页面状态里，不进 URL；「只看某个字段」跟着抽屉走，同样不进 URL
 * （要能分享的单字段历史在「数据变更」页：对象 + 字段都在地址栏里）。
 */
export function DataChangeSheet({
  entity,
  entityId,
  name,
  open,
  onOpenChange,
}: {
  entity: string
  entityId: string | null
  /** 抽屉标题里显示的对象名（用户名 / 角色名…） */
  name?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  // 单字段历史：点记录里的字段名只看那一个字段。换了对象 / 关了抽屉就回到全部字段
  const [field, setField] = React.useState<Pick<DataChangeItem, 'field' | 'label'> | null>(null)
  React.useEffect(() => {
    if (!open) setField(null)
  }, [open, entity, entityId])
  const query = useInfiniteQuery({
    ...entityChangesQuery(entity, entityId ?? '', field?.field),
    enabled: open && !!entityId,
  })
  const records = React.useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data])
  const total = query.data?.pages[0]?.total ?? 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl" data-testid="data-change-sheet">
        <SheetHeader>
          <SheetTitle>{t('变更记录')}</SheetTitle>
          <SheetDescription>
            {name ? t('「{{name}}」的每一次修改：谁、什么时候、改了什么', { name }) : t('每一次修改：谁、什么时候、改了什么')}
          </SheetDescription>
          {field && (
            <div className="flex items-center gap-2 text-sm" data-testid="history-field-filter">
              <span className="text-muted-foreground">{t('只看')}</span>
              <StatusPill tone="info">{t(field.label)}</StatusPill>
              <Button variant="ghost" size="sm" onClick={() => setField(null)} data-testid="history-field-clear">
                {t('看全部字段')}
              </Button>
            </div>
          )}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {query.isPending && open ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : query.error ? (
            <QueryError error={query.error} onRetry={() => void query.refetch()} />
          ) : records.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground" data-testid="data-change-empty">
              {field ? t('这个字段还没有改过') : t('还没有变更记录。这个功能上线之前的修改没有记录')}
            </p>
          ) : (
            <ol className="flex flex-col">
              {records.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-2 border-b py-3 first:pt-0 last:border-b-0"
                  data-testid="data-change-record"
                >
                  <ChangeMeta record={r} />
                  <ChangeList
                    record={r}
                    onlyField={field?.field}
                    onFieldClick={field ? undefined : (c) => setField({ field: c.field, label: c.label })}
                  />
                </li>
              ))}
            </ol>
          )}
          {query.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('再看 {{n}} 条更早的', { n: Math.max(total - records.length, 0) })}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconChecklist } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'

import { useSocketEvent } from '../../../shell/socket-events'
import { countsQuery, inboxQuery, workflowKeys } from '../../workflow/api'
import { relativeTime } from '../../notification/shared'
import { CARD_ACTION_CLASS, CARD_ROW_CLASS, DashboardCard } from '../card-shell'
import type { CardProps } from './types'

/** 卡片里放几条（最急的在前：后端待办列表加急的排前面） */
const TODO_SIZE = 5

/**
 * 「我的待办」卡：审批待办数 + 最近几条，点一条**就地**打开审批详情（审批中心那个抽屉），不跳页。
 *
 * 待办数和列表用审批中心同一份 query（`workflowKeys`），在这里办完一张、审批中心的角标跟着变，反之亦然。
 * 服务端推 `workflow:todo` 只是「早点重取」，不是送达保证 —— 数字靠 REST 取对（同铃铛）
 */
export function TodoCard({ openApproval }: CardProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const counts = useQuery(countsQuery())
  const list = useQuery(inboxQuery({ tab: 'todo', page: 1, size: TODO_SIZE }))
  const items = list.data?.items ?? []
  const total = counts.data?.todo

  useSocketEvent('workflow:todo', () => {
    void qc.invalidateQueries({ queryKey: workflowKeys.counts() })
    void qc.invalidateQueries({ queryKey: workflowKeys.inbox() })
  })

  const error = counts.error ?? list.error

  return (
    <DashboardCard
      testId="dash-todo"
      title={t('我的待办')}
      icon={<IconChecklist className="size-4 text-primary" aria-hidden />}
      note={
        total !== undefined && total > 0 ? (
          <Badge variant="destructive" className="font-normal tabular-nums" data-testid="dash-todo-count">
            {t('{{n}} 件待办', { n: total })}
          </Badge>
        ) : undefined
      }
      action={
        <Link to="/workflow/inbox" search={{ tab: 'todo' }} className={CARD_ACTION_CLASS} data-testid="dash-todo-all">
          {t('全部')}
        </Link>
      }
      loading={list.isPending}
      error={error}
      onRetry={() => {
        void counts.refetch()
        void list.refetch()
      }}
      hasData={Boolean(list.data)}
      empty={items.length === 0}
      emptyText={t('没有待办，都处理完了')}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => openApproval(r.id)}
              className={CARD_ROW_CLASS}
              data-testid={`dash-todo-${r.id}`}
            >
              {r.urgent && (
                <Badge variant="destructive" className="shrink-0 font-normal">
                  {t('加急')}
                </Badge>
              )}
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              {r.node_name && (
                <span className="hidden shrink-0 text-xs text-muted-foreground @xl/main:inline">{r.node_name}</span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {relativeTime(r.arrived_time ?? r.created_time, t)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </DashboardCard>
  )
}

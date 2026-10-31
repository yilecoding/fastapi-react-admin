import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconBell } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { cn } from '@admin/ui/lib/utils'

import { noticeIdOf, notificationsQuery, unreadCountQuery, type Notification } from '../../notification/api'
import { categoryMeta, relativeTime } from '../../notification/shared'
import { useNotificationOpen } from '../../notification/use-open'
import { CARD_ACTION_CLASS, CARD_ROW_CLASS, DashboardCard } from '../card-shell'
import type { CardProps } from './types'

const UNREAD_SIZE = 5

/**
 * 「未读消息」卡：未读数 + 最近几条未读。
 *
 * 和铃铛同一份 query（`notificationKeys`）：这里点开一条标了已读，铃铛的红点跟着变；
 * socket 推来新消息时铃铛那边 `invalidateInbox` 一次，这张卡片也跟着重取 —— 不用再订阅一遍。
 *
 * 点一行的行为照铃铛（`useNotificationOpen` 是唯一实现）：
 * 公告**就地**开读者抽屉（已读交给抽屉，它知道这条是不是「必须确认」）；有合法链接的开对应页签；
 * 都没有的只标已读
 */
export function UnreadCard({ openNotice }: CardProps) {
  const { t } = useTranslation()
  const count = useQuery(unreadCountQuery)
  const list = useQuery(notificationsQuery({ page: 1, size: UNREAD_SIZE, unread: true }))
  const { linkOf, readIfUnread } = useNotificationOpen()
  const items = list.data?.items ?? []
  const total = count.data?.total

  return (
    <DashboardCard
      testId="dash-unread"
      title={t('未读消息')}
      icon={<IconBell className="size-4 text-primary" aria-hidden />}
      note={
        total !== undefined && total > 0 ? (
          <Badge variant="destructive" className="font-normal tabular-nums" data-testid="dash-unread-count">
            {t('{{n}} 条未读', { n: total })}
          </Badge>
        ) : undefined
      }
      action={
        <Link to="/notification" search={{}} className={CARD_ACTION_CLASS} data-testid="dash-unread-all">
          {t('全部')}
        </Link>
      }
      loading={list.isPending}
      error={count.error ?? list.error}
      onRetry={() => {
        void count.refetch()
        void list.refetch()
      }}
      hasData={Boolean(list.data)}
      empty={items.length === 0}
      emptyText={t('没有未读消息')}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((n) => (
          <UnreadRow key={n.id} n={n} openNotice={openNotice} linkOf={linkOf} readIfUnread={readIfUnread} />
        ))}
      </ul>
    </DashboardCard>
  )
}

function UnreadRow({
  n,
  openNotice,
  linkOf,
  readIfUnread,
}: {
  n: Notification
  openNotice: (id: string) => void
  linkOf: ReturnType<typeof useNotificationOpen>['linkOf']
  readIfUnread: ReturnType<typeof useNotificationOpen>['readIfUnread']
}) {
  const { t } = useTranslation()
  const meta = categoryMeta(n.category)
  const noticeId = noticeIdOf(n)
  const to = noticeId ? null : linkOf(n)
  const onActivate = () => (noticeId ? openNotice(noticeId) : readIfUnread(n))
  const body = (
    <>
      <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full', meta.tone)}>
        <meta.Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{n.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(n.created_time, t)}</span>
    </>
  )
  return (
    <li>
      {to ? (
        // `to` 是库里的自由字符串，`linkOf` 已经验过它真实存在；TanStack 的 `to` 类型是已知路由的字面量联合，只能断言过去
        <Link
          to={to.to as never}
          search={to.search as never}
          onClick={onActivate}
          className={CARD_ROW_CLASS}
          data-testid={`dash-unread-${n.id}`}
        >
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onActivate} className={CARD_ROW_CLASS} data-testid={`dash-unread-${n.id}`}>
          {body}
        </button>
      )}
    </li>
  )
}

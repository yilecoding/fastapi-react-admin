import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconBellOff } from '@tabler/icons-react'

import { cn } from '@admin/ui/lib/utils'

import {
  markableUnread,
  noticeIdOf,
  notificationsQuery,
  unreadCountQuery,
  useMarkAllNotificationsRead,
  type Notification,
} from '../../notification/api'
import { categoryMeta, relativeTime } from '../../notification/shared'
import { useNotificationOpen } from '../../notification/use-open'
import { CARD_ACTION_CLASS, CountBadge, DashboardCard } from '../card-shell'
import type { CardProps } from './types'

const UNREAD_SIZE = 4

/**
 * 「和我有关的消息」（注册表 id 仍是 `unread`，存过的布局照认）：最近几条未读。
 *
 * 和铃铛同一份 query（`notificationKeys`）：这里点开一条标了已读，铃铛的红点跟着变；
 * socket 推来新消息时铃铛那边 `invalidateInbox` 一次，这张卡片也跟着重取 —— 不用再订阅一遍。
 *
 * ⚠️ 站内通知**没有「谁发的」这一列**（`sys_notification` 只有标题 / 正文 / 分类 / 来源），设计稿上的发消息人头像
 * 换成了分类图标 —— 不拿收件人、不从标题里猜一个人名出来。
 *
 * 点一行的行为照铃铛（`useNotificationOpen` 是唯一实现）：公告**就地**开读者抽屉；有合法链接的开对应页签；都没有的只标已读
 */
export function UnreadCard({ openNotice }: CardProps) {
  const { t } = useTranslation()
  const count = useQuery(unreadCountQuery)
  const list = useQuery(notificationsQuery({ page: 1, size: UNREAD_SIZE, unread: true }))
  const markAll = useMarkAllNotificationsRead()
  const { linkOf, readIfUnread } = useNotificationOpen()
  const items = list.data?.items ?? []
  const total = count.data?.total ?? 0
  const markable = markableUnread(count.data)

  return (
    <DashboardCard
      variant="tile"
      testId="dash-unread"
      title={t('和我有关的消息')}
      badge={total > 0 ? <CountBadge n={total} testId="dash-unread-count" /> : undefined}
      action={
        <button
          type="button"
          className={CARD_ACTION_CLASS}
          disabled={markable === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
          data-testid="dash-unread-mark-all"
        >
          {t('全部已读')}
        </button>
      }
      footer={
        total > items.length ? (
          <Link to="/notification" search={{}} className={CARD_ACTION_CLASS} data-testid="dash-unread-all">
            {t('还有 {{n}} 条未读', { n: total - items.length })} →
          </Link>
        ) : undefined
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
      emptyIcon={<IconBellOff className="size-6 text-muted-foreground/60" aria-hidden />}
    >
      <ul className="-my-2 flex flex-col">
        {items.map((n) => (
          <UnreadRow key={n.id} n={n} openNotice={openNotice} linkOf={linkOf} readIfUnread={readIfUnread} />
        ))}
      </ul>
    </DashboardCard>
  )
}

const ROW = 'flex w-full items-start gap-2.5 rounded-md py-2 text-start transition-colors hover:bg-muted/40'

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
      <span className={cn('grid size-[30px] shrink-0 place-items-center rounded-full', meta.tone)} aria-hidden>
        <meta.Icon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-semibold">{n.title}</span>
        <span className="text-xs text-muted-foreground">
          {t(meta.label)} · {relativeTime(n.created_time, t)}
        </span>
      </span>
      <i className="mt-2 size-[7px] shrink-0 rounded-full bg-primary" aria-label={t('未读')} />
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
          className={ROW}
          data-testid={`dash-unread-${n.id}`}
        >
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onActivate} className={ROW} data-testid={`dash-unread-${n.id}`}>
          {body}
        </button>
      )}
    </li>
  )
}

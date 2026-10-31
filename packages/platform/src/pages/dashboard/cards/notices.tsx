import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconSpeakerphone } from '@tabler/icons-react'

import { formatDateTimeShort } from '@admin/i18n'
import { cn } from '@admin/ui/lib/utils'

import { CATEGORY } from '../../notification/api'
import { noticeFeedQuery, publishedAt } from '../../notice/api'
import { AttachmentCount, NoticeLevelPill, PinnedMark } from '../../notice/shared'
import { CARD_ACTION_CLASS, CARD_ROW_CLASS, DashboardCard } from '../card-shell'
import type { CardProps } from './types'

/** 卡片里放几条。置顶的在前（后端排序），翻更多去消息中心的「公告」分类 */
export const DASH_NOTICE_SIZE = 5

/**
 * 「公告」卡（#186）。
 *
 * 🔴 **它不依赖任何管理权限**：数据走 `/sys/notices/feed`（只要登录），所有人的工作台上都有它。
 * 点一行**就地打开**详情（`openNotice` → 页面把 id 写进自己的 search，硬纪律 2），不跳页。
 */
export function NoticesCard({ openNotice }: CardProps) {
  const { t } = useTranslation()
  const query = useQuery(noticeFeedQuery({ page: 1, size: DASH_NOTICE_SIZE }))
  const items = query.data?.items ?? []

  return (
    <DashboardCard
      testId="dash-notices"
      title={t('公告')}
      icon={<IconSpeakerphone className="size-4 text-amber-600 dark:text-amber-500" aria-hidden />}
      note={query.data && query.data.total > 0 ? t('共 {{n}} 条', { n: query.data.total }) : undefined}
      action={
        // 「全部」= 消息中心的公告分类。那一页不挂权限码，谁都进得去
        <Link
          to="/notification"
          search={{ category: CATEGORY.ANNOUNCEMENT }}
          className={CARD_ACTION_CLASS}
          data-testid="dash-notices-all"
        >
          {t('全部')}
        </Link>
      }
      loading={query.isPending}
      // 硬纪律 9：取数失败不能长成「暂无公告」—— 那和「真的没发过公告」分不出来
      error={query.error}
      onRetry={() => void query.refetch()}
      empty={items.length === 0}
      emptyText={t('暂无公告')}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => openNotice(n.id)}
              className={CARD_ROW_CLASS}
              data-testid={`dash-notice-${n.id}`}
              data-unread={!n.read}
            >
              {/* 未读点占位固定宽度：有没有点，标题都从同一条竖线开始 */}
              <span className="flex w-2 shrink-0 justify-center">
                {!n.read && (
                  <span className="size-1.5 rounded-full bg-destructive" data-testid="dash-notice-unread">
                    <span className="sr-only">{t('未读')}</span>
                  </span>
                )}
              </span>
              {n.pinned && <PinnedMark />}
              <NoticeLevelPill level={n.level} className="shrink-0" />
              <span className={cn('min-w-0 flex-1 truncate', !n.read && 'font-medium')}>{n.title}</span>
              <AttachmentCount count={n.attachment_count} />
              {/* 定时发布的显示到点那一刻（和后端排序同一个口径），不是建好那一刻 */}
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {formatDateTimeShort(publishedAt(n))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </DashboardCard>
  )
}

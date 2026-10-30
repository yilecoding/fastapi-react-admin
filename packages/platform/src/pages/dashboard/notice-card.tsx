import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconSpeakerphone } from '@tabler/icons-react'

import { formatDateTimeShort } from '@admin/i18n'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import { CATEGORY } from '../notification/api'
import { noticeFeedQuery, publishedAt } from '../notice/api'
import { AttachmentCount, NoticeLevelPill, PinnedMark } from '../notice/shared'

/** 卡片里放几条。置顶的在前（后端排序），翻更多去消息中心的「公告」分类 */
export const DASH_NOTICE_SIZE = 5

/**
 * 工作台的「公告」卡（#186）。
 *
 * 🔴 **它不依赖任何管理权限**：数据走 `/sys/notices/feed`（只要登录）。工作台上别的卡
 * 都是管理员看板，普通用户打开是一条「没有权限查看这些数据」+ 一排 `—` ——
 * 这张卡要在那旁边照常显示，所以它的取数、加载、失败都自己管，不进页面那个汇总的错误条。
 *
 * 点一行**就地打开**详情（`onOpen` → 页面把 id 写进自己的 search，硬纪律 2），不跳页。
 */
export function DashboardNoticeCard({ onOpen }: { onOpen: (noticeId: string) => void }) {
  const { t } = useTranslation()
  const query = useQuery(noticeFeedQuery({ page: 1, size: DASH_NOTICE_SIZE }))
  const items = query.data?.items ?? []

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3"
      data-testid="dash-notices"
      aria-labelledby="dash-notices-title"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span id="dash-notices-title" className="flex items-center gap-1.5 text-sm font-medium">
            <IconSpeakerphone className="size-4 text-amber-600 dark:text-amber-500" aria-hidden />
            {t('公告')}
          </span>
          {query.data && query.data.total > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('共 {{n}} 条', { n: query.data.total })}
            </span>
          )}
        </div>
        {/* 「全部」= 消息中心的公告分类。那一页不挂权限码，谁都进得去 */}
        <Link
          to="/notification"
          search={{ category: CATEGORY.ANNOUNCEMENT }}
          className="text-xs text-primary underline-offset-2 hover:underline"
          data-testid="dash-notices-all"
        >
          {t('全部')}
        </Link>
      </div>

      {query.error ? (
        // 硬纪律 9：取数失败不能长成「暂无公告」—— 那和「真的没发过公告」分不出来
        <QueryError error={query.error} onRetry={() => void query.refetch()} testId="dash-notices-error" />
      ) : query.isPending ? (
        <div className="flex flex-col gap-2" data-testid="dash-notices-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground" data-testid="dash-notices-empty">
          {t('暂无公告')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onOpen(n.id)}
                className="flex w-full items-center gap-2 rounded-sm py-1.5 text-start text-sm transition-colors hover:bg-muted/50"
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
      )}
    </section>
  )
}

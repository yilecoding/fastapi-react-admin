import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconSpeakerphone, IconX } from '@tabler/icons-react'

import { formatDateTimeShort } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'

import { noticeBannerQuery, publishedAt, useMarkNoticeRead, type NoticeFeedItem } from './api'
import { NoticeReaderSheet } from './reader-sheet'
import { NoticeLevelPill } from './shared'

/**
 * 顶栏下面那条横幅（#190）：**置顶 + 紧急 + 我没读**的公告，最多 3 条（条件全在后端 `feed/banner`）。
 *
 * - 点标题 → 就地打开读者抽屉（和铃铛同一个；抽屉按详情标已读，标完这一条自己从横幅里消失）
 * - 点 × → **标已读**（=「已知悉」）。跟着人走、不落 localStorage：换台电脑 / 清缓存都不会再冒出来，
 *   这正是 #190 不让它「只存 localStorage」的原因
 * - 🔴 必须确认的那种**不给 ×**：× 就是标已读，点它等于替人点了「我已阅读」。它只能从标题进去、在抽屉底部确认
 *
 * 外壳家具，挂在 `routes/_auth.tsx` 顶栏下面一次；不在任何 tab 里，抽屉 portal 落 `<body>`（同铃铛）。
 * 刷新时机：挂在读者 feed 前缀下，`invalidateInbox`（socket 推送 / 任何一处标已读）会一起重取。
 *
 * 取数失败**不画**，只在控制台留一条 —— 理由同 `popup-host.tsx` 头注释（它是推出来的提醒，同一批公告在
 * 铃铛 / 工作台里照样看得到、那几处的失败是可见的；在每个页面顶上挂一条红色报错比它要提醒的事还吵）。
 */
export function NoticeBanner() {
  const { t } = useTranslation()
  const query = useQuery(noticeBannerQuery)
  const [reading, setReading] = React.useState<string | null>(null)

  // 点了 × 的先藏起来（不等标已读回来再重取）；失败了放回去，原因走全局 toast
  const [closed, setClosed] = React.useState<ReadonlySet<string>>(() => new Set())
  const { mutate: markRead } = useMarkNoticeRead()
  const close = (n: NoticeFeedItem) => {
    if (!n.notification_id) return
    setClosed((prev) => new Set(prev).add(n.id))
    markRead(n.notification_id, {
      onError: () =>
        setClosed((prev) => {
          const next = new Set(prev)
          next.delete(n.id)
          return next
        }),
    })
  }

  React.useEffect(() => {
    if (query.error) {
      console.warn('[notice] 公告横幅取数失败；下一次收件箱变动（新公告推送 / 标已读）时会重取', query.error)
    }
  }, [query.error])

  const items = (query.data ?? []).filter((n) => !closed.has(n.id))

  return (
    <>
      {items.length > 0 && (
        <div
          role="region"
          aria-label={t('紧急公告')}
          className="shrink-0 divide-y divide-destructive/15 border-b border-destructive/20 bg-destructive/[0.06]"
          data-testid="notice-banner"
        >
          {items.map((n) => (
            <div
              key={n.id}
              className="flex min-w-0 items-center gap-2 px-4 py-1.5 text-sm"
              data-testid="notice-banner-item"
              data-notice-id={n.id}
            >
              <IconSpeakerphone className="size-4 shrink-0 text-destructive" aria-hidden />
              <NoticeLevelPill level={n.level} className="shrink-0" />
              <button
                type="button"
                onClick={() => setReading(n.id)}
                className="min-w-0 flex-1 truncate text-start font-medium underline-offset-2 hover:underline"
                data-testid="notice-banner-open"
              >
                {n.title}
              </button>
              <span className="hidden shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:inline">
                {formatDateTimeShort(publishedAt(n))}
              </span>
              {n.require_ack ? (
                // 不给 ×：见文件头。告诉人该去哪确认，而不是让他找不到关掉的办法
                <span className="shrink-0 text-xs text-muted-foreground">{t('点标题阅读并确认')}</span>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 text-muted-foreground"
                        aria-label={t('知道了，不再显示')}
                        onClick={() => close(n)}
                        data-testid="notice-banner-close"
                      />
                    }
                  >
                    <IconX />
                  </TooltipTrigger>
                  <TooltipContent>{t('知道了，不再显示')}</TooltipContent>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      )}
      {/* 抽屉常驻（不跟着横幅条目卸载）：标完已读那一条从横幅里消失时，抽屉还开着、要能播完 */}
      <NoticeReaderSheet noticeId={reading} onOpenChange={(o) => !o && setReading(null)} />
    </>
  )
}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconArchive } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { QueryError } from '@admin/ui/components/query-error'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'

import { useTabPortalContainer } from '../../shell/tab-outlet'
import { notificationKeys } from '../notification/api'
import {
  NOTICE_TYPE_LABEL, isNoticeGone, noticeFeedDetailQuery, noticeKeys, useMarkNoticeRead,
} from './api'
import { NoticeArticle } from './article'
import { NoticeLevelPill, PinnedMark } from './shared'

/**
 * 读者看公告的那个抽屉（#186）。**任何登录用户都打得开**：数据走 `/sys/notices/feed/{pk}`，
 * 不碰要 `sys:notice:add` 的管理端接口。
 *
 * 原来全站唯一能读到公告正文的地方是管理页 —— 普通用户点铃铛里那一行直接进 `/403`，
 * 而且那一下已经把它标成已读了。现在铃铛、消息中心、工作台都就地打开这一个。
 *
 * 受控：`noticeId` 非空就开着。谁来管这个 id 由调用方定 ——
 * 页面里的（消息中心 / 工作台）放进 URL（硬纪律 2），铃铛是外壳家具，用组件 state。
 *
 * 🔴 **portal 挂进本 tab 的根节点**（`useTabPortalContainer`）：页面里那两处是开在 URL 上的，
 * 刷新后后台 tab 恢复出来、抽屉照样渲染，挂在 `<body>` 下就会压住前台页面
 * （[shell 分册](../../shell/AGENTS.md)）。铃铛不在任何 tab 里，拿到的是 `undefined` = 回落到 `<body>`，正是它要的
 * （⚠️ 不是 `null`：Base UI 把显式 `null` 当「容器还没好」，一直等、什么都不挂 —— 见 `tab-outlet.tsx`）。
 */
export function NoticeReaderSheet({
  noticeId,
  onOpenChange,
  rowAlreadyMarked = false,
}: {
  noticeId: string | null
  onOpenChange: (open: boolean) => void
  /** 从收件箱那一行点开的：行上已经标过已读了，抽屉别再标（两个 PUT 抢着发） */
  rowAlreadyMarked?: boolean
}) {
  const { t } = useTranslation()
  const container = useTabPortalContainer()

  // 关的时候调用方会立刻把 id 清掉，而抽屉还要播完退场动画 ——
  // 留着上一个 id，不然滑出去的是一张空白抽屉（「随渲染调整 state」的写法，不是 effect）
  const [lastId, setLastId] = React.useState(noticeId)
  if (noticeId !== null && noticeId !== lastId) setLastId(noticeId)
  const shownId = noticeId ?? lastId

  return (
    <Sheet open={noticeId !== null} onOpenChange={onOpenChange}>
      <SheetContent
        container={container}
        side="right"
        className="gap-0 data-[side=right]:sm:max-w-2xl"
        data-testid="notice-reader"
      >
        {shownId ? (
          <ReaderBody id={shownId} markRead={!rowAlreadyMarked} />
        ) : (
          <SheetTitle className="sr-only">{t('公告详情')}</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ReaderBody({ id, markRead: shouldMark }: { id: string; markRead: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const query = useQuery(noticeFeedDetailQuery(id))
  const d = query.data
  const gone = isNoticeGone(query.error)

  // 打开 = 读过了。未读才发（接口幂等，但每次打开都发是纯噪音）；
  // 发完 `useMarkNoticeRead` 会把详情重新取一遍，`read` 变 true，这条 effect 就不会再发
  const { mutate: markRead } = useMarkNoticeRead()
  const unreadRow = shouldMark && d && !d.read ? d.notification_id : null
  React.useEffect(() => {
    if (unreadRow) markRead(unreadRow)
  }, [unreadRow, markRead])

  // 404 = 撤回 / 过期 / 删了。手上的列表（工作台卡片、收件箱）多半还挂着这一行，顺手让它们重取一遍；
  // 只失效**列表**那一半 —— 连详情一起失效会再打一次注定 404 的请求
  React.useEffect(() => {
    if (!gone) return
    void qc.invalidateQueries({ queryKey: [...noticeKeys.feedAll(), 'list'] })
    void qc.invalidateQueries({ queryKey: notificationKeys.all })
  }, [gone, qc])

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4 p-4" data-testid="notice-reader-loading">
        <SheetTitle className="sr-only">{t('公告详情')}</SheetTitle>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (gone) {
    // 不是「出错了」：这是一个确定的答案，所以不给重试按钮，也不用红色
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
        data-testid="notice-reader-gone"
      >
        <IconArchive className="size-8 text-muted-foreground" aria-hidden />
        <SheetTitle className="text-base">{t('这条公告已撤回或已过期')}</SheetTitle>
        <SheetDescription className="text-xs">
          {t('发布方已经把它收回，或者它过了有效期，正文和附件都看不到了。')}
        </SheetDescription>
      </div>
    )
  }

  if (query.error || !d) {
    // 硬纪律 9：失败是可见状态 + 重试，不能显示成一张空白抽屉
    return (
      <div className="p-4">
        <SheetTitle className="sr-only">{t('公告详情')}</SheetTitle>
        <QueryError
          error={query.error}
          onRetry={() => void query.refetch()}
          testId="notice-reader-error"
        />
      </div>
    )
  }

  return (
    <>
      {/* pe-12：右上角是关闭按钮（absolute end-4），标题别压到它下面 */}
      <SheetHeader className="gap-2 border-b pe-12">
        <div className="flex flex-wrap items-center gap-2">
          {d.pinned && <PinnedMark withLabel />}
          <NoticeLevelPill level={d.level} />
          <Badge variant="outline" className="font-normal">
            {t(NOTICE_TYPE_LABEL[d.type] ?? '公告')}
          </Badge>
        </div>
        <SheetTitle className="text-lg leading-snug" data-testid="notice-reader-title">
          {d.title}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums">
          <span>{t('发布于 {{at}}', { at: formatDateTime(d.created_time) })}</span>
          {d.updated_time && <span>{t('更新于 {{at}}', { at: formatDateTime(d.updated_time) })}</span>}
          {d.expire_time && (
            <span data-testid="notice-reader-expire">
              {t('{{at}} 过期', { at: formatDateTime(d.expire_time) })}
            </span>
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
        <NoticeArticle id={d.id} content={d.content} hideEmptyAttachments attachmentCount={d.attachment_count} />
      </div>
    </>
  )
}

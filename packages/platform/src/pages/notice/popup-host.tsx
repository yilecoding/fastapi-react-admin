import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'

import { useHoldTour, useTourActive } from '../../shell/tour/gate'
import { toast } from '@admin/ui/components/toast'

import {
  NOTICE_TYPE_LABEL, isNoticeGone, noticePopupsQuery, publishedAt, useMarkNoticeRead, type NoticeFeedDetail,
} from './api'
import { NoticeArticle } from './article'
import { NoticeLevelPill, PinnedMark, RequireAckMark } from './shared'

/**
 * 登录后弹窗（#190）。外壳挂上之后取一次 `GET /sys/notices/feed/popups`，**一条一条地**弹：
 * 标题 + 标记 + 正文 + 附件（和读者抽屉同一个 `NoticeArticle`）。
 *
 * - 必须确认的（`require_ack`）：唯一的出口是「我已阅读」—— 没有右上角的 ×，点遮罩 / 按 Esc 都关不掉
 *   （受控的 `open`：关闭请求来了不理就是不关）。标已读失败就留在原地、把原因画在按钮旁边
 * - 其余的：「知道了」或者正常关掉，**两种都算看过**（同样标已读），下一条接着弹
 * - 在线的人当场收到新发的必读公告：这份数据挂在读者 feed 前缀下，铃铛收到 socket
 *   `notification:new` 时调的 `invalidateInbox` 会把它重取一遍（见 `noticeKeys.popups`）
 *
 * ⚠️ 和铃铛一样是**外壳家具**：只在 `routes/_auth.tsx` 里挂一次，不进 `page-registry`。
 * 放在 `pages/notice/` 而不是 `shell/`：它要用公告的 api / 正文组件，`shell` 不能 import 页面。
 * 不在任何 tab 里，portal 落在 `<body>`（`DialogContent` 不传 container）。
 *
 * 🔴 **取数失败时不画任何东西**，只在控制台留一条告警 —— 这是对硬纪律 9 的一处有意偏离，理由：
 *
 * 1. 它是「推」出来的东西，不是用户来找的。弹窗没取到，不会让哪一块界面「看起来像没有这个功能」——
 *    同一批公告在铃铛 / 消息中心 / 工作台里照样看得到，那几处的取数失败都是**可见的**错误块
 * 2. 在每个页面顶上挂一条「公告弹窗加载失败」，比它想提醒的那件事还打扰人；画成一个弹窗更糟 ——
 *    那就是在拿一个失败的弹窗挡住整个系统
 * 3. 失败**不是永久的**：下一次收件箱变动（socket 推送新公告 / 任何一处标已读）会把它重取一遍，
 *    react-query 自己也会先重试一次（全局 `retry: 1`）
 *
 * 代价是写清楚的：断网登录、之后又一直没有任何收件箱事件的那个人，这一次会话里看不到弹窗，
 * 直到他刷新页面。必须确认的公告在工作台 / 铃铛里照样是未读、点开底部照样是「我已阅读」。
 */
export function NoticePopupHost() {
  const query = useQuery(noticePopupsQuery)
  // 导览正在跑（人自己从「帮助」点开的）就先等它结束：两个全屏浮层叠在一起谁都点不动（`gate.ts`）
  const tourActive = useTourActive()

  /**
   * 这次会话里已经处理掉的（点过「知道了」/ 关掉 / 确认成功）。标已读回来之后它本来就会从列表里消失，
   * 这里只是让下一条**立刻**接上，不用等那次重取；也让「知道了」标已读失败的那条不再弹第二遍
   * （它在铃铛里照样是未读，那一处的失败有 toast）
   */
  const [handled, setHandled] = React.useState<ReadonlySet<string>>(() => new Set())
  const markHandled = React.useCallback((id: string) => {
    setHandled((prev) => new Set(prev).add(id))
  }, [])

  const pending = React.useMemo(
    () => (query.data ?? []).filter((n) => !handled.has(n.id)),
    [query.data, handled]
  )

  // 正在弹的那一条钉住：弹着的时候 socket 推来一条置顶的新公告，列表顺序会变，
  // 不钉住的话人读到一半正文被换成另一条
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const current = pending.find((n) => n.id === activeId) ?? pending[0] ?? null
  if ((current?.id ?? null) !== activeId) setActiveId(current?.id ?? null)

  // 关的那一下还要播退场动画：留着最后一条，不然缩回去的是一个空壳（读者抽屉同一个写法）
  const [last, setLast] = React.useState<NoticeFeedDetail | null>(current)
  if (current && current !== last) setLast(current)
  const shown = current ?? last

  // 还在取、或者有一条要弹：按住外壳导览，别让它先弹出来压住弹窗（`gate.ts`）。
  // 失败了 `isPending` 就是 false —— 取不到弹窗不该连导览也一起挡掉
  useHoldTour('notice-popups', query.isPending || current !== null)

  React.useEffect(() => {
    if (query.error) {
      console.warn('[notice] 登录后弹窗取数失败；下一次收件箱变动（新公告推送 / 标已读）时会重取', query.error)
    }
  }, [query.error])

  const open = current !== null && !tourActive
  const mustAck = shown?.require_ack ?? false

  // 「知道了」那条路（不必确认的）：先放走、再标已读。失败走全局 toast —— 弹窗已经关了，
  // 那是唯一能看见失败的地方（这条 mutation 不压 toast）
  const { mutate: markSeen } = useMarkNoticeRead()
  const dismiss = React.useCallback(
    (n: NoticeFeedDetail) => {
      markHandled(n.id)
      if (n.notification_id) markSeen(n.notification_id)
    },
    [markHandled, markSeen]
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 🔴 受控：必须确认的不理任何关闭请求（Esc / 遮罩），出口只有「我已阅读」
        if (next || !current || current.require_ack) return
        dismiss(current)
      }}
      disablePointerDismissal={mustAck}
    >
      <DialogContent
        showCloseButton={!mustAck}
        className="flex max-h-[85svh] flex-col gap-4 sm:max-w-2xl"
        data-testid="notice-popup"
        data-notice-id={shown?.id}
        data-require-ack={mustAck}
      >
        {shown && (
          // key：换到下一条时按钮的失败 / 进行中状态不能带过去
          <PopupBody
            key={shown.id}
            notice={shown}
            remaining={Math.max(0, pending.length - 1)}
            onAcked={markHandled}
            onDismiss={dismiss}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PopupBody({
  notice: n,
  remaining,
  onAcked,
  onDismiss,
}: {
  notice: NoticeFeedDetail
  /** 这一条之后还有几条 */
  remaining: number
  onAcked: (id: string) => void
  onDismiss: (n: NoticeFeedDetail) => void
}) {
  const { t } = useTranslation()
  // 「我已阅读」：等标已读成功才放走。失败留在原地 + 原因画在按钮旁边（不弹 toast，不然同一个错误两遍）
  const ack = useMarkNoticeRead({ suppressErrorToast: true })

  async function acknowledge() {
    // 没有收件箱行就没有可以标的东西（后端按「已读」下发，弹窗接口不会给这种；兜底放走）
    if (!n.notification_id) return onAcked(n.id)
    try {
      await ack.mutateAsync(n.notification_id)
      onAcked(n.id)
    } catch (e) {
      // 🔴 404 = 这条在弹着的时候撤回 / 过期了（`isNoticeGone`，重试也不会变）：放走、接着弹下一条。
      // 当成普通错误留在原地的话，「我已阅读」永远 404，而这个弹窗没有别的出口 —— 整个外壳被挡住，只能刷新。
      // 弹窗 / 铃铛那几份数据的重取由 `useMarkNoticeRead` 的 onError 做（移动端 `notice-popups.tsx` 同一个处理）
      if (isNoticeGone(e)) {
        toast.info(t('这条公告已撤回或已过期'))
        onAcked(n.id)
      }
      // 别的错误在 `ack.error` 里，下面画出来
    }
  }

  return (
    <>
      {/* pe-8：右上角的 ×（不必确认时才有）别压住标签 */}
      <DialogHeader className="gap-2 pe-8">
        <div className="flex flex-wrap items-center gap-2">
          {n.pinned && <PinnedMark withLabel />}
          <NoticeLevelPill level={n.level} />
          {n.require_ack && <RequireAckMark />}
          <Badge variant="outline" className="font-normal">
            {t(NOTICE_TYPE_LABEL[n.type] ?? '公告')}
          </Badge>
        </div>
        <DialogTitle className="text-lg leading-snug" data-testid="notice-popup-title">
          {n.title}
        </DialogTitle>
        <DialogDescription className="text-xs tabular-nums">
          {t('发布于 {{at}}', { at: formatDateTime(publishedAt(n)) })}
        </DialogDescription>
      </DialogHeader>

      {/* 正文自己滚，标题和按钮钉住：一条长公告不能把「我已阅读」挤出屏幕 */}
      <div className="-mx-6 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6">
        <NoticeArticle id={n.id} content={n.content} hideEmptyAttachments attachmentCount={n.attachment_count} />
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <span className="text-xs text-muted-foreground" data-testid="notice-popup-remaining">
          {remaining > 0 ? t('后面还有 {{n}} 条', { n: remaining }) : null}
        </span>
        {n.require_ack ? (
          <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
            {ack.error && (
              <span className="text-xs text-destructive" data-testid="notice-popup-error">
                {ack.error.message || t('操作失败，请重试')}
              </span>
            )}
            <Button onClick={() => void acknowledge()} disabled={ack.isPending} data-testid="notice-popup-ack">
              {ack.isPending && <IconLoader2 className="size-4 animate-spin" />}
              {t('我已阅读')}
            </Button>
          </div>
        ) : (
          <Button onClick={() => onDismiss(n)} data-testid="notice-popup-ok">
            {t('知道了')}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

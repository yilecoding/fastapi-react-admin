import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconBell, IconChevronRight } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button, buttonVariants } from '@admin/ui/components/button'
import { Popover, PopoverContent, PopoverTrigger } from '@admin/ui/components/popover'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@admin/ui/components/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { useSocketEvent } from '../../shell/socket-events'
import { NoticeReaderSheet } from '../notice/reader-sheet'
import { AttachmentCount } from '../notice/shared'
import {
  CATEGORY,
  invalidateInbox,
  markableUnread,
  noticeIdOf,
  notificationsQuery,
  unreadCountQuery,
  useMarkAllNotificationsRead,
} from './api'
import { categoryMeta, relativeTime } from './shared'
import { useNotificationOpen } from './use-open'

/** 下拉里一次显示几条。翻历史去「消息中心」页，这里只是最近的一小截 */
const PREVIEW_SIZE = 8

type TabKey = 'all' | 'system' | 'announcement'

const TABS: { key: TabKey; label: string; category?: number }[] = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '消息', category: CATEGORY.SYSTEM },
  { key: 'announcement', label: '公告', category: CATEGORY.ANNOUNCEMENT },
]

/**
 * 顶栏的通知铃铛。
 *
 * ⚠️ **它是外壳家具，不是标签页** —— 只在 `routes/_auth.tsx` 的顶栏里挂一次。
 * **不要**把它注册进 `page-registry.tsx`。
 * 跳转仍然用 `<Link>` 而不是 `useNavigate()`（全站页面组件的统一做法）。
 *
 * ⚠️ 放在 `pages/notification/` 而不是 `shell/`：它和消息中心页共用同一份
 * `api.ts`（query key 一致，任一处标记已读，另一处的红点立刻跟着变）。
 * 放进 `shell/` 就会变成 `shell → pages` 的反向 import —— 那条路只给
 * `use-sidebar → dev-sandbox` 那个没别的办法的特例留着。
 */
export function NotificationBell() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState<TabKey>('all')
  /**
   * 正在读的公告。铃铛是外壳家具、不在任何 tab 里，没有 search 可写，用组件 state。
   * 抽屉挂在 Popover **外面**（见 return）：点一行要先关下拉再开抽屉，
   * 挂在 `PopoverContent` 里的话下拉一关它就跟着卸载了
   */
  const [reading, setReading] = React.useState<string | null>(null)

  const unread = useQuery(unreadCountQuery)
  const markAll = useMarkAllNotificationsRead()
  const { linkOf, readIfUnread } = useNotificationOpen()

  // 服务端推来「有新的」时重新拉未读数和列表。
  // 🔴 事件本身不带内容，这里也**不要**去信任 payload —— 权限判断只有 REST 一处
  // （见后端 `common/socketio/actions.py: notification_new` 的注释）。
  // 公告读者列表一起失效（`invalidateInbox`）：新发 / 撤回的公告要出现在 / 消失于工作台公告卡上
  useSocketEvent('notification:new', () => {
    void invalidateInbox(qc)
  })

  const category = TABS.find((x) => x.key === tab)?.category
  const listQuery = useQuery({
    ...notificationsQuery({ page: 1, size: PREVIEW_SIZE, category }),
    // 没打开就不取 —— 红点靠的是那条轻量的 unread-count，不是这份列表
    enabled: open,
  })

  const total = unread.data?.total ?? 0
  // 「全部已读」按这个数判，不按 `total`：必须确认的公告后端会跳过（#190），只剩它们时按钮该灰掉
  const markable = markableUnread(unread.data)
  const byCategory = unread.data?.by_category ?? {}
  const items = listQuery.data?.items ?? []

  function countOf(key: TabKey): number {
    if (key === 'all') return total
    const c = TABS.find((x) => x.key === key)?.category
    return c === undefined ? 0 : (byCategory[String(c)] ?? 0)
  }

  // ⚠️ 形状照抄 `DataTableColumnVisibility`：**TooltipTrigger 只做 `render`、
  // 不带 children**，图标和角标挂在真正的 PopoverTrigger 上。反过来写
  // （children 放 TooltipTrigger）Base UI 会警告
  // 「acts as a button expected a native <button>」——它拿到的是另一个
  // trigger 组件而不是原生按钮。
  const trigger = (
    <PopoverTrigger
      render={
        <Button
          variant="ghost"
          size="icon"
          className="relative size-7"
          data-testid="notification-bell"
          data-tour="notifications"
          aria-label={t('通知中心')}
        />
      }
    >
      <IconBell className="size-4" />
      {/* 取数失败要**看得见**（硬纪律 9）：不能悄悄不显示红点 ——
          那和「一条未读都没有」长得一模一样。 */}
      {unread.error ? (
        <span
          data-testid="notification-badge-error"
          className="absolute -end-1 -top-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white"
        >
          !
        </span>
      ) : total > 0 ? (
        <span
          data-testid="notification-badge"
          className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-white tabular-nums"
        >
          {total > 99 ? '99+' : total}
        </span>
      ) : null}
    </PopoverTrigger>
  )

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>
            {unread.error
              ? t('未读数获取失败')
              : total > 0
                ? t('{{n}} 条未读', { n: total })
                : t('通知中心')}
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-[22rem] gap-0 p-0"
          data-testid="notification-panel"
        >
          <div className="flex items-center gap-2 px-4 pt-4 pb-3">
            <span className="text-sm font-semibold">{t('通知中心')}</span>
            {total > 0 && (
              <Badge variant="destructive" className="font-normal">
                {t('{{n}} 条未读', { n: total })}
              </Badge>
            )}
            <Button
              variant="link"
              size="sm"
              className="ms-auto h-auto p-0 text-xs"
              disabled={markable === 0 || markAll.isPending}
              onClick={() => markAll.mutate()}
              data-testid="notification-mark-all"
            >
              {t('全部已读')}
            </Button>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="px-4 pb-3">
            <TabsList className="w-full">
              {TABS.map((x) => (
                <TabsTrigger key={x.key} value={x.key} data-testid={`notification-tab-${x.key}`}>
                  {t(x.label)}
                  {countOf(x.key) > 0 && (
                    <span className="text-xs font-medium text-destructive tabular-nums">
                      {countOf(x.key)}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* 面板自己是定高视区：条目多了只滚这一段，头部与页脚钉住 */}
          <div className="max-h-80 min-h-24 overflow-y-auto border-t border-border">
            {listQuery.error ? (
              <QueryError
                error={listQuery.error}
                onRetry={() => void listQuery.refetch()}
                className="m-3"
                testId="notification-list-error"
              />
            ) : listQuery.isPending ? (
              <div className="flex flex-col gap-3 p-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-2/3" />
                      <Skeleton className="h-3 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                {t('暂无通知')}
              </p>
            ) : (
              <ul>
                {items.map((n) => {
                  const meta = categoryMeta(n.category)
                  // 公告那一行就地打开详情（#186）：原来跳 `link` = 管理页，普通用户点进去是 403，
                  // 而且这一下已经把它标成已读了
                  const noticeId = noticeIdOf(n)
                  const to = noticeId ? null : linkOf(n)
                  const rowClass = cn(
                    'flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/60',
                    !n.read_time && 'bg-muted/30'
                  )
                  const onActivate = () => {
                    setOpen(false)
                    // 公告那一行**不在这里标已读**，交给读者抽屉：它拿到详情才知道这条是不是
                    // 「必须确认」（#190）—— 在这里标掉，「我已阅读」就成了摆设
                    if (noticeId) setReading(noticeId)
                    else readIfUnread(n)
                  }
                  // 有合法目标就是链接（中键/新窗口都能用），没有就是个只标已读的按钮。
                  // `to` 是库里的自由字符串，`isValidPath` 已经验过它真实存在；
                  // TanStack 的 `to` 类型是**已知路由的字面量联合**，动态值只能断言过去
                  const body = (
                    <>
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-full',
                          meta.tone
                        )}
                      >
                        <meta.Icon className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {n.title}
                          </span>
                          <AttachmentCount count={n.attachment_count} className="mt-0.5" />
                          {/* 必须确认的（#190）：「全部已读」标不掉它，标出来，不然按钮灰了、红点还在，看不出为什么 */}
                          {n.requires_ack && !n.read_time && (
                            <span
                              className="mt-0.5 shrink-0 text-xs text-amber-700 dark:text-amber-300"
                              data-testid="notification-item-needs-ack"
                            >
                              {t('需确认')}
                            </span>
                          )}
                          {!n.read_time && (
                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
                          )}
                        </span>
                        {/* 两行截断：正文长度不受控，不截会把一条通知撑满整个面板 */}
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {n.content}
                        </span>
                        <span className="text-xs text-muted-foreground/80">
                          {relativeTime(n.created_time, t)}
                        </span>
                      </span>
                    </>
                  )
                  return (
                    <li key={n.id}>
                      {to ? (
                        <Link
                          to={to.to as never}
                          search={to.search as never}
                          onClick={onActivate}
                          data-testid="notification-item"
                          data-unread={!n.read_time}
                          className={rowClass}
                        >
                          {body}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={onActivate}
                          data-testid="notification-item"
                          data-unread={!n.read_time}
                          data-notice-id={noticeId ?? undefined}
                          className={rowClass}
                        >
                          {body}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-border">
            <Link
              to="/notification"
              search={{}}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'w-full rounded-none rounded-b-md text-xs text-muted-foreground'
              )}
              data-testid="notification-view-all"
              onClick={() => setOpen(false)}
            >
              {t('查看全部通知')}
              <IconChevronRight className="size-3.5" />
            </Link>
          </div>
        </PopoverContent>
      </Popover>
      {/* 标已读由抽屉自己按详情决定（必须确认的不自动标），见 `reader-sheet.tsx` */}
      <NoticeReaderSheet noticeId={reading} onOpenChange={(o) => !o && setReading(null)} />
    </>
  )
}

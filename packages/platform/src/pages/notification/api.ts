import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * 站内消息（收件箱）。
 *
 * ⚠️ 接口前缀是 **`/api/v1/sys/notifications`**，不是 `plugin.toml` 里写的
 * `/notifications` —— 这个插件 `extend = "admin"`，路由被挂到了 admin 的 sys 下。
 * 通知公告 / 参数配置都踩过同一个坑。
 *
 * ⚠️ id 是雪花字符串，不要 `Number()`（CLAUDE.md 硬纪律 6）。
 */
export type Notification = {
  id: string
  title: string
  content: string
  /** 见 `CATEGORY` */
  category: number
  /** 点击跳转的前端路由；为空则整条不可点 */
  link: string | null
  /** 为空 = 全员广播 */
  recipient_id: string | null
  created_time: string
  /** 为空 = 未读。**它不是数据库列**，由后端按 `sys_notification_read` 回填 */
  read_time: string | null
  /**
   * 来源业务对象，`<类型>:<ID>`（如 `notice:2049…`）；没有来源是 `null`（#186 之前发的老行也是）。
   * 前端认出公告就**就地打开详情**，不拿 `link` 去跳 —— 见 `noticeIdOf`
   */
  source: string | null
  /** 来源对象**现在**的附件个数（查询时现算，不是发布时存的）；没有来源是 `null` */
  attachment_count: number | null
  /**
   * 必须读者打开确认（#190 公告的「必须确认」）。这种行**不能**在列表里标已读，「全部已读」也会跳过它 ——
   * 只能在读者抽屉 / 弹窗里点「我已阅读」。查询时现算，不是数据库列
   */
  requires_ack: boolean
}

/**
 * 这一行是不是某条公告的广播，是的话给出公告 id（雪花字符串，不 `Number()`，硬纪律 6）。
 *
 * 🔴 按 `source` 认，**不按 `link` 认**。老的公告行 `link` 是 `/plugins/notice`（管理页，
 * 要 `sys:notice:add`），普通用户点进去是 403 —— 而 `link` 是库里的自由字符串，
 * 拿它猜「这是不是公告」迟早猜错。`source` 是后端写的结构化来源，认不出就返回 `null`，
 * 那一行照旧走 `link`。
 */
export function noticeIdOf(n: Pick<Notification, 'source'>): string | null {
  const m = /^notice:(\d+)$/.exec(n.source ?? '')
  return m ? m[1]! : null
}

/**
 * 分类。数值和后端 `plugin/notification/enums.py: NotificationCategory` 一一对应，
 * **改数字要两边一起改** —— 这个值已经落进库里了。
 *
 * `TASK`（2）目前没有生产者：任务事件走 socket 的瞬时 toast，不落库。
 * 留着它是为了「以后要留痕」时不用改分类编号。
 */
export const CATEGORY = { SYSTEM: 0, ANNOUNCEMENT: 1, TASK: 2 } as const

export type NotificationListParams = {
  page: number
  size: number
  title?: string
  category?: number
  /** true 只看未读 · false 只看已读 · undefined 不筛 */
  unread?: boolean
}

export type UnreadCount = {
  total: number
  /** key 是分类数值的**字符串**形式（JSON 对象的 key 只能是字符串） */
  by_category: Record<string, number>
  /** 未读里必须打开确认的条数 —— 「全部已读」标不掉它们（见 `markableUnread`） */
  requires_ack_count: number
}

/**
 * 「全部已读」点下去能标掉几条 = 未读总数 − 必须确认的（后端跳过它们）。
 *
 * 🔴 「全部已读」的按钮和确认框用这个数，**不用 `total`**：只剩必须确认的公告时 `total` 仍然 > 0（红点照亮，那是对的），
 * 按 `total` 判的话按钮一直可点、确认框说「会把 1 条标为已读」，点完什么都没变
 */
export function markableUnread(u: UnreadCount | undefined): number {
  if (!u) return 0
  return Math.max(0, u.total - (u.requires_ack_count ?? 0))
}

export const notificationKeys = {
  all: ['sys', 'notification'] as const,
  list: (p: NotificationListParams) => [...notificationKeys.all, 'list', p] as const,
  unread: () => [...notificationKeys.all, 'unread'] as const,
}

function qs(p: NotificationListParams): string {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.title) s.set('title', p.title)
  if (p.category !== undefined) s.set('category', String(p.category))
  if (p.unread !== undefined) s.set('unread', String(p.unread))
  return s.toString()
}

export const notificationsQuery = (p: NotificationListParams) =>
  queryOptions({
    queryKey: notificationKeys.list(p),
    queryFn: () => api.GET<PageData<Notification>>(`/api/v1/sys/notifications?${qs(p)}`),
    // 翻页时保留上一页，避免列表闪空
    placeholderData: (prev) => prev,
  })

/**
 * 未读数（红点）。
 *
 * 🔴 **它必须能靠这条 REST 调用拿到正确值，不能只靠 socket 推送。**
 * socket 是尽力而为的（连不上不报错，见 `shell/use-presence.ts` 的哲学）——
 * 只靠推送的话，断线期间到达的通知会在红点上**永久性地看不见**，
 * 而界面上没有任何异常。推送只负责「让它早一点更新」。
 */
export const unreadCountQuery = queryOptions({
  queryKey: notificationKeys.unread(),
  queryFn: () => api.GET<UnreadCount>('/api/v1/sys/notifications/unread-count'),
  // 红点是全站常驻的，别让它跟着 30 秒的全局 staleTime 频繁重取；
  // 真正的更新时机是 socket 事件和用户自己的已读动作，两者都会显式失效它
  staleTime: 5 * 60_000,
})

/**
 * 公告读者列表（工作台公告卡）的 query key 前缀 —— `notice/api.ts` 的 `noticeKeys.feedAll()` 就是它。
 * 定义在这边是因为 `notice/api.ts` 已经 import 了这个文件，反过来 import 就成环。
 */
export const NOTICE_FEED_KEY = ['sys', 'notice', 'feed'] as const

/**
 * 收件箱变了（标已读 / 全部已读 / socket 说有新的或撤回了）之后要重取的东西。
 *
 * 🔴 **公告读者列表也在里面**（#186）：它的「读没读」就是收件箱那一行的已读状态。只失效收件箱的话，
 * 在铃铛里点了「全部已读」，工作台公告卡（被 `<Activity>` 保活着、`staleTime` 30 秒）还亮着一排未读点；
 * 新发的公告也要等手动刷新才出现在卡片上（代码评审指出）
 *
 * 登录后弹窗 / 顶部横幅（#190）的 key 也在 `NOTICE_FEED_KEY` 下面（`noticeKeys.popups()` / `banner()`），
 * 一起失效：铃铛收到 socket `notification:new` 时调的就是这里，所以「刚发了一条必读公告」
 * 在线的人当场弹出来，不用另外订阅一遍；标已读之后弹窗 / 横幅里那一条也跟着消失
 */
export function invalidateInbox(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: notificationKeys.all }),
    qc.invalidateQueries({ queryKey: NOTICE_FEED_KEY }),
  ])
}

/** 标记单条已读。**幂等** —— 重复调用返回成功，不要当成失败 */
export function useMarkNotificationRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.PUT<null>(`/api/v1/sys/notifications/${id}/read`),
    onSuccess: () => invalidateInbox(qc),
  })
}

/** 标记全部已读 */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.PUT<null>('/api/v1/sys/notifications/read-all'),
    onSuccess: () => invalidateInbox(qc),
  })
}

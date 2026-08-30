import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

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

/** 标记单条已读。**幂等** —— 重复调用返回成功，不要当成失败 */
export function useMarkNotificationRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.PUT<null>(`/api/v1/sys/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  })
}

/** 标记全部已读 */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.PUT<null>('/api/v1/sys/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  })
}

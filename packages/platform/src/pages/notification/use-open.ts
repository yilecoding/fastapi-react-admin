import * as React from 'react'

import { usePlatform } from '../../shell/platform-context'
import { useMarkNotificationRead, type Notification } from './api'

/**
 * 「点开一条通知」这件事的唯一实现 —— 铃铛下拉和消息中心页共用。
 *
 * 两件事，缺一件都会静默地错：
 *
 * 1. 🔴 **`link` 要先验一遍是不是真实存在的前端路由。** 它是库里的一个自由
 *    字符串（`sys_notification.link`，管理端发通知时自己填），前端删掉一个页面
 *    之后，历史通知里那条 link 就指向了不存在的路由 —— 直接 `<Link to>` 过去
 *    是一个 404 页，而用户看到的是「点了通知跳到找不到页面」。验不过就当作
 *    「这条不可点」，正文照样看得到。校验函数由 app 注入
 *    （`shell/platform-context.tsx`，platform 不认识 `apps/web` 的 routeTree）。
 * 2. 已读只在**未读**时才发请求。接口本身是幂等的，但每点一条已读通知都发一次
 *    PUT 是纯噪音，而且会让全站的通知 query 白白失效一轮。
 */
export function useNotificationOpen() {
  const { isValidPath } = usePlatform()
  const markRead = useMarkNotificationRead()

  /** 可点就返回目标路由，不可点返回 `null` */
  const linkOf = React.useCallback(
    (n: Notification): string | null => (n.link && isValidPath(n.link) ? n.link : null),
    [isValidPath]
  )

  const readIfUnread = React.useCallback(
    (n: Notification) => {
      if (!n.read_time) markRead.mutate(n.id)
    },
    [markRead]
  )

  return { linkOf, readIfUnread }
}

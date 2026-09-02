import * as React from 'react'

import { api } from '@/lib/api'
import type { NotificationUnread } from '@/lib/contract'
import { useSession } from '@/lib/session'

/**
 * 未读数 —— tab 上那个红点的唯一来源。
 *
 * **刻意不接 socket.io。** web 端靠 `platform/shell/use-presence.ts` 收
 * `notification_new` 事件实时刷新，移动端暂时用「回到前台 + 手动刷新」代替，
 * 理由是长连接在移动端要处理的东西完全不同（切后台被系统掐、蜂窝网切换、
 * 省电策略），那是独立一件事，不该顺手塞进这一版。
 *
 * ⚠️ 所以红点**不是实时的**。别在界面上暗示它是。
 */
type Ctx = {
  unread: NotificationUnread | null
  refresh: () => Promise<void>
}

const UnreadContext = React.createContext<Ctx>({ unread: null, refresh: async () => {} })

export function useUnread() {
  return React.useContext(UnreadContext)
}

export function UnreadProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [unread, setUnread] = React.useState<NotificationUnread | null>(null)

  const refresh = React.useCallback(async () => {
    if (status !== 'authed') return
    try {
      setUnread(await api.GET<NotificationUnread>('/api/v1/sys/notifications/unread-count'))
    } catch {
      // 红点拉不到就不显示 —— 这里**可以**吞掉异常，因为它不是一个「功能入口」，
      // 而是一个装饰。真正的列表页有完整的错误态（硬纪律 9 说的是不能把
      // 失败伪装成「这个功能不存在」，红点没有这个风险）。
    }
  }, [status])

  React.useEffect(() => {
    if (status === 'authed') void refresh()
    else setUnread(null)
  }, [status, refresh])

  const value = React.useMemo(() => ({ unread, refresh }), [unread, refresh])
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>
}

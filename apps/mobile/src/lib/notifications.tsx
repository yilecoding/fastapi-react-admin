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
  /** `null` = 还不知道（没拉过 / 拉失败）。**不要把它当 0 用**，见下面那条 */
  unread: NotificationUnread | null
  /**
   * 🔴 **「不知道」和「确实是 0」必须分开。**
   *
   * 红点本身可以吞掉失败（它是装饰），但**别的地方会拿 `unread?.total ?? 0`
   * 去做判断** —— 通知页的「全部已读」按钮就是 `disabled={total === 0}`，
   * 于是未读数拉失败时那个按钮**永久禁用**，且界面上没有任何理由。
   * 那正是根 CLAUDE.md 硬纪律 9 说的「把服务端错误伪装成这个功能不存在」。
   *
   * 所以这里显式给出「知不知道」这一位，调用方按它决定要不要禁用。
   */
  known: boolean
  refresh: () => Promise<void>
}

const UnreadContext = React.createContext<Ctx>({ unread: null, known: false, refresh: async () => {} })

export function useUnread() {
  return React.useContext(UnreadContext)
}

export function UnreadProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [unread, setUnread] = React.useState<NotificationUnread | null>(null)

  const refresh = React.useCallback(async () => {
    if (status !== 'authed') return
    try {
      setUnread(await api.GET('/api/v1/sys/notifications/unread-count'))
    } catch {
      // 红点拉不到就不显示 —— 这里**可以**吞掉异常，因为红点不是一个「功能
      // 入口」而是一个装饰。但要把 `unread` 归回 `null`（= 不知道），
      // 不能留着上一次的值，也不能让调用方把它读成 0。
      setUnread(null)
    }
  }, [status])

  React.useEffect(() => {
    if (status === 'authed') void refresh()
    else setUnread(null)
  }, [status, refresh])

  const value = React.useMemo(() => ({ unread, known: unread !== null, refresh }), [unread, refresh])
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>
}

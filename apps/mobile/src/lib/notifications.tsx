import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { api } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * 未读数 —— tab 上那个红点的唯一来源。
 *
 * **刻意不接 socket.io。** web 端靠 `platform/shell/use-presence.ts` 收
 * `notification_new` 事件实时刷新，移动端用「回到前台 + 手动刷新」代替
 * （回前台那一半是 `lib/query.tsx` 里接的 `focusManager`），理由是长连接在
 * 移动端要处理的东西完全不同（切后台被系统掐、蜂窝网切换、省电策略），
 * 那是独立一件事，不该顺手塞进这一版。
 *
 * ⚠️ 所以红点**不是实时的**。别在界面上暗示它是。
 */
export const unreadKey = ['notifications', 'unread'] as const

export function useUnread() {
  const { status } = useSession()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: unreadKey,
    queryFn: () => api.GET('/api/v1/sys/notifications/unread-count'),
    // 未登录时不发请求。`enabled` 而不是在 queryFn 里早退 ——
    // 早退要编一个假数据，而那个假数据会被当成「已知是 0」（见下）
    enabled: status === 'authed',
  })

  return {
    unread: q.data ?? null,

    /**
     * 🔴 **「不知道」和「确实是 0」必须分开。**
     *
     * 红点本身可以吞掉失败（它是装饰），但**别的地方会拿
     * `unread?.total ?? 0` 去做判断** —— 通知页的「全部已读」按钮就是
     * `disabled={total === 0}`，于是未读数拉失败时那个按钮**永久禁用**，
     * 且界面上没有任何理由。那正是根 CLAUDE.md 硬纪律 9 说的
     * 「把服务端错误伪装成这个功能不存在」。
     *
     * `isSuccess` 正好是这一位：只有真的拿到过数才算「知道」。
     */
    known: q.isSuccess,

    refresh: React.useCallback(async () => {
      await qc.invalidateQueries({ queryKey: unreadKey })
    }, [qc]),
  }
}

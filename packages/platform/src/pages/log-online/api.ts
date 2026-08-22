import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'
import { tokenStore } from '../../api-client/token-store'
import { formatDuration, t, toEpochMs } from '@admin/i18n'

/**
 * 在线用户（会话监控）。数据源 `GET /api/v1/monitors/sessions`（**仅超管**）。
 *
 * 三个必须知道的事实：
 *
 * 1. **接口不分页**：它扫 Redis 里 `fba:token:*` 的全部 key 再逐个解 JWT，
 *    一次性返回全量。所以分页、排序、搜索全在前端做（见 index.tsx）。
 * 2. **`id` 是用户 ID，会重复**：同一个人多端登录就有多条记录。
 *    表格的 `getRowId` 必须用 `session_uuid`，用 `id` 会让多行互相串选中态。
 * 3. **`status` 不是「账号是否启用」**，而是「这个会话有没有活着的 socket.io 连接」
 *    （后端拿 `fba:token_online` 这个 Redis set 对比）。我们的前端在 `_auth` 布局里
 *    连了 socket.io（见 `shell/use-presence.ts`），所以当前打开着页面的会话是「在线」，
 *    只留着有效 token 但没开页面的是「离线」。
 */
export type OnlineSession = {
  /** 用户 ID（雪花，字符串；同一用户多会话时会重复） */
  id: string
  /** 会话唯一标识 —— 表格行 ID 用这个 */
  session_uuid: string
  username: string
  nickname: string
  ip: string
  os: string
  browser: string
  device: string
  /** 1 = 有实时连接，0 = 仅 token 有效 */
  status: number
  last_login_time: string
  expire_time: string
}

export const onlineKeys = { all: ['monitor', 'sessions'] as const }

export const sessionsQuery = (refreshMs: number) =>
  queryOptions({
    queryKey: onlineKeys.all,
    queryFn: () => api.GET<OnlineSession[]>('/api/v1/monitors/sessions'),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: false,
  })

/**
 * 强制下线。
 *
 * 后端签名是 `DELETE /monitors/sessions/{pk}?session_uuid=...`，
 * `pk` 是**用户 ID** 而不是会话 ID —— 少传 session_uuid 会 422。
 *
 * ⚠️ `pk` 直接拼字符串进 URL，**不要 Number() 它**（雪花 ID 会掉精度，
 * 踢错人；见 CLAUDE.md 硬纪律 6）。
 */
export function useKickSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: Pick<OnlineSession, 'id' | 'session_uuid'>) =>
      api.DELETE(`/api/v1/monitors/sessions/${s.id}?session_uuid=${encodeURIComponent(s.session_uuid)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: onlineKeys.all }),
  })
}

/**
 * 批量下线。后端没有收数组的接口，只能并发发 N 个单条请求。
 * 用 `allSettled`：一条失败不该让已经踢掉的那些无声无息 —— 失败条数要报出来。
 */
export function useKickSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (list: Array<Pick<OnlineSession, 'id' | 'session_uuid'>>) => {
      const results = await Promise.allSettled(
        list.map((s) =>
          api.DELETE(`/api/v1/monitors/sessions/${s.id}?session_uuid=${encodeURIComponent(s.session_uuid)}`)
        )
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) throw new Error(t('{{failed}} / {{total}} 个会话下线失败', { failed, total: list.length }))
    },
    onSettled: () => qc.invalidateQueries({ queryKey: onlineKeys.all }),
  })
}

/** 当前浏览器自己的会话 —— 这一行不许勾、不许踢 */
export function currentSessionUuid(): string | null {
  return tokenStore.getSessionUuid()
}

/**
 * 距离过期还有多久，用于「剩余有效期」列。
 *
 * 这里原来有个自己写的 `parseServerTime()`：后端那时下发的是
 * `'2026-08-22 11:59:47'`（无时区标记），空格分隔的格式各浏览器解析不一致
 * （Safari 直接 Invalid Date），只能自己换成 `T` 再 parse。
 * 后端改成下发带偏移的 ISO 8601 之后这个 hack 没有存在意义了 ——
 * 解析统一走 `@admin/i18n` 的 `toEpochMs()`。
 */
export function remainingText(expireTime: string, now: number): { text: string; hours: number } {
  const at = toEpochMs(expireTime)
  if (at === null) return { text: '—', hours: Number.NaN }
  const ms = at - now
  if (ms <= 0) return { text: t('已过期'), hours: 0 }
  const hours = ms / 3_600_000
  // 成句一律交给 formatDuration（只取最高两级）—— 前端手拼「X 小时 Y 分」
  // 会漏掉语言，也和别处的时长格式不一致
  return { text: formatDuration(ms / 1000), hours }
}

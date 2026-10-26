import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'

/**
 * 通知渠道路由（#166）：系统策略矩阵 · 我的偏好矩阵。
 *
 * - **类型（kind）由后端注册表决定**（各插件的 `notification_kinds.py`），前端不维护清单：
 *   某个类型不支持某条渠道，那一格就不出现
 * - 站内渠道永远 forced、不能改：站内收件箱是通知的事实来源
 * - 全员广播类（公告 / 每日问候）只走站内，个人中心里不出现
 */
export type Channel = 'inapp' | 'email' | 'sms'
export type PolicyMode = 'off' | 'default_on' | 'default_off' | 'forced'

/** 矩阵的列序（和后端 `NotificationChannel` 的枚举顺序一致） */
export const CHANNELS: Channel[] = ['inapp', 'email', 'sms']

export type PolicyCell = { channel: Channel; mode: PolicyMode; default: PolicyMode; editable: boolean }
export type PolicyRow = {
  kind: string
  label: string
  category: number
  broadcast: boolean
  user_configurable: boolean
  cells: PolicyCell[]
}

export type PrefCell = { channel: Channel; mode: PolicyMode; configurable: boolean; enabled: boolean }
export type PrefRow = { kind: string; label: string; category: number; cells: PrefCell[] }
export type MyPrefs = { items: PrefRow[]; has_email: boolean; has_phone: boolean }

export const notifyKeys = {
  all: ['notify-channel'] as const,
  policies: () => [...notifyKeys.all, 'policies'] as const,
  prefs: () => [...notifyKeys.all, 'prefs'] as const,
}

const BASE = '/api/v1/sys/notification-channels'

export function policiesQuery() {
  return queryOptions({
    queryKey: notifyKeys.policies(),
    queryFn: () => api.GET<PolicyRow[]>(`${BASE}/policies`),
  })
}

export function myPrefsQuery() {
  return queryOptions({
    queryKey: notifyKeys.prefs(),
    queryFn: () => api.GET<MyPrefs>(`${BASE}/prefs/me`),
  })
}

export function useUpdatePolicies() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: { kind: string; channel: Channel; mode: PolicyMode }[]) =>
      api.PUT(`${BASE}/policies`, { body: { items } }),
    // 策略变了，个人偏好那张矩阵里「能不能改」也跟着变
    onSuccess: () => qc.invalidateQueries({ queryKey: notifyKeys.all }),
    meta: { suppressErrorToast: true },
  })
}

export function useUpdateMyPrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: { kind: string; channel: Channel; enabled: boolean }[]) =>
      api.PUT(`${BASE}/prefs/me`, { body: { items } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: notifyKeys.prefs() }),
    meta: { suppressErrorToast: true },
  })
}

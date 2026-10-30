import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'

/**
 * 群机器人（#166 二期）：飞书 / 钉钉 / 企业微信群里的自定义机器人，订阅几类通知，有一条就往群里推一条。
 *
 * - 🔴 **Webhook 地址本身就是凭据**：接口只下发 `webhook_hint`（掩码），编辑时地址 / 密钥「留空 = 不改」
 * - 能订阅的通知类型由后端注册表决定（`bot=True` 的那几类）：对着收件人说话的（「抄送给你」）不给推到群里
 * - 一条通知一个群一条消息，和收件人有几个无关
 */
export type BotPlatform = 'feishu' | 'dingtalk' | 'wecom'

export const PLATFORMS: BotPlatform[] = ['feishu', 'dingtalk', 'wecom']

/** 哪些平台支持加签（企业微信没有） */
export const SIGNING: ReadonlySet<BotPlatform> = new Set(['feishu', 'dingtalk'])

export type Bot = {
  id: string
  name: string
  platform: BotPlatform
  kinds: string[]
  status: number
  remark: string | null
  webhook_hint: string
  has_secret: boolean
  last_sent_time: string | null
  last_error: string | null
  created_time: string
  updated_time: string | null
}

export type BotOptions = {
  kinds: { kind: string; label: string; category: number }[]
  /** 服务端没配 `NOTIFICATION_ENCRYPT_SECRET_KEY`：一条都存不进去，表单直接说 */
  encrypt_key_ready: boolean
}

export type BotBody = {
  name: string
  platform: BotPlatform
  kinds: string[]
  status: number
  remark: string | null
  /** 编辑时留空 = 不改 */
  webhook_url?: string
  sign_secret?: string
  clear_sign_secret?: boolean
}

export type BotTestResult = { ok: boolean; reason: string | null; error: string | null; duration_ms: number }

export const botKeys = {
  all: ['notify-bot'] as const,
  list: () => [...botKeys.all, 'list'] as const,
  options: () => [...botKeys.all, 'options'] as const,
}

const BASE = '/api/v1/sys/notification-channels/bots'

export function botsQuery() {
  return queryOptions({ queryKey: botKeys.list(), queryFn: () => api.GET<Bot[]>(BASE) })
}

export function botOptionsQuery() {
  return queryOptions({ queryKey: botKeys.options(), queryFn: () => api.GET<BotOptions>(`${BASE}/options`) })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: botKeys.list() })
}

export function useCreateBot() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: BotBody) => api.POST<Bot>(BASE, { body }),
    onSuccess: invalidate,
    // 表单里内联显示后端的报错，全局 toast 再弹一遍只是噪音
    meta: { suppressErrorToast: true },
  })
}

export function useUpdateBot() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BotBody }) => api.PUT<Bot>(`${BASE}/${id}`, { body }),
    onSuccess: invalidate,
    meta: { suppressErrorToast: true },
  })
}

export function useDeleteBot() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api.DELETE(`${BASE}/${id}`), onSuccess: invalidate })
}

export function useTestBot() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.POST<BotTestResult>(`${BASE}/${id}/test`),
    // 卡片上的「最近成功 / 最近失败原因」跟着变
    onSuccess: invalidate,
  })
}

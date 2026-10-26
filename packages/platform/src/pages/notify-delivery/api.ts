import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'
import type { Channel } from '../notify-policy/api'

/**
 * 通知投递记录（`sys_notification_delivery`，#166）：每条通知 × 每条外部渠道一行。
 *
 * - 列表接口的 `address` 是**掩码**，详情接口才给完整值（同短信发送日志）
 * - 「结果未知」= 可能已经发出去了，后端**不自动重试**；要不要重发由人看过之后决定
 * - 「跳过」= 没发：没邮箱 / 手机号、账号停用、渠道插件没装。重发也没用，先补地址
 */
export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'exhausted' | 'skipped' | 'unknown'

export type Delivery = {
  id: string
  notification_id: string | null
  user_id: string
  kind: string
  channel: Channel
  address: string | null
  title: string
  content: string
  link: string | null
  status: DeliveryStatus
  reason: string | null
  attempts: number
  next_attempt_time: string | null
  last_error: string | null
  provider_ref: string | null
  duration_ms: number | null
  sent_time: string | null
  created_time: string
  updated_time: string | null
}

export const DELIVERY_STATUSES: DeliveryStatus[] = ['pending', 'sending', 'sent', 'failed', 'exhausted', 'skipped', 'unknown']

/** 能重发的状态（和后端 `crud_channel.resend` 的条件一致） */
export const RESENDABLE: ReadonlySet<DeliveryStatus> = new Set(['failed', 'exhausted', 'unknown'])

export const deliveryKeys = { all: ['notify-delivery'] as const }

export function deliveriesQuery(qs: string) {
  return queryOptions({
    queryKey: [...deliveryKeys.all, qs],
    queryFn: () => api.GET<PageData<Delivery>>(`/api/v1/sys/notification-channels/deliveries?${qs}`),
    placeholderData: (prev: PageData<Delivery> | undefined) => prev,
  })
}

export function deliveryDetailQuery(id: string | null) {
  return queryOptions({
    queryKey: [...deliveryKeys.all, 'detail', id],
    queryFn: () => api.GET<Delivery>(`/api/v1/sys/notification-channels/deliveries/${id}`),
    enabled: id !== null,
  })
}

export function useResendDelivery() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.POST(`/api/v1/sys/notification-channels/deliveries/${id}/resend`),
    onSuccess: () => qc.invalidateQueries({ queryKey: deliveryKeys.all }),
  })
}

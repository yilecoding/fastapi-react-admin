import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * Webhook 事件订阅（#167）：外部系统登记一个 URL + 想听的事件，事件发生后这边带签名 POST 过去。
 *
 * 🔴 **签名密钥同 SK：接口永远不下发明文和密文**，只有 `secret_hint`。明文只在新建 / 重置那一次的响应里。
 */
export type Webhook = {
  id: string
  app_id: string
  name: string
  url: string
  events: string[]
  status: number
  remark: string | null
  secret_hint: string
  /** 重置密钥后旧的那把还一起签到这个时间（轮换期） */
  secret_prev_expire_time: string | null
  disabled_reason: 'manual' | 'auto' | 'gone' | null
  disabled_time: string | null
  consecutive_failures: number
  first_failure_time: string | null
  last_delivery_time: string | null
  last_success_time: string | null
  created_time: string
}

export type WebhookBody = { name: string; url: string; events: string[]; status: number; remark: string | null }

export type IssuedWebhookSecret = { id: string; secret_key: string }

export type WebhookEvent = { type: string; label: string; scope: string; sample: Record<string, unknown> }

export type DeliveryStatus = 'pending' | 'sending' | 'success' | 'failed' | 'exhausted'

export type WebhookDelivery = {
  id: string
  webhook_id: string
  webhook_name: string
  event_id: string
  event_type: string
  status: DeliveryStatus
  attempts: number
  next_attempt_time: string | null
  last_response_code: number | null
  last_error: string | null
  last_duration_ms: number | null
  success_time: string | null
  created_time: string
}

export type WebhookAttempt = {
  id: string
  attempt: number
  url: string
  request_headers: Record<string, string> | null
  response_code: number | null
  response_headers: Record<string, string> | null
  response_body: string | null
  error: string | null
  duration_ms: number
  created_time: string
}

export type WebhookDeliveryDetail = WebhookDelivery & { payload: string; attempts_log: WebhookAttempt[] }

export type PingResult = {
  delivery_id: string
  status: DeliveryStatus
  response_code: number | null
  error: string | null
  duration_ms: number | null
}

export const webhookKeys = {
  all: ['open-webhook'] as const,
  list: (appId: string) => [...webhookKeys.all, 'list', appId] as const,
  events: () => [...webhookKeys.all, 'events'] as const,
  deliveries: (qs: string) => [...webhookKeys.all, 'deliveries', qs] as const,
  delivery: (id: string) => [...webhookKeys.all, 'delivery', id] as const,
}

export function webhooksQuery(appId: string | null) {
  return queryOptions({
    queryKey: webhookKeys.list(appId ?? ''),
    queryFn: () => api.GET<Webhook[]>(`/api/v1/open-webhooks?app_id=${appId}`),
    enabled: appId !== null,
  })
}

export function webhookEventsQuery() {
  return queryOptions({
    queryKey: webhookKeys.events(),
    queryFn: () => api.GET<WebhookEvent[]>('/api/v1/open-webhooks/events'),
    staleTime: Infinity,
  })
}

export function webhookDeliveriesQuery(qs: string, enabled: boolean) {
  return queryOptions({
    queryKey: webhookKeys.deliveries(qs),
    queryFn: () => api.GET<PageData<WebhookDelivery>>(`/api/v1/open-webhook-deliveries?${qs}`),
    placeholderData: (prev) => prev,
    enabled,
  })
}

export function webhookDeliveryQuery(id: string | null) {
  return queryOptions({
    queryKey: webhookKeys.delivery(id ?? ''),
    queryFn: () => api.GET<WebhookDeliveryDetail>(`/api/v1/open-webhook-deliveries/${id}`),
    enabled: id !== null,
    retry: false,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: webhookKeys.all })
}

export function useCreateWebhook() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: WebhookBody & { app_id: string }) =>
      api.POST<IssuedWebhookSecret>('/api/v1/open-webhooks', { body }),
    onSuccess: invalidate,
  })
}

export function useUpdateWebhook() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: WebhookBody }) => api.PUT(`/api/v1/open-webhooks/${id}`, { body }),
    onSuccess: invalidate,
  })
}

export function useResetWebhookSecret() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.POST<IssuedWebhookSecret>(`/api/v1/open-webhooks/${id}/secret`),
    onSuccess: invalidate,
  })
}

export function useDeleteWebhook() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/open-webhooks/${id}`),
    onSuccess: invalidate,
  })
}

/** 发测试事件：后端**当场**发出去并返回结果（不等 worker） */
export function usePingWebhook() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.POST<PingResult>(`/api/v1/open-webhooks/${id}/ping`),
    onSettled: invalidate,
  })
}

export function useResendDelivery() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.POST(`/api/v1/open-webhook-deliveries/${id}/resend`),
    onSuccess: invalidate,
  })
}

/** 端点修好之后：把某时间之后放弃的投递全部改回待发 */
export function useResendExhausted() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, since }: { id: string; since: string }) =>
      api.POST<{ count: number }>(`/api/v1/open-webhooks/${id}/resend`, { body: { since } }),
    onSuccess: invalidate,
  })
}

/** 订阅是否命中（和后端 `events.matches` 同一个规则）：精确匹配，或末尾 `.*` 的前缀通配 */
export function matches(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))))
}

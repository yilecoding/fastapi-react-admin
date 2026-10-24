import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * 短信配置（`sms_config`，issue #153）。对标 ContiNew Admin 的「短信配置」。
 *
 * - 🔴 **接口永远不下发凭据 secret，连密文都不下发** —— 只有 `secret_mask`。编辑时密钥框是空的，
 *   留空表示不修改（同 AI 供应商 / 存储）
 * - 厂商从 `GET /sms/configs/providers` 来（SDK 注册表），**不是字典**：下游加一家厂商不用改字典数据。
 *   每家带自己的配置字段 JSON Schema（`options_schema`）和模板参数映射形状（`template_mapping`）
 * - 业务模板从 `GET /sms/configs/templates` 来；一条配置可以把多个业务模板各自对到厂商模板
 */
export type TemplateMapping = 'named' | 'ordered'

export type SmsProvider = {
  code: string
  label: string
  template_mapping: TemplateMapping
  template_id_hint: string
  credential: { key_field: string; key_label: string; secret_field: string; secret_label: string } | null
  options_schema: {
    type: 'object'
    properties: Record<string, OptionSchema>
    required: string[]
    $defs?: Record<string, unknown>
  }
}

/** 厂商配置字段的 JSON Schema 子集：只渲染 string / integer / boolean / enum 这几种 */
export type OptionSchema = {
  title?: string
  description?: string
  type?: 'string' | 'integer' | 'number' | 'boolean'
  enum?: (string | number)[]
  default?: unknown
  minLength?: number
}

export type SmsTemplate = {
  code: string
  label: string
  params: string[]
  sensitive: string[]
  cooldown_seconds: number
  daily_max_per_phone: number
}

/** `{ 业务模板码: { template_id, mapping } }`；mapping 按厂商 `template_mapping`：named 是 `{厂商变量名: 业务参数名}`，ordered 是 `[业务参数名]` */
export type TemplateSpec = { template_id: string; mapping: Record<string, string> | string[] }

export type SmsConfig = {
  id: string
  name: string
  provider: string
  sign_name: string
  access_key_id: string | null
  secret_mask: string | null
  options: Record<string, unknown>
  templates: Record<string, TemplateSpec>
  weight: number
  daily_max: number
  timeout: number
  is_default: boolean
  status: number
  remark: string | null
  today_sent: number
  created_time: string
  updated_time: string | null
}

export type SmsConfigBody = {
  name: string
  provider: string
  sign_name: string
  access_key_id?: string | null
  /** 新建带凭据的厂商时必填；编辑时留空 = 不改 */
  access_key_secret?: string
  options: Record<string, unknown>
  templates: Record<string, TemplateSpec>
  weight: number
  daily_max: number
  timeout: number
  is_default: boolean
  status: number
  remark?: string | null
}

export type SendResult = {
  /** accepted / failed / unknown */
  status: 'accepted' | 'failed' | 'unknown'
  error_kind: string | null
  provider_code: string | null
  provider_msg: string | null
  request_id: string | null
  biz_id: string | null
  duration_ms: number
  log_id: string | null
}

export type TestSmsBody = { phone: string; template_id: string; params: Record<string, string> | string[] }

/** 和后端 `SmsErrorKind` 一一对应；两边一起改 */
export const ERROR_KIND_LABELS: Record<string, string> = {
  rate_limited: '发送太频繁',
  invalid_phone: '号码无效',
  bad_params: '模板参数不合规',
  config_error: '配置有误',
  account_error: '账号异常',
  provider_error: '厂商返回错误',
  network_unsent: '连接失败（未发出）',
  unknown: '结果未知',
  circuit_open: '全站熔断',
}

export const smsConfigKeys = {
  all: ['sms-config'] as const,
  list: () => [...smsConfigKeys.all, 'list'] as const,
  providers: () => [...smsConfigKeys.all, 'providers'] as const,
  templates: () => [...smsConfigKeys.all, 'templates'] as const,
}

export function smsConfigsQuery() {
  return queryOptions({
    queryKey: smsConfigKeys.list(),
    queryFn: () => api.GET<PageData<SmsConfig>>('/api/v1/sms/configs?page=1&size=50'),
  })
}

export function smsProvidersQuery() {
  return queryOptions({
    queryKey: smsConfigKeys.providers(),
    queryFn: () => api.GET<SmsProvider[]>('/api/v1/sms/configs/providers'),
    staleTime: 5 * 60_000,
  })
}

export function smsTemplatesQuery() {
  return queryOptions({
    queryKey: smsConfigKeys.templates(),
    queryFn: () => api.GET<SmsTemplate[]>('/api/v1/sms/configs/templates'),
    staleTime: 5 * 60_000,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: smsConfigKeys.list() })
}

export function useCreateSmsConfig() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: SmsConfigBody) => api.POST('/api/v1/sms/configs', { body }),
    onSuccess: invalidate,
    // 表单里已经内联显示了后端的报错，全局 toast 再弹一遍只是噪音
    meta: { suppressErrorToast: true },
  })
}

export function useUpdateSmsConfig() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SmsConfigBody }) => api.PUT(`/api/v1/sms/configs/${id}`, { body }),
    onSuccess: invalidate,
    meta: { suppressErrorToast: true },
  })
}

export function useDeleteSmsConfig() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/sms/configs/${id}`),
    onSuccess: invalidate,
  })
}

export function useSetDefaultSmsConfig() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.PUT(`/api/v1/sms/configs/${id}/default`),
    onSuccess: invalidate,
  })
}

export function useTestSmsConfig() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TestSmsBody }) => api.POST<SendResult>(`/api/v1/sms/configs/${id}/test`, { body }),
    // 「今日已发」跟着涨
    onSuccess: invalidate,
    meta: { suppressErrorToast: true },
  })
}

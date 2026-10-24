import { queryOptions } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * 短信发送日志（`sms_log`，issue #153）。
 *
 * 🔴 **失败也记**（ContiNew 只在成功钩子里写）。两段式：发送前插一行「发送中」，发完更新成终态；
 * 进程在两步之间崩溃那一行就停在「发送中」，后端按 `SMS_SENDING_STALE_SECONDS` 标 `stale`，
 * 这里显示成「结果未知」。
 *
 * 列表接口的 `phone` 是**掩码**（`138****0000`），详情接口才给完整号。
 */
export type SmsLog = {
  id: string
  config_id: string | null
  provider: string
  phone: string
  template: string
  template_id: string | null
  /** 厂商侧参数 JSON 文本，声明为敏感的参数已打码 */
  params: string | null
  /** 见 `LOG_STATUS` */
  status: number
  stale: boolean
  error_kind: string | null
  provider_code: string | null
  provider_msg: string | null
  request_id: string | null
  biz_id: string | null
  duration_ms: number | null
  created_by: string | null
  created_time: string
  updated_time: string | null
}

/** 数值和后端 `plugin/sms/enums.py: SmsLogStatus` 一一对应，改数字要两边一起改 */
export const LOG_STATUS: Record<number, { label: string; tone: 'success' | 'danger' | 'warning' | 'muted' }> = {
  0: { label: '失败', tone: 'danger' },
  // 🔴 叫「已受理」不叫「已送达」：厂商返回 OK 只代表请求成功，用户收没收到看运营商回执
  1: { label: '已受理', tone: 'success' },
  2: { label: '结果未知', tone: 'warning' },
  3: { label: '发送中', tone: 'muted' },
}

/** 这一页列表 query 的 key 前缀。`useQuerySearch` 的 `refreshKey` 也用它 */
export const smsLogKeys = { all: ['sms-log'] as const }

export function smsLogsQuery(qs: string) {
  return queryOptions({
    queryKey: [...smsLogKeys.all, qs],
    queryFn: () => api.GET<PageData<SmsLog>>(`/api/v1/sms/logs?${qs}`),
    placeholderData: (prev: PageData<SmsLog> | undefined) => prev,
  })
}

export function smsLogDetailQuery(id: string | null) {
  return queryOptions({
    queryKey: [...smsLogKeys.all, 'detail', id],
    queryFn: () => api.GET<SmsLog>(`/api/v1/sms/logs/${id}`),
    enabled: id !== null,
  })
}

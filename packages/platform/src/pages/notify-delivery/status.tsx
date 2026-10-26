import { useTranslation } from 'react-i18next'

import { StatusPill, type Tone } from '../_shared/status'
import { ERROR_KIND_LABELS } from '../sms-config/api'
import type { DeliveryStatus } from './api'

/** 写成函数里的字面量 `t('…')`：模块级常量再 `t(变量)` 的话 `i18n:check` 看不见这些 key */
export function statusMeta(t: (k: string) => string, s: DeliveryStatus): { label: string; tone: Tone } {
  switch (s) {
    case 'pending':
      return { label: t('待发'), tone: 'info' }
    case 'sending':
      return { label: t('发送中'), tone: 'info' }
    case 'sent':
      // 叫「已发出」不叫「已送达」：SMTP 收下 / 短信厂商受理不等于对方收到
      return { label: t('已发出'), tone: 'success' }
    case 'failed':
      return { label: t('失败，等重试'), tone: 'warning' }
    case 'exhausted':
      return { label: t('失败'), tone: 'danger' }
    case 'skipped':
      return { label: t('跳过'), tone: 'muted' }
    default:
      return { label: t('结果未知'), tone: 'warning' }
  }
}

/** 后端 `reason` 列的取值（`routing.py` / `senders.py` / `delivery_service.py`），不认识的原样显示 */
export function reasonLabel(t: (k: string) => string, r: string | null): string {
  switch (r) {
    case null:
      return '—'
    case 'no_address':
      return t('没有地址（邮箱 / 手机号）')
    case 'user_disabled':
      return t('账号已停用')
    case 'plugin_missing':
      return t('渠道插件没装')
    case 'stale':
      return t('发送中断（可能已发出）')
    case 'recipient_refused':
      return t('收件人被拒')
    case 'smtp_rejected':
      return t('邮件服务器拒收')
    case 'smtp_busy':
      return t('邮件服务器暂时不可用')
    case 'config_error':
      return t('渠道配置有误')
    case 'network':
      return t('网络不通')
    case 'kind_missing':
    case 'kind_changed':
      return t('通知类型已变更')
    default:
      // 短信渠道的失败分类就是短信插件的 `SmsErrorKind`，沿用短信发送日志那份文案
      return ERROR_KIND_LABELS[r] ? t(ERROR_KIND_LABELS[r]) : r
  }
}

export function DeliveryStatusPill({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation()
  const meta = statusMeta(t, status)
  return <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
}

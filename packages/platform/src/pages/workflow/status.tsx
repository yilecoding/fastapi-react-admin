import { useTranslation } from 'react-i18next'

import { StatusPill, type Tone } from '../_shared/status'
import type { InstanceStatus } from './api'

export const INSTANCE_STATUS: Record<InstanceStatus, { label: string; tone: Tone }> = {
  running: { label: '审批中', tone: 'info' },
  approved: { label: '已通过', tone: 'success' },
  rejected: { label: '已驳回', tone: 'danger' },
  withdrawn: { label: '已撤回', tone: 'muted' },
  terminated: { label: '已终止', tone: 'warning' },
}

export function InstanceStatusPill({ status }: { status: InstanceStatus }) {
  const { t } = useTranslation()
  const meta = INSTANCE_STATUS[status] ?? { label: status, tone: 'muted' as Tone }
  return (
    <StatusPill tone={meta.tone} className="shrink-0 whitespace-nowrap" data-testid="wf-status">
      {t(meta.label)}
    </StatusPill>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [t('审批中'), t('已通过'), t('已驳回'), t('已撤回'), t('已终止')]
}

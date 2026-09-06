import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'
import { Descriptions, DescriptionItem } from '@admin/ui/components/descriptions'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'

import { DetailIdRow, DetailSection } from '../_shared/detail-sheet'
import { StatusPill } from '../_shared/status'
import { formatLocation, type LoginLog } from '../_shared/login-log'

// formatLocation 与 LoginLog 已移到 `_shared/login-log` —— 个人中心的「最近登录」也要用。
// 这里继续 re-export，index.tsx 的 `import { …, formatLocation } from './detail-sheet'` 不用改。
export { formatLocation }

export function LoginLogDetailSheet({
  open, onOpenChange, log,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  log: LoginLog | null
}) {
  const { t } = useTranslation()
  if (!log) {
    return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent /></Sheet>
  }
  const ok = log.status === 1

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <StatusPill tone={ok ? 'success' : 'danger'}>{ok ? t('成功') : t('失败')}</StatusPill>
            {t('{{name}} 的登录记录', { name: log.username })}
          </SheetTitle>
          <SheetDescription>
            {t('用于安全审计：确认是谁、从哪里、用什么设备登录，失败时看清原因。')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
          {!ok && (
            <Alert tone="danger" title={t('登录失败')}>
              <span data-testid="d-msg">{t(log.msg)}</span>
            </Alert>
          )}

          <DetailSection title={t('基本信息')}>
            <div className="mb-3 grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 p-2.5 sm:grid-cols-2">
              <DetailIdRow label={t('日志 ID')} value={log.id} />
              <DetailIdRow label={t('用户 UUID')} value={log.user_uuid} testId="d-uuid" />
            </div>
            <Descriptions columns={2}>
              <DescriptionItem label={t('登录账号')} value={log.username} />
              <DescriptionItem label={t('登录时间')} value={formatDateTime(log.login_time)} mono />
              <DescriptionItem label={t('登录 IP')} value={log.ip} mono copy />
              <DescriptionItem label={t('登录地点')} value={formatLocation(log)} />
              <DescriptionItem label={t('浏览器')} value={log.browser} />
              <DescriptionItem label={t('终端系统')} value={log.os} />
              <DescriptionItem label={t('设备类型')}>
                <Badge variant="outline" className="font-normal">{log.device ?? '—'}</Badge>
              </DescriptionItem>
              <DescriptionItem label={t('结果说明')} value={t(log.msg)} />
            </Descriptions>
          </DetailSection>

          <DetailSection title="User-Agent">
            <div className="relative rounded-md border border-border bg-muted/30 p-3 pe-12">
              <CopyButton text={log.user_agent ?? ''} className="absolute end-2 top-2" />
              <p className="break-all font-mono text-xs leading-relaxed" data-testid="d-ua">
                {log.user_agent || '—'}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('浏览器 / 终端系统 / 设备类型都是从这串原文解析出来的，对不上时以原文为准。')}
            </p>
          </DetailSection>
        </div>

        <SheetFooter>
          <SheetClose render={<Button variant="outline" type="button" />}>{t('关闭')}</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

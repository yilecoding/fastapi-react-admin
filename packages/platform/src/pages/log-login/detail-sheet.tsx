import { IconAlertTriangle } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Separator } from '@admin/ui/components/separator'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { cn } from '@admin/ui/lib/utils'

import { CopyButton } from '../_shared/json-viewer'

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
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 ring-1 ring-destructive/25">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-destructive">{t('登录失败')}</p>
                <p className="text-sm text-destructive/90" data-testid="d-msg">{t(log.msg)}</p>
              </div>
            </div>
          )}

          <Section title={t("基本信息")}>
            <div className="mb-3 grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 p-2.5 sm:grid-cols-2">
              <IdRow label={t("日志 ID")} value={log.id} />
              <IdRow label={t("用户 UUID")} value={log.user_uuid} testId="d-uuid" />
            </div>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              <Row label={t("登录账号")} value={log.username} />
              <Row label={t("登录时间")} value={log.login_time} mono />
              <Row label={t("登录 IP")} value={log.ip} mono copy />
              <Row label={t("登录地点")} value={formatLocation(log)} />
              <Row label={t("浏览器")} value={log.browser ?? '—'} />
              <Row label={t("终端系统")} value={log.os ?? '—'} />
              <Row label={t("设备类型")} node={<Badge variant="outline" className="font-normal">{log.device ?? '—'}</Badge>} />
              <Row label={t("结果说明")} value={t(log.msg)} />
            </dl>
          </Section>

          <Section title="User-Agent">
            <div className="relative rounded-md border border-border bg-muted/30 p-3 pe-12">
              <CopyButton text={log.user_agent ?? ''} className="absolute end-2 top-2" />
              <p className="break-all font-mono text-[11.5px] leading-relaxed" data-testid="d-ua">
                {log.user_agent || '—'}
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('浏览器 / 终端系统 / 设备类型都是从这串原文解析出来的，对不上时以原文为准。')}
            </p>
          </Section>
        </div>

        <SheetFooter>
          <SheetClose render={<Button variant="outline" type="button" />}>{t('关闭')}</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
        <span className="shrink-0">{title}</span>
        <Separator className="ms-1 min-w-0 flex-1" />
      </h3>
      {children}
    </section>
  )
}

function IdRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] tabular-nums" title={value} data-testid={testId}>
        {value}
      </code>
      <CopyButton text={value} label={t('复制{{what}}', { what: label })} />
    </div>
  )
}

function Row({
  label, value, node, mono, copy,
}: {
  label: string
  value?: string | null
  node?: React.ReactNode
  mono?: boolean
  copy?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-16 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">
        {node ?? (
          <span className={cn('min-w-0 text-sm', mono ? 'font-mono text-[12px] break-all tabular-nums' : 'truncate')} title={String(value ?? '')}>
            {value || '—'}
          </span>
        )}
        {copy && value && <CopyButton text={value} label={t('复制{{what}}', { what: label })} />}
      </dd>
    </div>
  )
}

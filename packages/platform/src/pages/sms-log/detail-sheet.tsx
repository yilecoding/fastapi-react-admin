import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { Descriptions, DescriptionItem } from '@admin/ui/components/descriptions'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'

import { ERROR_KIND_LABELS } from '../sms-config/api'
import { DetailIdRow, DetailSection } from '../_shared/detail-sheet'
import { JsonViewer } from '../_shared/json-viewer'
import { StatusPill } from '../_shared/status'
import { LOG_STATUS, smsLogDetailQuery } from './api'

/**
 * 一条发送记录的详情。**完整手机号只在这里**（列表接口是掩码），所以要再打一次详情接口，
 * 不能拿列表那一行直接摊开。
 */
export function SmsLogDetailSheet({ open, onOpenChange, id }: { open: boolean; onOpenChange: (o: boolean) => void; id: string | null }) {
  const { t } = useTranslation()
  const query = useQuery(smsLogDetailQuery(id))
  const log = query.data

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {t('发送记录')}
            {log ? <StatusBadgeFor status={log.status} stale={log.stale} /> : null}
          </SheetTitle>
          <SheetDescription>{t('日志 ID 就是传给厂商的流水号，在厂商控制台按它能对上这一条。')}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
          {query.error ? (
            <QueryError error={query.error} onRetry={() => query.refetch()} />
          ) : !log ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <DetailSection title={t('收件')}>
                <Descriptions>
                  <DescriptionItem label={t('手机号')}>
                    <span className="font-mono">{log.phone}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('业务模板')}>
                    <span className="font-mono">{log.template}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('厂商模板 ID')}>
                    <span className="font-mono">{log.template_id ?? '—'}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('厂商')}>
                    <span className="font-mono">{log.provider}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('创建时间')}>{formatDateTime(log.created_time)}</DescriptionItem>
                  <DescriptionItem label={t('更新时间')}>{formatDateTime(log.updated_time)}</DescriptionItem>
                </Descriptions>
              </DetailSection>

              <DetailSection title={t('参数（敏感项已打码）')}>
                <JsonViewer value={safeJson(log.params)} empty={t('无')} />
              </DetailSection>

              <DetailSection title={t('厂商返回')}>
                <Descriptions>
                  <DescriptionItem label={t('错误类型')}>
                    {log.error_kind ? t(ERROR_KIND_LABELS[log.error_kind] ?? log.error_kind) : '—'}
                  </DescriptionItem>
                  <DescriptionItem label={t('厂商码')}>
                    <span className="font-mono">{log.provider_code ?? '—'}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('厂商原文')}>
                    <span className="break-all font-mono text-xs">{log.provider_msg ?? '—'}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('耗时')}>{log.duration_ms === null ? '—' : `${log.duration_ms}ms`}</DescriptionItem>
                </Descriptions>
                <div className="flex flex-col gap-1">
                  <DetailIdRow label={t('日志 ID')} value={log.id} labelWidth="w-24" />
                  {log.request_id ? <DetailIdRow label="RequestId" value={log.request_id} labelWidth="w-24" /> : null}
                  {log.biz_id ? <DetailIdRow label={t('回执 ID')} value={log.biz_id} labelWidth="w-24" /> : null}
                  {log.config_id ? <DetailIdRow label={t('配置 ID')} value={log.config_id} labelWidth="w-24" /> : null}
                </div>
              </DetailSection>
            </>
          )}
        </div>

        <SheetFooter>
          <SheetClose render={<Button type="button" variant="outline" />}>{t('关闭')}</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** 状态药丸：「发送中」停留太久（`stale`）显示成「结果未知」—— 进程在两步式日志之间崩了 */
export function StatusBadgeFor({ status, stale }: { status: number; stale: boolean }) {
  const { t } = useTranslation()
  const meta = stale && status === 3 ? LOG_STATUS[2]! : (LOG_STATUS[status] ?? LOG_STATUS[0]!)
  return (
    <StatusPill tone={meta.tone} title={stale ? t('「发送中」停留过久，进程可能在写终态之前中断了') : undefined}>
      {t(meta.label)}
    </StatusPill>
  )
}

function safeJson(text: string | null): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

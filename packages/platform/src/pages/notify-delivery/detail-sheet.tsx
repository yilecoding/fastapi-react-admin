import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { Descriptions, DescriptionItem } from '@admin/ui/components/descriptions'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'

import { DetailIdRow, DetailSection } from '../_shared/detail-sheet'
import { channelLabel } from '../notify-policy/labels'
import { deliveryDetailQuery } from './api'
import { DeliveryStatusPill, reasonLabel } from './status'

/** 一条投递的详情。**完整地址只在这里**（列表接口是掩码），所以要再打一次详情接口 */
export function DeliveryDetailSheet({ open, onOpenChange, id }: { open: boolean; onOpenChange: (o: boolean) => void; id: string | null }) {
  const { t } = useTranslation()
  const query = useQuery(deliveryDetailQuery(id))
  const d = query.data

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {t('投递记录')}
            {d ? <DeliveryStatusPill status={d.status} /> : null}
          </SheetTitle>
          <SheetDescription>{t('一条通知走一条外部渠道就是一行。标题和正文是发出那一刻的快照。')}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
          {query.error ? (
            <QueryError error={query.error} onRetry={() => query.refetch()} />
          ) : !d ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <DetailSection title={t('收件')}>
                <Descriptions>
                  <DescriptionItem label={t('渠道')}>{channelLabel(t, d.channel)}</DescriptionItem>
                  <DescriptionItem label={t('地址')}>
                    <span className="break-all font-mono">{d.address ?? '—'}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('通知类型')}>
                    <span className="font-mono">{d.kind}</span>
                  </DescriptionItem>
                  <DescriptionItem label={t('创建时间')}>{formatDateTime(d.created_time)}</DescriptionItem>
                  <DescriptionItem label={t('发出时间')}>{formatDateTime(d.sent_time)}</DescriptionItem>
                </Descriptions>
              </DetailSection>

              <DetailSection title={t('内容')}>
                <p className="text-sm font-medium">{d.title}</p>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{d.content}</p>
              </DetailSection>

              <DetailSection title={t('尝试')}>
                <Descriptions>
                  <DescriptionItem label={t('已尝试')}>{d.attempts}</DescriptionItem>
                  <DescriptionItem label={t('下一次')}>{formatDateTime(d.next_attempt_time)}</DescriptionItem>
                  <DescriptionItem label={t('原因')}>{reasonLabel(t, d.reason)}</DescriptionItem>
                  <DescriptionItem label={t('耗时')}>{d.duration_ms === null ? '—' : `${d.duration_ms}ms`}</DescriptionItem>
                  <DescriptionItem label={t('错误原文')}>
                    <span className="break-all font-mono text-xs">{d.last_error ?? '—'}</span>
                  </DescriptionItem>
                </Descriptions>
                <div className="flex flex-col gap-1">
                  <DetailIdRow label={t('记录 ID')} value={d.id} labelWidth="w-24" />
                  {d.notification_id ? <DetailIdRow label={t('站内通知 ID')} value={d.notification_id} labelWidth="w-24" /> : null}
                  <DetailIdRow label={t('接收人 ID')} value={d.user_id} labelWidth="w-24" />
                  {/* 短信渠道是短信发送日志的 ID，去「短信 → 发送日志」能对上那一条 */}
                  {d.provider_ref ? <DetailIdRow label={t('渠道流水号')} value={d.provider_ref} labelWidth="w-24" /> : null}
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

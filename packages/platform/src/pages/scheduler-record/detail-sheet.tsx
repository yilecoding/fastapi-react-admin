import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { formatDateTime } from '@admin/i18n'
import { Skeleton } from '@admin/ui/components/skeleton'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'

import { StatusPill } from '../_shared/status'
import { RESULT_STATUS_LABEL, RESULT_STATUS_TONE, resultDetailQuery } from './api'

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 border-b py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs break-all' : 'text-sm break-all'}>{value}</span>
    </div>
  )
}

/**
 * 一次执行的详情。
 *
 * 🔴 **异常栈是这一页存在的理由。** `traceback` 是 NVARCHAR(MAX)，动辄几十行，
 * 塞进表格列会把「任务名」挤没；而排查失败任务时，人要看的就是它。
 * 所以列表只放状态，栈放这里，用等宽 + 可横向滚动的 `<pre>` 原样呈现。
 *
 * 详情单独取一次接口而不是复用列表行：列表接口也返回 result/traceback，
 * 但那意味着**每页都把几十条异常栈拉下来**，而绝大多数行是成功的、栈是空的。
 */
export function TaskResultDetailSheet({
  id,
  onClose,
}: {
  id: number | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { data, isPending } = useQuery({ ...resultDetailQuery(id ?? 0), enabled: id !== null })

  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="pe-6" data-testid="result-detail-title">
            {data?.name ?? t('执行详情')}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            {data?.status ? (
              <StatusPill tone={RESULT_STATUS_TONE[data.status] ?? 'muted'}>
                {t(RESULT_STATUS_LABEL[data.status] ?? data.status)}
              </StatusPill>
            ) : null}
            <span className="font-mono text-xs tabular-nums">{formatDateTime(data?.date_done)}</span>
          </SheetDescription>
        </SheetHeader>

        {/* ⚠️ 两个轴都要写：一个轴非 visible 时另一个轴的 visible 会算成 auto，
            只写 overflow-y 会白得一条横向滚动条 */}
        <div className="flex-1 overflow-x-hidden overflow-y-auto px-4 pb-4">
          {isPending ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : data ? (
            <>
              <Row label={t('任务 UUID')} value={data.task_id ?? '—'} mono />
              <Row label={t('执行节点')} value={data.worker ?? '—'} />
              <Row label={t('队列')} value={data.queue ?? '—'} />
              <Row label={t('重试次数')} value={String(data.retries ?? 0)} />
              <Row label={t('返回值')} value={data.result ?? '—'} mono />

              {data.traceback ? (
                <div className="mt-4 flex flex-col gap-2">
                  <span className="text-sm font-medium text-destructive">{t('异常栈')}</span>
                  <pre
                    data-testid="result-traceback"
                    className="max-h-96 overflow-auto rounded-md bg-destructive/5 p-3 font-mono text-xs whitespace-pre ring-1 ring-destructive/20"
                  >
                    {data.traceback}
                  </pre>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('暂无数据')}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

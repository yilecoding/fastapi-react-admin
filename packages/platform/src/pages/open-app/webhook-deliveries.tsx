import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconChevronLeft, IconChevronRight, IconSend } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@admin/ui/components/table'

import { Can } from '../../auth/can'
import { RefreshButton, SelectFilter } from '../_shared/filters'
import { StatusPill, type Tone } from '../_shared/status'
import {
  useResendDelivery,
  webhookDeliveriesQuery,
  webhookDeliveryQuery,
  type DeliveryStatus,
  type Webhook,
} from './webhook-api'

const PAGE_SIZE = 20

/** 写成函数里的字面量 `t('…')`：模块级常量再 `t(变量)` 的话 `i18n:check` 看不见这些 key */
export function deliveryStatusMeta(t: (k: string) => string, s: DeliveryStatus): { label: string; tone: Tone } {
  switch (s) {
    case 'pending':
      return { label: t('待发'), tone: 'info' }
    case 'sending':
      return { label: t('发送中'), tone: 'info' }
    case 'success':
      return { label: t('成功'), tone: 'success' }
    case 'failed':
      return { label: t('失败，等重试'), tone: 'warning' }
    default:
      return { label: t('已放弃'), tone: 'danger' }
  }
}

export function DeliveryStatusPill({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation()
  const meta = deliveryStatusMeta(t, status)
  return <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
}

const STATUS_ITEMS: Record<string, string> = {
  all: '全部状态',
  pending: '待发',
  success: '成功',
  failed: '失败，等重试',
  exhausted: '已放弃',
}

export type DeliveryView = { status?: string; hook?: string; page?: number; open?: string }

export function WebhookDeliveries({
  appId,
  hooks,
  view,
  onViewChange,
  active,
}: {
  appId: string
  hooks: Webhook[]
  view: DeliveryView
  onViewChange: (v: DeliveryView) => void
  /** 页签没打开时不取数 */
  active: boolean
}) {
  const { t } = useTranslation()
  const page = view.page ?? 1
  const qs = new URLSearchParams({ app_id: appId, page: String(page), size: String(PAGE_SIZE) })
  if (view.status) qs.set('status', view.status)
  if (view.hook) qs.set('webhook_id', view.hook)
  const query = useQuery(webhookDeliveriesQuery(qs.toString(), active))
  const rows = query.data?.items ?? []
  const hookItems = React.useMemo(
    () => ({ all: '全部端点', ...Object.fromEntries(hooks.map((h) => [h.id, h.name])) }),
    [hooks]
  )

  return (
    <div className="flex flex-col gap-3" data-testid="webhook-deliveries">
      <div className="flex flex-wrap items-center gap-2">
        <SelectFilter
          value={view.hook ?? 'all'}
          items={hookItems}
          onChange={(v) => onViewChange({ ...view, hook: v === 'all' ? undefined : v, page: undefined })}
          testId="webhook-delivery-hook"
        />
        <SelectFilter
          value={view.status ?? 'all'}
          items={STATUS_ITEMS}
          onChange={(v) => onViewChange({ ...view, status: v === 'all' ? undefined : v, page: undefined })}
          testId="webhook-delivery-status"
        />
        <div className="ml-auto">
          <RefreshButton busy={query.isFetching} onClick={() => void query.refetch()} />
        </div>
      </div>

      {query.error && !query.data ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <Skeleton className="h-48" />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {view.status || view.hook ? t('没有匹配的投递') : t('还没有投递。订阅的事件发生后，每个端点一行')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('时间')}</TableHead>
                <TableHead>{t('事件')}</TableHead>
                <TableHead>{t('端点')}</TableHead>
                <TableHead>{t('状态')}</TableHead>
                <TableHead className="text-right">{t('尝试')}</TableHead>
                <TableHead>{t('最近一次')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => onViewChange({ ...view, open: r.id })}
                  data-testid={`webhook-delivery-${r.event_type}`}
                >
                  <TableCell className="font-mono text-xs tabular-nums">{formatDateTime(r.created_time)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.event_type}</TableCell>
                  <TableCell className="text-sm">{r.webhook_name}</TableCell>
                  <TableCell>
                    <DeliveryStatusPill status={r.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.attempts}</TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={r.last_error ?? ''}>
                    {r.last_response_code ?? '—'}
                    {r.last_error ? ` · ${r.last_error}` : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(query.data?.total_pages ?? 1) > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span>{t('第 {{page}} / {{total}} 页', { page, total: query.data?.total_pages })}</span>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            disabled={page <= 1}
            onClick={() => onViewChange({ ...view, page: page - 1 === 1 ? undefined : page - 1 })}
            aria-label={t('上一页')}
          >
            <IconChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            disabled={page >= (query.data?.total_pages ?? 1)}
            onClick={() => onViewChange({ ...view, page: page + 1 })}
            aria-label={t('下一页')}
          >
            <IconChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}

      <DeliveryDetailDialog id={view.open ?? null} onClose={() => onViewChange({ ...view, open: undefined })} />
    </div>
  )
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** 一条投递：发了什么（payload 原文）、每一次尝试对方回了什么 —— 对接排查看的就是这个 */
function DeliveryDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const query = useQuery(webhookDeliveryQuery(id))
  const resend = useResendDelivery()
  const [error, setError] = React.useState<string | null>(null)
  const d = query.data
  const canResend = d?.status === 'failed' || d?.status === 'exhausted'

  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="webhook-delivery-detail">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('投递详情')}
            {d ? <DeliveryStatusPill status={d.status} /> : null}
          </DialogTitle>
          <DialogDescription>
            {t('同一个事件重试时 webhook-id 不变，接收方按它去重；时间戳和签名每次重新生成。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[65svh] flex-col gap-4 overflow-y-auto pr-1 text-sm">
          {query.error ? (
            <QueryError error={query.error} onRetry={() => void query.refetch()} />
          ) : !d ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <div className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
                <span className="text-muted-foreground">{t('事件')}</span>
                <code className="font-mono text-xs">{d.event_type}</code>
                <span className="text-muted-foreground">webhook-id</span>
                <span className="flex items-center gap-1">
                  <code className="font-mono text-xs">{d.event_id}</code>
                  <CopyButton text={d.event_id} label={t('复制')} className="size-6" />
                </span>
                <span className="text-muted-foreground">{t('端点')}</span>
                <span>{d.webhook_name}</span>
                <span className="text-muted-foreground">{t('下一次')}</span>
                <span className="font-mono text-xs">{formatDateTime(d.next_attempt_time)}</span>
              </div>

              <section className="flex flex-col gap-1.5">
                <h4 className="text-xs font-medium text-muted-foreground">{t('请求体')}</h4>
                <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2.5 font-mono text-xs" data-testid="webhook-payload">
                  {pretty(d.payload)}
                </pre>
              </section>

              <section className="flex flex-col gap-2">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {t('每一次尝试（{{n}}）', { n: d.attempts_log.length })}
                </h4>
                {d.attempts_log.length === 0 ? (
                  <p className="text-muted-foreground">{t('还没发过')}</p>
                ) : (
                  d.attempts_log.map((a) => (
                    <details key={a.id} className="rounded-md border px-3 py-2" data-testid={`webhook-attempt-${a.attempt}`}>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="font-medium">#{a.attempt}</span>
                        <span className="font-mono tabular-nums">{formatDateTime(a.created_time)}</span>
                        <span className={a.response_code && a.response_code < 300 ? 'text-emerald-600' : 'text-destructive'}>
                          {a.response_code ?? t('无响应')}
                        </span>
                        <span className="text-muted-foreground">{a.duration_ms}ms</span>
                        {a.error ? <span className="min-w-0 truncate text-destructive">{a.error}</span> : null}
                      </summary>
                      <div className="mt-2 flex flex-col gap-2">
                        <p className="break-all font-mono text-xs text-muted-foreground">POST {a.url}</p>
                        <Headers title={t('请求头')} value={a.request_headers} />
                        <Headers title={t('响应头')} value={a.response_headers} />
                        {a.response_body ? (
                          <pre className="max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs">{a.response_body}</pre>
                        ) : null}
                      </div>
                    </details>
                  ))
                )}
              </section>
              {error ? <Alert tone="danger">{error}</Alert> : null}
            </>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{t('关闭')}</DialogClose>
          {canResend ? (
            <Can perm="open:webhook:resend">
              <Button
                disabled={resend.isPending}
                onClick={async () => {
                  setError(null)
                  try {
                    await resend.mutateAsync(d.id)
                  } catch (e) {
                    setError(e instanceof Error ? e.message : t('重发失败'))
                  }
                }}
                data-testid="webhook-delivery-resend"
              >
                <IconSend className="size-4" />
                {t('重发')}
              </Button>
            </Can>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Headers({ title, value }: { title: string; value: Record<string, string> | null }) {
  if (!value || Object.keys(value).length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{title}</span>
      <div className="rounded bg-muted/50 p-2 font-mono text-xs">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="break-all">
            <span className="text-muted-foreground">{k}:</span> {v}
          </div>
        ))}
      </div>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconDotsVertical,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRotateClockwise,
  IconTrash,
} from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { StatusPill } from '../_shared/status'
import { openAppQuery } from './api'
import {
  useDeleteWebhook,
  usePingWebhook,
  useResendExhausted,
  useResetWebhookSecret,
  webhooksQuery,
  type PingResult,
  type Webhook,
} from './webhook-api'
import { DeliveryStatusPill, WebhookDeliveries, type DeliveryView } from './webhook-deliveries'
import { WebhookEvents } from './webhook-events'
import { WebhookFormDialog } from './webhook-form'
import { WebhookSecretDialog } from './webhook-secret-dialog'

export type WebhookTab = 'endpoints' | 'deliveries' | 'events'

/** 抽屉里的视图状态，全部进 URL（硬纪律 2）：打开的是哪个应用、哪个页签、投递记录的筛选和翻页、打开了哪一条 */
export type WebhookView = { tab?: WebhookTab; deliveries?: DeliveryView }

/** 批量重发的时间窗：端点修好之后，把这段时间里放弃的投递改回待发 */
const RESEND_WINDOWS = [
  { hours: 1, label: '最近 1 小时' },
  { hours: 24, label: '最近 24 小时' },
  { hours: 24 * 7, label: '最近 7 天' },
] as const

export function WebhookSheet({
  appId,
  view,
  onViewChange,
  onClose,
}: {
  appId: string | null
  view: WebhookView
  onViewChange: (v: WebhookView) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const appQuery = useQuery(openAppQuery(appId))
  const hooksQuery = useQuery(webhooksQuery(appId))
  const app = appQuery.data
  const hooks = hooksQuery.data ?? []
  const tab = view.tab ?? 'endpoints'

  const ping = usePingWebhook()
  const reset = useResetWebhookSecret()
  const del = useDeleteWebhook()
  const resendExhausted = useResendExhausted()
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Webhook | null>(null)
  const [secret, setSecret] = React.useState<{ value: string; rotated: boolean } | null>(null)
  const [pendingReset, setPendingReset] = React.useState<Webhook | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Webhook | null>(null)
  const [pingResult, setPingResult] = React.useState<{ hookId: string; result: PingResult } | null>(null)
  const [notice, setNotice] = React.useState<{ tone: 'danger' | 'success'; text: string } | null>(null)

  async function run(action: () => Promise<void>, failText: string) {
    setNotice(null)
    try {
      await action()
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : failText })
    }
  }

  function openForm(target: Webhook | null) {
    setEditing(target)
    setFormOpen(true)
  }

  return (
    <Sheet open={appId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-3xl" data-testid="webhook-sheet">
        <SheetHeader>
          <SheetTitle>{app ? t('Webhook · {{name}}', { name: app.name }) : 'Webhook'}</SheetTitle>
          <SheetDescription>
            {t('对方登记一个地址、选好想听的事件，这边一发生就带签名推过去。收不到 2xx 按退避重试，每一次尝试都有记录。')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col overflow-y-auto px-4 pb-4">
          {appQuery.error ? (
            <QueryError error={appQuery.error} onRetry={() => void appQuery.refetch()} />
          ) : !app ? (
            <Skeleton className="h-40" />
          ) : (
            <Tabs value={tab} onValueChange={(v) => onViewChange({ ...view, tab: v as WebhookTab })}>
              <TabsList>
                <TabsTrigger value="endpoints" data-testid="webhook-tab-endpoints">
                  {t('端点')}
                </TabsTrigger>
                <TabsTrigger value="deliveries" data-testid="webhook-tab-deliveries">
                  {t('投递记录')}
                </TabsTrigger>
                <TabsTrigger value="events" data-testid="webhook-tab-events">
                  {t('事件目录')}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="endpoints" keepMounted className="flex flex-col gap-3 pt-3">
                <div className="flex items-center gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t('只能订阅应用已授权接口对应的事件（订阅用户事件要先授权「读取用户」）。')}
                  </p>
                  <Can perm="open:webhook:add">
                    <Button size="sm" className="ml-auto shrink-0" onClick={() => openForm(null)} data-testid="webhook-add">
                      <IconPlus className="size-4" />
                      {t('新增端点')}
                    </Button>
                  </Can>
                </div>

                {notice ? (
                  <Alert tone={notice.tone} data-testid="webhook-notice">
                    {notice.text}
                  </Alert>
                ) : null}

                {hooksQuery.error ? (
                  <QueryError error={hooksQuery.error} onRetry={() => void hooksQuery.refetch()} />
                ) : hooksQuery.isPending ? (
                  <Skeleton className="h-32" />
                ) : hooks.length === 0 ? (
                  <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                    {t('还没有端点。点「新增端点」登记对方的接收地址')}
                  </p>
                ) : (
                  hooks.map((h) => (
                    <EndpointCard
                      key={h.id}
                      hook={h}
                      ping={pingResult?.hookId === h.id ? pingResult.result : null}
                      pinging={ping.isPending && ping.variables === h.id}
                      onPing={() =>
                        run(async () => {
                          setPingResult(null)
                          setPingResult({ hookId: h.id, result: await ping.mutateAsync(h.id) })
                        }, t('发送失败'))
                      }
                      onEdit={() => openForm(h)}
                      onReset={() => setPendingReset(h)}
                      onDelete={() => setPendingDelete(h)}
                      onResend={(hours) =>
                        run(async () => {
                          const since = new Date(Date.now() - hours * 3600_000).toISOString()
                          const { count } = await resendExhausted.mutateAsync({ id: h.id, since })
                          setNotice({ tone: 'success', text: t('已把 {{n}} 条放弃的投递改回待发', { n: count }) })
                        }, t('重发失败'))
                      }
                      onShowDeliveries={() =>
                        onViewChange({ ...view, tab: 'deliveries', deliveries: { hook: h.id } })
                      }
                    />
                  ))
                )}
              </TabsContent>

              <TabsContent value="deliveries" keepMounted className="pt-3">
                <WebhookDeliveries
                  appId={app.id}
                  hooks={hooks}
                  view={view.deliveries ?? {}}
                  onViewChange={(d) => onViewChange({ ...view, deliveries: d })}
                  active={tab === 'deliveries'}
                />
              </TabsContent>

              <TabsContent value="events" keepMounted className="pt-3">
                <WebhookEvents active={tab === 'events'} />
              </TabsContent>
            </Tabs>
          )}
        </div>

        {app ? (
          <WebhookFormDialog
            open={formOpen}
            onOpenChange={setFormOpen}
            app={app}
            editing={editing}
            onIssued={(value) => setSecret({ value, rotated: false })}
          />
        ) : null}
        <WebhookSecretDialog
          secret={secret?.value ?? null}
          rotated={secret?.rotated ?? false}
          onClose={() => setSecret(null)}
        />
        <ConfirmDialog
          open={pendingReset !== null}
          onOpenChange={(o) => !o && setPendingReset(null)}
          title={t('重置签名密钥')}
          description={t('生成一把新密钥。旧的那把还会一起签名 24 小时，对方在这一天里换成新的就不会丢事件。')}
          confirmText={t('确定重置')}
          pending={reset.isPending}
          onConfirm={async () => {
            const target = pendingReset
            setPendingReset(null)
            if (target)
              await run(async () => {
                setSecret({ value: (await reset.mutateAsync(target.id)).secret_key, rotated: true })
              }, t('重置失败'))
          }}
        />
        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={(o) => !o && setPendingDelete(null)}
          title={t('删除端点')}
          description={t('确定删除「{{name}}」？它的投递记录会一起删掉，还在排队的事件不会再发。', {
            name: pendingDelete?.name ?? '',
          })}
          destructive
          pending={del.isPending}
          onConfirm={async () => {
            const target = pendingDelete
            setPendingDelete(null)
            if (target) await run(() => del.mutateAsync(target.id).then(() => undefined), t('删除失败'))
          }}
        />
      </SheetContent>
    </Sheet>
  )
}

function disabledText(t: (k: string, o?: Record<string, unknown>) => string, h: Webhook): string {
  switch (h.disabled_reason) {
    case 'auto':
      return t('连续失败 {{n}} 次、超过 24 小时，已自动停用', { n: h.consecutive_failures })
    case 'gone':
      return t('对方回了 410 Gone，已停用')
    default:
      return t('已停用')
  }
}

function EndpointCard({
  hook: h,
  ping,
  pinging,
  onPing,
  onEdit,
  onReset,
  onDelete,
  onResend,
  onShowDeliveries,
}: {
  hook: Webhook
  ping: PingResult | null
  pinging: boolean
  onPing: () => void
  onEdit: () => void
  onReset: () => void
  onDelete: () => void
  onResend: (hours: number) => void
  onShowDeliveries: () => void
}) {
  const { t } = useTranslation()
  const rotating = h.secret_prev_expire_time !== null && new Date(h.secret_prev_expire_time).getTime() > Date.now()
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3" data-testid={`webhook-card-${h.name}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{h.name}</span>
            {h.status === 1 ? (
              <StatusPill tone="success">{t('正常')}</StatusPill>
            ) : (
              <StatusPill tone={h.disabled_reason === 'manual' ? 'muted' : 'danger'}>{disabledText(t, h)}</StatusPill>
            )}
          </div>
          <code className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">{h.url}</code>
        </div>
        <Can perm="open:webhook:test">
          <Button size="sm" variant="outline" onClick={onPing} aria-busy={pinging} data-testid={`webhook-ping-${h.name}`}>
            {pinging ? <IconRefresh className="size-4 animate-spin" /> : <IconPlayerPlay className="size-4" />}
            {t('发测试')}
          </Button>
        </Can>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="size-8" aria-label={t('操作 {{name}}', { name: h.name })} />}
            data-testid={`webhook-actions-${h.name}`}
          >
            <IconDotsVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <Can perm="open:webhook:edit">
              <DropdownMenuItem onClick={onEdit} data-testid={`webhook-edit-${h.name}`}>
                <IconPencil className="size-4" />
                {t('编辑')}
              </DropdownMenuItem>
            </Can>
            <Can perm="open:webhook:reset">
              <DropdownMenuItem onClick={onReset} data-testid={`webhook-reset-${h.name}`}>
                <IconRefresh className="size-4" />
                {t('重置签名密钥')}
              </DropdownMenuItem>
            </Can>
            <Can perm="open:webhook:resend">
              <DropdownMenuSeparator />
              {RESEND_WINDOWS.map((w) => (
                <DropdownMenuItem key={w.hours} onClick={() => onResend(w.hours)}>
                  <IconRotateClockwise className="size-4" />
                  {t('重发{{window}}放弃的', { window: t(w.label) })}
                </DropdownMenuItem>
              ))}
            </Can>
            <Can perm="open:webhook:del">
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete} data-testid={`webhook-delete-${h.name}`}>
                <IconTrash className="size-4" />
                {t('删除')}
              </DropdownMenuItem>
            </Can>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap gap-1">
        {h.events.map((e) => (
          <Badge key={e} variant="outline" className="font-mono font-normal">
            {e}
          </Badge>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t('密钥')} <code className="font-mono">{h.secret_hint}</code>
          {rotating ? ` · ${t('旧密钥一起签到 {{time}}', { time: formatDateTime(h.secret_prev_expire_time) })}` : ''}
        </span>
        <span>
          {t('最近成功')} {formatDateTime(h.last_success_time)}
        </span>
        {h.consecutive_failures > 0 ? (
          <span className="text-destructive" data-testid={`webhook-failures-${h.name}`}>
            {t('连续失败 {{n}} 次（从 {{time}} 起）', {
              n: h.consecutive_failures,
              time: formatDateTime(h.first_failure_time),
            })}
          </span>
        ) : null}
        <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={onShowDeliveries}>
          {t('看投递记录')}
        </button>
      </div>

      {ping ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs"
          data-testid={`webhook-ping-result-${h.name}`}
        >
          <span>{t('测试事件')}</span>
          <DeliveryStatusPill status={ping.status} />
          <span className="font-mono">{ping.response_code ?? t('无响应')}</span>
          {ping.duration_ms !== null ? <span className="text-muted-foreground">{ping.duration_ms}ms</span> : null}
          {ping.error ? <span className="min-w-0 break-all text-destructive">{ping.error}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

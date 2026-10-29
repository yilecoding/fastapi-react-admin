import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@admin/ui/components/dialog'
import { Input } from '@admin/ui/components/input'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import type { OpenApp } from './api'
import {
  matches,
  useCreateWebhook,
  useUpdateWebhook,
  webhookEventsQuery,
  type Webhook,
  type WebhookBody,
  type WebhookEvent,
} from './webhook-api'

const schema = z.object({
  name: z.string().min(1, '请输入端点名称').max(64, '名称不能超过 64 个字符'),
  url: z
    .string()
    .min(1, '请输入接收地址')
    .max(512, '地址不能超过 512 个字符')
    .regex(/^https?:\/\/\S+$/, '要以 https:// 开头'),
  events: z.array(z.string()).min(1, '至少订阅一个事件'),
  status: z.boolean(),
  remark: z.string().max(500, '备注不能超过 500 个字符').optional(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = { name: '', url: 'https://', events: [], status: true, remark: '' }

/** `user.created` → `user`；`workflow.instance.approved` → `workflow.instance`。通配就是「分组 + .*」 */
function groupOf(type: string): string {
  return type.slice(0, type.lastIndexOf('.'))
}

export function WebhookFormDialog({
  open,
  onOpenChange,
  app,
  editing,
  onIssued,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  app: OpenApp
  editing: Webhook | null
  onIssued: (secret: string) => void
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateWebhook()
  const update = useUpdateWebhook()
  const eventsQuery = useQuery({ ...webhookEventsQuery(), enabled: open })
  const [serverError, setServerError] = React.useState<string | null>(null)
  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            url: editing.url,
            events: editing.events,
            status: editing.status === 1,
            remark: editing.remark ?? '',
          }
        : EMPTY
    )
  }, [open, editing, form])

  const picked = form.watch('events')
  const groups = React.useMemo(() => {
    const out = new Map<string, WebhookEvent[]>()
    for (const e of eventsQuery.data ?? []) out.set(groupOf(e.type), [...(out.get(groupOf(e.type)) ?? []), e])
    return [...out.entries()]
  }, [eventsQuery.data])

  function setEvents(next: string[]) {
    form.setValue('events', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })
  }

  function toggleGroup(group: string, items: WebhookEvent[], on: boolean) {
    // 选通配就把这一组的单项都去掉（存成 `user.*`，以后新加的 user 事件也收得到）
    const rest = picked.filter((p) => p !== `${group}.*` && !items.some((e) => e.type === p))
    setEvents(on ? [...rest, `${group}.*`] : rest)
  }

  function toggleOne(type: string, on: boolean) {
    setEvents(on ? [...new Set([...picked, type])] : picked.filter((p) => p !== type))
  }

  async function onSubmit(v: Values) {
    setServerError(null)
    const body: WebhookBody = {
      name: v.name.trim(),
      url: v.url.trim(),
      events: v.events,
      status: v.status ? 1 : 0,
      remark: v.remark?.trim() || null,
    }
    try {
      if (isEdit && editing) {
        await update.mutateAsync({ id: editing.id, body })
      } else {
        onIssued((await create.mutateAsync({ ...body, app_id: app.id })).secret_key)
      }
      onOpenChange(false)
    } catch (e) {
      // 后端的三道检查（事件不存在 / scope 没授权 / 地址不可用）都在这里原样显示
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const errs = form.formState.errors
  const pending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="webhook-form">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('编辑端点') : t('新增端点')}</DialogTitle>
          <DialogDescription>
            {t('事件发生后，这边带签名把一个 JSON POST 到这个地址；收不到 2xx 会按退避重试（约 7 小时内 5 次）。')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex max-h-[70svh] flex-col gap-4 overflow-y-auto pr-1">
          <FormField label={t('端点名称')} error={fe(errs.name?.message)} required>
            <Input {...form.register('name')} autoComplete="off" maxLength={64} data-testid="webhook-name" />
          </FormField>

          <FormField
            label={t('接收地址')}
            error={fe(errs.url?.message)}
            required
            hint={t('只收 https。保存和每次投递前都会解析一遍域名：指向内网 / 本机的地址会被拒绝；不跟随重定向')}
          >
            <Input {...form.register('url')} autoComplete="off" className="font-mono text-xs" data-testid="webhook-url" />
          </FormField>

          <FormField
            label={t('订阅的事件')}
            error={fe(errs.events?.message)}
            required
            hint={t('灰掉的要先给应用授权对应的接口。勾「全部」存成通配，以后新加的同类事件也会收到')}
          >
            {eventsQuery.error ? (
              <QueryError error={eventsQuery.error} onRetry={() => eventsQuery.refetch()} />
            ) : eventsQuery.isPending ? (
              <Skeleton className="h-32" />
            ) : (
              <div className="overflow-hidden rounded-md border" data-testid="webhook-events">
                {groups.map(([group, items]) => {
                  const granted = items.every((e) => app.scopes.includes(e.scope))
                  const all = picked.includes(`${group}.*`)
                  return (
                    <div key={group} className="border-b last:border-b-0">
                      <label
                        className={cn(
                          'flex items-center gap-2.5 bg-muted/40 px-3 py-2',
                          granted ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                        )}
                      >
                        <Checkbox
                          checked={all}
                          disabled={!granted}
                          onCheckedChange={(c) => toggleGroup(group, items, c === true)}
                          data-testid={`webhook-event-${group}.*`}
                        />
                        <span className="text-sm font-medium">{t('全部')}</span>
                        <code className="font-mono text-xs text-muted-foreground">{group}.*</code>
                        {!granted ? (
                          <span className="ml-auto text-xs text-muted-foreground">
                            {t('应用没授权 {{scope}}', { scope: items[0]?.scope })}
                          </span>
                        ) : null}
                      </label>
                      {items.map((e) => {
                        const on = all || picked.includes(e.type)
                        return (
                          <label
                            key={e.type}
                            className={cn(
                              'flex items-center gap-2.5 px-3 py-1.5 pl-8',
                              granted && !all ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                              on && 'bg-primary/5'
                            )}
                          >
                            <Checkbox
                              checked={on}
                              disabled={!granted || all}
                              onCheckedChange={(c) => toggleOne(e.type, c === true)}
                              data-testid={`webhook-event-${e.type}`}
                            />
                            <span className="text-sm">{t(e.label)}</span>
                            <code className="font-mono text-xs text-muted-foreground">{e.type}</code>
                          </label>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )}
            {/* 编辑时库里存的订阅可能已经一个都匹配不上（事件被改名 / 插件卸载），要让人看见 */}
            {picked.filter((p) => !(eventsQuery.data ?? []).some((e) => matches([p], e.type))).length > 0 &&
            eventsQuery.data ? (
              <p className="text-xs text-destructive">
                {t('这些订阅已经匹配不到任何事件：{{list}}', {
                  list: picked.filter((p) => !eventsQuery.data.some((e) => matches([p], e.type))).join('、'),
                })}
              </p>
            ) : null}
          </FormField>

          <FormField label={t('启用')} hint={t('停用期间产生的事件不会再推给它；重新启用会清零连续失败次数')}>
            <Switch
              checked={form.watch('status')}
              onCheckedChange={(c) => form.setValue('status', c, { shouldDirty: true })}
              data-testid="webhook-status"
            />
          </FormField>

          <FormField label={t('备注')} error={fe(errs.remark?.message)}>
            <Textarea {...form.register('remark')} rows={2} placeholder={t('如：对接人、用途')} />
          </FormField>

          {serverError ? (
            <p className="text-sm text-destructive" data-testid="webhook-form-error">
              {serverError}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{t('取消')}</DialogClose>
            <Button type="submit" disabled={pending} data-testid="webhook-submit">
              {isEdit ? t('保存') : t('创建并生成密钥')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

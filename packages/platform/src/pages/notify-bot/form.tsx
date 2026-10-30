import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { Input } from '@admin/ui/components/input'
import { QueryError } from '@admin/ui/components/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@admin/ui/components/select'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import { botOptionsQuery, PLATFORMS, SIGNING, useCreateBot, useUpdateBot, type Bot, type BotBody, type BotPlatform } from './api'
import { platformHint, platformLabel } from './labels'

const schema = z.object({
  name: z.string().trim().min(1, '请输入名称').max(64, '名称不能超过 64 个字符'),
  platform: z.enum(['feishu', 'dingtalk', 'wecom']),
  webhook_url: z.string().trim().max(1024),
  sign_secret: z.string().trim().max(256),
  clear_sign_secret: z.boolean(),
  kinds: z.array(z.string()).min(1, '至少订阅一类通知'),
  status: z.boolean(),
  remark: z.string().max(256),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = {
  name: '',
  platform: 'feishu',
  webhook_url: '',
  sign_secret: '',
  clear_sign_secret: false,
  kinds: [],
  status: true,
  remark: '',
}

/**
 * 新增 / 编辑群机器人。
 *
 * - 🔴 编辑时地址和密钥框**永远是空的**：接口不下发明文（地址本身就是凭据）。留空 = 不改；
 *   要去掉加签得勾「去掉加签」—— 不然「留空」和「删掉」分不开
 * - 换了平台必须填新地址：旧地址是上一家的（后端也拦）
 */
export function BotFormSheet({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (o: boolean) => void; editing: Bot | null }) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const optionsQuery = useQuery(botOptionsQuery())
  const create = useCreateBot()
  const update = useUpdateBot()
  const [serverError, setServerError] = React.useState<string | null>(null)
  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            platform: editing.platform,
            webhook_url: '',
            sign_secret: '',
            clear_sign_secret: false,
            kinds: editing.kinds,
            status: editing.status === 1,
            remark: editing.remark ?? '',
          }
        : EMPTY,
    )
  }, [open, editing, form])

  const platform = form.watch('platform')
  const kinds = form.watch('kinds')
  const clearSecret = form.watch('clear_sign_secret')
  const errs = form.formState.errors
  const pending = create.isPending || update.isPending
  const signing = SIGNING.has(platform)
  const platformChanged = isEdit && editing.platform !== platform

  async function onSubmit(v: Values) {
    setServerError(null)
    if ((!isEdit || platformChanged) && !v.webhook_url) {
      form.setError('webhook_url', { message: platformChanged ? '换了平台就要填新平台的地址' : '请粘贴 Webhook 地址' })
      return
    }
    const body: BotBody = {
      name: v.name,
      platform: v.platform,
      kinds: v.kinds,
      status: v.status ? 1 : 0,
      remark: v.remark.trim() || null,
      // 留空 = 不改，传 undefined 而不是空串（同短信配置）
      webhook_url: v.webhook_url || undefined,
      sign_secret: signing && !v.clear_sign_secret ? v.sign_secret || undefined : undefined,
      clear_sign_secret: isEdit && signing ? v.clear_sign_secret : undefined,
    }
    try {
      if (isEdit) await update.mutateAsync({ id: editing.id, body })
      else await create.mutateAsync(body)
      onOpenChange(false)
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const platformItems = React.useMemo(() => Object.fromEntries(PLATFORMS.map((p) => [p, platformLabel(t, p)])), [t])
  const toggleKind = (kind: string, on: boolean) =>
    form.setValue('kinds', on ? [...kinds, kind] : kinds.filter((k) => k !== kind), { shouldDirty: true, shouldValidate: true })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑群机器人') : t('新增群机器人')}</SheetTitle>
          <SheetDescription>
            {t('订阅的通知一产生就往群里推一条，和收件人有几个无关。Webhook 地址本身就是凭据，加密保存，之后只显示掩码。')}
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            {optionsQuery.data && !optionsQuery.data.encrypt_key_ready ? (
              <Alert tone="warning">{t('服务器没有配置 NOTIFICATION_ENCRYPT_SECRET_KEY，群机器人存不进去。请联系管理员。')}</Alert>
            ) : null}
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('名称')} error={fe(errs.name?.message)} required hint={t('投递记录里显示的就是它，写成群名最好认')}>
                <Input {...form.register('name')} autoComplete="off" maxLength={64} data-testid="bot-name" />
              </FormField>
              <FormField label={t('平台')} required>
                <Select
                  value={platform}
                  items={platformItems}
                  onValueChange={(v) => form.setValue('platform', v as BotPlatform, { shouldDirty: true })}
                >
                  <SelectTrigger data-testid="bot-platform">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p} data-testid={`bot-platform-${p}`}>
                        {platformLabel(t, p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField
              label={t('Webhook 地址')}
              error={fe(errs.webhook_url?.message)}
              required={!isEdit || platformChanged}
              hint={isEdit && !platformChanged ? `${t('留空表示不修改')} · ${t('现在是')} ${editing.webhook_hint}` : platformHint(t, platform)}
            >
              <Input {...form.register('webhook_url')} type="password" autoComplete="off" spellCheck={false} data-testid="bot-webhook" />
            </FormField>
            {signing ? (
              <FormField
                label={t('加签密钥')}
                error={fe(errs.sign_secret?.message)}
                hint={
                  isEdit && editing.has_secret
                    ? t('已配置。留空表示不修改')
                    : t('机器人开了「签名校验 / 加签」才填；没开就留空')
                }
              >
                <Input
                  {...form.register('sign_secret')}
                  type="password"
                  autoComplete="new-password"
                  disabled={clearSecret}
                  data-testid="bot-secret"
                />
              </FormField>
            ) : null}
            {signing && isEdit && editing.has_secret ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={clearSecret} onCheckedChange={(c) => form.setValue('clear_sign_secret', c === true, { shouldDirty: true })} />
                {t('去掉加签（机器人那边关掉了签名校验）')}
              </label>
            ) : null}

            <FormField label={t('订阅的通知')} error={fe(errs.kinds?.message)} required>
              {optionsQuery.error ? <QueryError error={optionsQuery.error} onRetry={() => optionsQuery.refetch()} /> : null}
              <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="bot-kinds">
                {(optionsQuery.data?.kinds ?? []).map((k) => (
                  <label key={k.kind} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={kinds.includes(k.kind)}
                      onCheckedChange={(c) => toggleKind(k.kind, c === true)}
                      data-testid={`bot-kind-${k.kind}`}
                    />
                    <span>{t(k.label)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{k.kind}</span>
                  </label>
                ))}
                {optionsQuery.isPending ? <span className="text-xs text-muted-foreground">{t('加载中…')}</span> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('只列出对一个群说得通的通知。「抄送给你」「你有新的待办」这类对着本人说的不能推到群里。')}
              </p>
            </FormField>

            <FormField label={t('启用')}>
              <Switch checked={form.watch('status')} onCheckedChange={(c) => form.setValue('status', c, { shouldDirty: true })} />
            </FormField>
            <FormField label={t('备注')}>
              <Textarea {...form.register('remark')} rows={2} maxLength={256} />
            </FormField>

            {serverError ? (
              <p className="text-sm text-destructive" role="alert" data-testid="bot-error">
                {serverError}
              </p>
            ) : null}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="bot-submit">
              {t('保存')}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

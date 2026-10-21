import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { DateTimeValuePicker } from '@admin/ui/components/datetime-picker'
import { Input } from '@admin/ui/components/input'
import { QueryError } from '@admin/ui/components/query-error'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import {
  openScopesQuery,
  splitList,
  useCreateOpenApp,
  useUpdateOpenApp,
  type IssuedSecret,
  type OpenApp,
  type OpenAppBody,
} from './api'

const schema = z.object({
  // 和后端 `common/schema.py: CustomCode` 同一个格式（这里只为当场报错，后端才是权威）
  code: z
    .string()
    .min(2, '编码至少 2 个字符')
    .max(32, '编码不能超过 32 个字符')
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, '只能用字母、数字和下划线，且以字母开头'),
  name: z.string().min(1, '请输入应用名称').max(64, '名称不能超过 64 个字符'),
  scopes: z.array(z.string()).min(1, '至少授权一个接口'),
  ip_whitelist: z.string().optional(),
  rate_per_minute: z.string().regex(/^\d*$/, '请输入正整数').optional(),
  expire_time: z.string().optional(),
  status: z.boolean(),
  remark: z.string().max(500, '备注不能超过 500 个字符').optional(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = {
  code: '',
  name: '',
  scopes: [],
  ip_whitelist: '',
  rate_per_minute: '',
  expire_time: undefined,
  status: true,
  remark: '',
}

/** 后端下发带偏移的 ISO（`2026-10-21T15:00:00+08:00`），选择器要的是本地墙上时间 `YYYY-MM-DD HH:mm:ss` */
function toPickerValue(iso: string | null): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 选择器给的是浏览器本地时间，带上偏移再交给后端 —— 不带的话后端按服务端时区解释，跨时区就差几小时 */
function toIso(local: string | undefined): string | null {
  if (!local) return null
  const d = new Date(local.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function OpenAppFormSheet({
  open,
  onOpenChange,
  editing,
  onIssued,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: OpenApp | null
  /** 新建成功后把明文 SK 交给页面去弹「只显示一次」的窗口 */
  onIssued: (issued: IssuedSecret) => void
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateOpenApp()
  const update = useUpdateOpenApp()
  const scopesQuery = useQuery({ ...openScopesQuery(), enabled: open })
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            code: editing.code,
            name: editing.name,
            scopes: editing.scopes,
            ip_whitelist: (editing.ip_whitelist ?? []).join('\n'),
            rate_per_minute: editing.rate_per_minute === null ? '' : String(editing.rate_per_minute),
            expire_time: toPickerValue(editing.expire_time),
            status: editing.status === 1,
            remark: editing.remark ?? '',
          }
        : EMPTY
    )
  }, [open, editing, form])

  async function onSubmit(v: Values) {
    setServerError(null)
    const ips = splitList(v.ip_whitelist ?? '')
    const body: OpenAppBody = {
      name: v.name.trim(),
      scopes: v.scopes,
      // 空 = 不限。**不要传 []**：空白名单在语义上是「谁都不许」，和「不限」正好相反
      ip_whitelist: ips.length ? ips : null,
      rate_per_minute: v.rate_per_minute ? Number(v.rate_per_minute) : null,
      expire_time: toIso(v.expire_time),
      status: v.status ? 1 : 0,
      remark: v.remark?.trim() || null,
    }
    try {
      if (isEdit && editing) {
        await update.mutateAsync({ id: editing.id, body })
      } else {
        onIssued(await create.mutateAsync({ ...body, code: v.code.trim().toUpperCase() }))
      }
      onOpenChange(false)
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const errs = form.formState.errors
  const pending = create.isPending || update.isPending
  const picked = form.watch('scopes')

  function toggleScope(scope: string, on: boolean) {
    const next = on ? [...new Set([...picked, scope])] : picked.filter((s) => s !== scope)
    form.setValue('scopes', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑应用') : t('新建应用')}</SheetTitle>
          <SheetDescription>
            {t('外部系统用这对 AK/SK 签名调用开放接口（只读）。它只能调用下面勾选的接口，拿到的是全量数据、只含对外字段。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField
              label={t('应用编码')}
              error={fe(errs.code?.message)}
              required
              hint={t('字母开头，2–32 位，保存时转成大写。调用日志里显示为 app:<编码>，建好后不能改')}
            >
              <Input
                {...form.register('code')}
                autoComplete="off"
                disabled={isEdit}
                placeholder="FIN_SYS"
                className="font-mono"
                data-testid="open-app-code"
              />
            </FormField>

            <FormField label={t('应用名称')} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} autoComplete="off" maxLength={64} data-testid="open-app-name" />
            </FormField>

            <FormField
              label={t('授权接口')}
              error={fe(errs.scopes?.message)}
              required
              hint={t('清单从开放接口的声明里自动收集。没勾的接口调用时返回 403；每个接口返回哪些字段见对接文档')}
            >
              {scopesQuery.error ? (
                <QueryError error={scopesQuery.error} onRetry={() => scopesQuery.refetch()} />
              ) : scopesQuery.isPending ? (
                <Skeleton className="h-24" />
              ) : (
                <div className="overflow-hidden rounded-md border" data-testid="open-app-scopes">
                  {(scopesQuery.data ?? []).map((s) => {
                    const on = picked.includes(s.scope)
                    return (
                      <label
                        key={s.scope}
                        className={cn(
                          'flex cursor-pointer items-start gap-2.5 border-b px-3 py-2.5 last:border-b-0',
                          on && 'bg-primary/5'
                        )}
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={(c) => toggleScope(s.scope, c === true)}
                          className="mt-0.5"
                          data-testid={`open-scope-${s.scope}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm">{t(s.label)}</span>
                            <code className="font-mono text-xs text-muted-foreground">{s.scope}</code>
                          </span>
                          <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                            {s.method} {s.path}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </FormField>

            <FormField
              label={t('IP 白名单')}
              error={fe(errs.ip_whitelist?.message)}
              hint={t('每行一个 IP 或 CIDR；留空表示不限')}
            >
              <Textarea
                {...form.register('ip_whitelist')}
                rows={2}
                className="font-mono text-xs"
                placeholder="10.20.0.0/16"
              />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t('每分钟请求上限')}
                error={fe(errs.rate_per_minute?.message)}
                hint={t('留空使用全局默认')}
              >
                <Input {...form.register('rate_per_minute')} inputMode="numeric" autoComplete="off" />
              </FormField>
              <FormField label={t('失效时间')} hint={t('留空表示永不过期')}>
                <DateTimeValuePicker
                  value={form.watch('expire_time')}
                  onChange={(v) => form.setValue('expire_time', v, { shouldDirty: true })}
                  withTime
                  aria-label={t('失效时间')}
                />
              </FormField>
            </div>

            <FormField label={t('启用')} hint={t('停用后这对密钥立即失效，重新启用即恢复')}>
              <Switch
                checked={form.watch('status')}
                onCheckedChange={(c) => form.setValue('status', c, { shouldDirty: true })}
              />
            </FormField>

            <FormField label={t('备注')} error={fe(errs.remark?.message)}>
              <Textarea {...form.register('remark')} rows={2} placeholder={t('如：对接人、用途')} />
            </FormField>

            {serverError ? (
              <p className="text-sm text-destructive" data-testid="open-app-error">
                {serverError}
              </p>
            ) : null}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="open-app-submit">
              {isEdit ? t('保存') : t('创建并生成密钥')}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

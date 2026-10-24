import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { Input } from '@admin/ui/components/input'
import { QueryError } from '@admin/ui/components/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@admin/ui/components/select'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@admin/ui/components/sheet'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField, FormSection } from '../_shared/form-fields'
import {
  smsProvidersQuery,
  smsTemplatesQuery,
  useCreateSmsConfig,
  useUpdateSmsConfig,
  type OptionSchema,
  type SmsConfig,
  type SmsProvider,
  type SmsTemplate,
  type TemplatePreset,
  type TemplateSpec,
} from './api'

const schema = z.object({
  name: z.string().min(1, '请输入名称').max(64, '名称不能超过 64 个字符'),
  provider: z.string().min(1, '请选择厂商'),
  sign_name: z.string().min(1, '请输入短信签名').max(64),
  access_key_id: z.string(),
  access_key_secret: z.string(),
  weight: z.coerce.number().int().min(0).max(100),
  daily_max: z.coerce.number().int().min(0),
  timeout: z.coerce.number().int().min(1).max(60),
  is_default: z.boolean(),
  status: z.coerce.number().int(),
  remark: z.string(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = {
  name: '',
  provider: '',
  sign_name: '',
  access_key_id: '',
  access_key_secret: '',
  weight: 1,
  daily_max: 0,
  timeout: 10,
  is_default: false,
  status: 1,
  remark: '',
}

/**
 * 模板映射在表单里的草稿形状。按业务模板码存：`enabled` = 这条配置要不要配这个模板；
 * `named` 是「业务参数 → 厂商变量名」（空 = 不映射这个参数），`ordered` 是按位置挑业务参数（空 = 这一位不用）。
 *
 * 和接口形状刻意反过来（接口的 named 是 `{厂商变量名: 业务参数名}`）：表单要按**业务参数**逐行渲染，
 * 人填的是「这个业务参数在厂商模板里叫什么」—— 这样参数名永远不会拼错，错只会错在厂商那一侧的变量名。
 */
type TemplateDraft = { enabled: boolean; template_id: string; named: Record<string, string>; ordered: string[] }

function draftFromSpec(tpl: SmsTemplate, spec: TemplateSpec | undefined, mapping: SmsProvider['template_mapping']): TemplateDraft {
  const named: Record<string, string> = Object.fromEntries(tpl.params.map((p) => [p, p]))
  const ordered: string[] = [...tpl.params]
  if (!spec) return { enabled: false, template_id: '', named, ordered }
  if (mapping === 'named' && !Array.isArray(spec.mapping)) {
    for (const p of tpl.params) named[p] = ''
    for (const [variable, param] of Object.entries(spec.mapping)) named[param] = variable
  } else if (mapping === 'ordered' && Array.isArray(spec.mapping)) {
    ordered.length = 0
    ordered.push(...spec.mapping)
    while (ordered.length < tpl.params.length) ordered.push('')
  }
  return { enabled: true, template_id: spec.template_id, named, ordered }
}

/** 测试弹窗带过来的预填盖在草稿上：启用这个模板、填上模板 ID，变量名对得上业务参数的就映射成同名 */
function applyPreset(tpl: SmsTemplate, draft: TemplateDraft, preset: TemplatePreset, mapping: SmsProvider['template_mapping']): TemplateDraft {
  if (mapping === 'ordered') {
    const ordered = tpl.params.slice(0, preset.variables.length)
    while (ordered.length < tpl.params.length) ordered.push('')
    return { ...draft, enabled: true, template_id: preset.template_id, ordered }
  }
  const named = Object.fromEntries(tpl.params.map((p) => [p, preset.variables.includes(p) ? p : '']))
  return { ...draft, enabled: true, template_id: preset.template_id, named }
}

function specFromDraft(draft: TemplateDraft, mapping: SmsProvider['template_mapping']): TemplateSpec {
  if (mapping === 'named') {
    const m: Record<string, string> = {}
    for (const [param, variable] of Object.entries(draft.named)) if (variable.trim()) m[variable.trim()] = param
    return { template_id: draft.template_id.trim(), mapping: m }
  }
  return { template_id: draft.template_id.trim(), mapping: trimTrailingBlanks(draft.ordered) }
}

function trimTrailingBlanks(ordered: string[]): string[] {
  const out = [...ordered]
  while (out.length > 0 && !out[out.length - 1]) out.pop()
  return out
}

/** 按位置映射里夹在中间的空位：后端的列表表达不了「这一位空着」，静默过滤会让后面的参数前移一位 */
function firstInteriorBlank(ordered: string[]): number | null {
  const trimmed = trimTrailingBlanks(ordered)
  const i = trimmed.findIndex((p) => !p)
  return i === -1 ? null : i + 1
}

export function SmsConfigFormSheet({
  open,
  onOpenChange,
  editing,
  preset = null,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: SmsConfig | null
  /** 「发测试短信」测通后带进来的模板预填（见 `test-dialog.tsx`）*/
  preset?: TemplatePreset | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateSmsConfig()
  const update = useUpdateSmsConfig()
  const providersQuery = useQuery(smsProvidersQuery())
  const templatesQuery = useQuery(smsTemplatesQuery())
  const [serverError, setServerError] = React.useState<string | null>(null)
  // 厂商独有配置 / 模板映射是动态字段，不进 zod；后端按厂商的 Config / TemplateMapping 校验，这里只收集
  const [options, setOptions] = React.useState<Record<string, unknown>>({})
  const [drafts, setDrafts] = React.useState<Record<string, TemplateDraft>>({})

  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })
  const providers = React.useMemo(() => providersQuery.data ?? [], [providersQuery.data])
  const templates = React.useMemo(() => templatesQuery.data ?? [], [templatesQuery.data])
  const providerCode = form.watch('provider')
  const provider = React.useMemo(() => providers.find((p) => p.code === providerCode) ?? null, [providers, providerCode])

  // 打开时按「编辑的那条 / 空白」重置；厂商列表到了之后再补一次（新建默认选第一家）
  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            provider: editing.provider,
            sign_name: editing.sign_name,
            access_key_id: editing.access_key_id ?? '',
            // 🔴 编辑时永远是空的：接口不下发密钥（连密文都不发）
            access_key_secret: '',
            weight: editing.weight,
            daily_max: editing.daily_max,
            timeout: editing.timeout,
            is_default: editing.is_default,
            status: editing.status,
            remark: editing.remark ?? '',
          }
        : { ...EMPTY, provider: providers[0]?.code ?? '' },
    )
    setOptions(editing ? { ...editing.options } : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开 / 换对象时重置
  }, [open, editing, form, providers.length])

  // 模板草稿：随厂商（映射形状）和模板清单变
  React.useEffect(() => {
    if (!open || !provider) return
    setDrafts(
      Object.fromEntries(
        templates.map((tpl) => {
          const draft = draftFromSpec(tpl, editing?.templates[tpl.code], provider.template_mapping)
          return [tpl.code, preset?.code === tpl.code ? applyPreset(tpl, draft, preset, provider.template_mapping) : draft]
        }),
      ),
    )
  }, [open, provider, templates, editing, preset])

  const pending = create.isPending || update.isPending
  const errs = form.formState.errors
  const needsCredential = provider?.credential !== null && provider?.credential !== undefined
  const optionEntries = provider ? Object.entries(provider.options_schema.properties) : []
  const required = new Set(provider?.options_schema.required ?? [])

  function switchProvider(code: string) {
    form.setValue('provider', code, { shouldDirty: true })
    // 换厂商：独有配置清空并填默认值（上一家的键名在这一家是「未知的配置项」，后端会 400）
    const next = providers.find((p) => p.code === code)
    const defaults: Record<string, unknown> = {}
    for (const [key, s] of Object.entries(next?.options_schema.properties ?? {})) if (s.default !== undefined) defaults[key] = s.default
    setOptions(defaults)
  }

  async function onSubmit(v: Values) {
    setServerError(null)
    if (!provider) return
    if (needsCredential && !isEdit && !v.access_key_secret.trim()) {
      form.setError('access_key_secret', { message: '新建时必须填写凭据密钥' })
      return
    }
    const enabled = Object.entries(drafts).filter(([, d]) => d.enabled)
    for (const [code, d] of enabled) {
      if (!d.template_id.trim()) {
        setServerError(t('业务模板「{{code}}」还没填厂商模板 ID', { code }))
        return
      }
      const blank = provider.template_mapping === 'ordered' ? firstInteriorBlank(d.ordered) : null
      if (blank !== null) {
        setServerError(t('业务模板「{{code}}」第 {{n}} 位空着，但后面还有位在用 —— 只有末尾的位可以留空', { code, n: blank }))
        return
      }
    }
    const body = {
      name: v.name.trim(),
      provider: v.provider,
      sign_name: v.sign_name.trim(),
      access_key_id: needsCredential ? v.access_key_id.trim() || null : null,
      // 留空 = 不改，传 undefined 而不是空串（同 AI 供应商）
      access_key_secret: needsCredential ? v.access_key_secret.trim() || undefined : undefined,
      options,
      templates: Object.fromEntries(enabled.map(([code, d]) => [code, specFromDraft(d, provider.template_mapping)])),
      weight: v.weight,
      daily_max: v.daily_max,
      timeout: v.timeout,
      is_default: v.is_default,
      status: v.status,
      remark: v.remark.trim() || null,
    }
    try {
      if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
      else await create.mutateAsync(body)
      onOpenChange(false)
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const providerItems = React.useMemo(() => Object.fromEntries(providers.map((p) => [p.code, t(p.label)])), [providers, t])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑短信配置') : t('新增短信配置')}</SheetTitle>
          <SheetDescription>
            {t('一条配置 = 一家厂商的一套凭据和签名，加上每个业务模板对应的厂商模板。凭据加密落库，界面上只显示掩码。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField label={t('名称')} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} autoComplete="off" maxLength={64} data-testid="sms-name" />
            </FormField>

            {providersQuery.error ? (
              // 厂商目录拉不下来 = 一个都选不了、保存按钮永远灰：要显示成错误而不是「没有厂商」（硬纪律 9）
              <QueryError error={providersQuery.error} onRetry={() => providersQuery.refetch()} />
            ) : null}
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('厂商')} error={fe(errs.provider?.message)} required>
                <Select value={providerCode} items={providerItems} onValueChange={(v) => switchProvider(String(v))}>
                  <SelectTrigger>
                    <SelectValue placeholder={providersQuery.isPending ? t('加载中…') : t('请选择')} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {t(p.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t('短信签名')}
                error={fe(errs.sign_name?.message)}
                required
                hint={t('两家都要求已审核通过；腾讯云填签名内容，不是签名 ID')}
              >
                <Input {...form.register('sign_name')} autoComplete="off" maxLength={64} placeholder={t('例如：某某科技')} data-testid="sms-sign" />
              </FormField>
            </div>

            {provider && needsCredential && provider.credential ? (
              <div className="grid grid-cols-2 gap-4">
                <FormField label={provider.credential.key_label} error={fe(errs.access_key_id?.message)} required>
                  <Input {...form.register('access_key_id')} autoComplete="off" />
                </FormField>
                <FormField
                  label={provider.credential.secret_label}
                  error={fe(errs.access_key_secret?.message)}
                  required={!isEdit}
                  hint={isEdit ? t('留空表示不修改（接口不会回显已保存的密钥）') : undefined}
                >
                  <Input {...form.register('access_key_secret')} type="password" autoComplete="new-password" />
                </FormField>
              </div>
            ) : null}

            {optionEntries.length > 0 ? (
              <div className="grid grid-cols-2 gap-4">
                {optionEntries.map(([key, s]) => (
                  <OptionField
                    key={key}
                    name={key}
                    schema={s}
                    required={required.has(key)}
                    value={options[key]}
                    onChange={(v) => setOptions((prev) => ({ ...prev, [key]: v }))}
                  />
                ))}
              </div>
            ) : null}

            <FormSection title={t('业务模板映射')}>
              <p className="text-xs text-muted-foreground">
                {provider?.template_mapping === 'ordered'
                  ? t('这家厂商按位置填模板变量：按厂商模板里 {1}、{2} 的顺序挑业务参数，末尾用不到的位留空。')
                  : t('这家厂商按变量名填模板变量：写出每个业务参数在厂商模板里的变量名，不需要的留空（阿里云验证码模板只认一个变量）。')}
              </p>
              {templatesQuery.isPending ? <p className="text-xs text-muted-foreground">{t('加载中…')}</p> : null}
              {templatesQuery.error ? <QueryError error={templatesQuery.error} onRetry={() => templatesQuery.refetch()} /> : null}
              {templates.map((tpl) => {
                const d = drafts[tpl.code]
                if (!d) return null
                const patch = (next: Partial<TemplateDraft>) => setDrafts((prev) => ({ ...prev, [tpl.code]: { ...d, ...next } }))
                return (
                  <div key={tpl.code} className="flex flex-col gap-3 rounded-md border p-3" data-testid={`sms-tpl-${tpl.code}`}>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={d.enabled} onCheckedChange={(c) => patch({ enabled: c === true })} data-testid={`sms-tpl-enable-${tpl.code}`} />
                      <span className="font-medium">{t(tpl.label)}</span>
                      <span className="font-mono text-xs text-muted-foreground">{tpl.code}</span>
                      <span className="ms-auto text-xs text-muted-foreground">
                        {t('参数：{{params}}', { params: tpl.params.join(', ') })}
                      </span>
                    </label>
                    {d.enabled ? (
                      <>
                        <FormField label={t('厂商模板 ID')} required hint={provider ? t(provider.template_id_hint) : undefined}>
                          <Input value={d.template_id} onChange={(e) => patch({ template_id: e.target.value })} autoComplete="off" maxLength={64} data-testid={`sms-tpl-id-${tpl.code}`} />
                        </FormField>
                        {provider?.template_mapping === 'ordered' ? (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {tpl.params.map((_, i) => (
                              <FormField key={i} label={t('第 {{n}} 位 {{var}}', { n: i + 1, var: `{${i + 1}}` })}>
                                <Select
                                  value={d.ordered[i] ?? ''}
                                  items={{ '': t('（不用）'), ...Object.fromEntries(tpl.params.map((p) => [p, p])) }}
                                  onValueChange={(v) => {
                                    const ordered = [...d.ordered]
                                    while (ordered.length <= i) ordered.push('')
                                    ordered[i] = String(v ?? '')
                                    patch({ ordered })
                                  }}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="">{t('（不用）')}</SelectItem>
                                    {tpl.params.map((p) => (
                                      <SelectItem key={p} value={p}>
                                        {p}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </FormField>
                            ))}
                          </div>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {tpl.params.map((p) => (
                              <FormField key={p} label={t('{{param}} 在厂商模板里叫', { param: p })}>
                                <Input
                                  value={d.named[p] ?? ''}
                                  onChange={(e) => patch({ named: { ...d.named, [p]: e.target.value } })}
                                  placeholder={t('留空 = 不映射')}
                                  autoComplete="off"
                                />
                              </FormField>
                            ))}
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                )
              })}
            </FormSection>

            <FormSection title={t('分流与限额')}>
              <div className="grid grid-cols-3 gap-4">
                <FormField label={t('权重')} error={fe(errs.weight?.message)} hint={t('0 = 不自动选用，只能被指定')}>
                  <Input {...form.register('weight')} type="number" min={0} max={100} />
                </FormField>
                <FormField label={t('日上限')} error={fe(errs.daily_max?.message)} hint={t('每个自然日；0 = 不限')}>
                  <Input {...form.register('daily_max')} type="number" min={0} />
                </FormField>
                <FormField label={t('超时（秒）')} error={fe(errs.timeout?.message)} hint={t('腾讯云 SDK 默认等 60 秒，这里显式传')}>
                  <Input {...form.register('timeout')} type="number" min={1} max={60} />
                </FormField>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField label={t('设为默认')} hint={t('有默认就永远先用它；到了日上限再按权重分给别的')}>
                  <Switch checked={form.watch('is_default')} onCheckedChange={(c) => form.setValue('is_default', c, { shouldDirty: true })} />
                </FormField>
                <FormField label={t('启用')} hint={t('停用的配置不参与发送，也不能设为默认')}>
                  <Switch
                    checked={form.watch('status') === 1}
                    onCheckedChange={(c) => form.setValue('status', c ? 1 : 0, { shouldDirty: true })}
                  />
                </FormField>
              </div>
            </FormSection>

            <FormField label={t('备注')}>
              <Textarea {...form.register('remark')} rows={2} />
            </FormField>

            {serverError ? (
              <p className="text-sm text-destructive" role="alert">
                {serverError}
              </p>
            ) : null}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending || !provider} data-testid="sms-submit">
              {t('保存')}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/** 厂商独有配置的一个字段：按 JSON Schema 的 type / enum 挑控件（string / integer / boolean / enum 四种够用） */
function OptionField({
  name,
  schema: s,
  required,
  value,
  onChange,
}: {
  name: string
  schema: OptionSchema
  required: boolean
  value: unknown
  onChange: (v: unknown) => void
}) {
  const { t } = useTranslation()
  const label = s.title ? t(s.title) : name
  const hint = s.description ? t(s.description) : undefined
  if (s.enum) {
    const items = Object.fromEntries(s.enum.map((e) => [String(e), String(e)]))
    const current = value === undefined || value === null ? String(s.default ?? s.enum[0]) : String(value)
    return (
      <FormField label={label} required={required} hint={hint}>
        <Select value={current} items={items} onValueChange={(v) => onChange(v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {s.enum.map((e) => (
              <SelectItem key={String(e)} value={String(e)}>
                {String(e)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    )
  }
  if (s.type === 'boolean') {
    return (
      <FormField label={label} required={required} hint={hint}>
        <Switch checked={Boolean(value ?? s.default ?? false)} onCheckedChange={(c) => onChange(c)} />
      </FormField>
    )
  }
  const numeric = s.type === 'integer' || s.type === 'number'
  return (
    <FormField label={label} required={required} hint={hint}>
      <Input
        type={numeric ? 'number' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={s.default !== undefined ? String(s.default) : undefined}
        autoComplete="off"
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') onChange(undefined)
          else onChange(numeric ? Number(raw) : raw)
        }}
      />
    </FormField>
  )
}

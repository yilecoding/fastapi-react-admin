import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
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
import { FormField } from '../_shared/form-fields'
import {
  PROVIDER_PRESETS,
  PROVIDER_TYPE_LABELS,
  useCreateProvider,
  useUpdateProvider,
  type AiProvider,
} from './api'

const schema = z.object({
  name: z.string().min(1, '请输入名称').max(64, '名称不能超过 64 个字符'),
  provider_type: z.enum(['openai', 'deepseek', 'qwen', 'glm', 'custom']),
  base_url: z.string().min(1, '请输入接口地址').max(256).startsWith('http', '必须以 http:// 或 https:// 开头'),
  model: z.string().min(1, '请输入模型名').max(128),
  api_key: z.string().optional(),
  timeout: z.coerce.number().int().min(1).max(600),
  verify_ssl: z.boolean(),
  use_proxy: z.boolean(),
  max_retries: z.coerce.number().int().min(0).max(5),
  is_default: z.boolean(),
  status: z.coerce.number().int(),
  remark: z.string().optional(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = {
  name: '',
  provider_type: 'deepseek',
  base_url: PROVIDER_PRESETS.deepseek.base_url,
  model: PROVIDER_PRESETS.deepseek.model,
  api_key: '',
  timeout: 120,
  verify_ssl: true,
  use_proxy: false,
  max_retries: 1,
  is_default: false,
  status: 1,
  remark: '',
}

export function ProviderFormSheet({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: AiProvider | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateProvider()
  const update = useUpdateProvider()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            provider_type: editing.provider_type,
            base_url: editing.base_url,
            model: editing.model,
            // 🔴 编辑时永远是空的：接口不下发密钥（连密文都不发）
            api_key: '',
            timeout: editing.timeout,
            verify_ssl: editing.verify_ssl,
            use_proxy: editing.use_proxy,
            max_retries: editing.max_retries,
            is_default: editing.is_default,
            status: editing.status,
            remark: editing.remark ?? '',
          }
        : EMPTY,
    )
  }, [open, editing, form])

  const pending = create.isPending || update.isPending
  const type = form.watch('provider_type')

  async function onSubmit(v: Values) {
    setServerError(null)
    if (!isEdit && !v.api_key?.trim()) {
      form.setError('api_key', { message: '新建时必须填写 API Key' })
      return
    }
    const body = {
      ...v,
      remark: v.remark?.trim() || null,
      // 留空 = 不改。**不要传空串**：后端按「有值才改」判断，空串在那边同样是不改，
      // 但显式传 undefined 更贴意图，也少一次「是不是想把密钥清空」的歧义
      api_key: v.api_key?.trim() || undefined,
    }
    try {
      if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
      else await create.mutateAsync(body)
      onOpenChange(false)
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const errs = form.formState.errors
  // 常量表在渲染处翻（同 dept/form.tsx 的 statusItems）
  const typeItems = React.useMemo(
    () => Object.fromEntries(Object.entries(PROVIDER_TYPE_LABELS).map(([v, l]) => [v, t(l)])),
    [t],
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑模型供应商') : t('新增模型供应商')}</SheetTitle>
          <SheetDescription>
            {t('全部走 OpenAI 兼容接口。内网自建网关选「自定义」，并按需要关掉 TLS 校验。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField label={t('名称')} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} autoComplete="off" maxLength={64} />
            </FormField>

            <FormField label={t('类型')} error={fe(errs.provider_type?.message)} required>
              <Select
                value={type}
                items={typeItems}
                onValueChange={(v) => {
                  const next = v as Values['provider_type']
                  form.setValue('provider_type', next, { shouldDirty: true })
                  // 换类型时带出预设地址/模型，但**只在用户没自己填过时**覆盖 ——
                  // 否则改一下类型会把人辛苦粘进去的内网地址冲掉
                  const preset = PROVIDER_PRESETS[next]
                  if (preset.base_url && !form.getValues('base_url')) form.setValue('base_url', preset.base_url)
                  if (preset.model && !form.getValues('model')) form.setValue('model', preset.model)
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(typeItems).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t('接口地址')}
              error={fe(errs.base_url?.message)}
              required
              hint={t('OpenAI 兼容的 base，通常要带 /v1；代码会在它后面拼 chat/completions')}
            >
              <Input {...form.register('base_url')} autoComplete="off" placeholder="https://api.deepseek.com/v1" />
            </FormField>

            <FormField label={t('模型')} error={fe(errs.model?.message)} required>
              <Input {...form.register('model')} autoComplete="off" placeholder="deepseek-chat" />
            </FormField>

            <FormField
              label="API Key"
              error={fe(errs.api_key?.message)}
              required={!isEdit}
              hint={isEdit ? t('留空表示不修改（接口不会回显已保存的密钥）') : undefined}
            >
              <Input {...form.register('api_key')} type="password" autoComplete="new-password" />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('超时（秒）')} error={fe(errs.timeout?.message)}>
                <Input {...form.register('timeout')} type="number" min={1} max={600} />
              </FormField>
              <FormField label={t('重试次数')} error={fe(errs.max_retries?.message)}>
                <Input {...form.register('max_retries')} type="number" min={0} max={5} />
              </FormField>
            </div>

            <FormField
              label={t('校验 TLS 证书')}
              hint={t('内网自签证书要关掉，否则 Python 的 certifi 验不过，报错看起来像网关挂了')}
            >
              <Switch
                checked={form.watch('verify_ssl')}
                onCheckedChange={(c) => form.setValue('verify_ssl', c, { shouldDirty: true })}
              />
            </FormField>

            <FormField
              label={t('走系统代理')}
              hint={t('内网网关按实际可达路径选：直连不通就打开它。配错的表现是纯超时，看起来像网关挂了')}
            >
              <Switch
                checked={form.watch('use_proxy')}
                onCheckedChange={(c) => form.setValue('use_proxy', c, { shouldDirty: true })}
              />
            </FormField>

            <FormField label={t('设为默认')} hint={t('新会话默认用它；只能有一个默认')}>
              <Switch
                checked={form.watch('is_default')}
                onCheckedChange={(c) => form.setValue('is_default', c, { shouldDirty: true })}
              />
            </FormField>

            <FormField label={t('备注')}>
              <Textarea {...form.register('remark')} rows={2} />
            </FormField>

            {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {t('保存')}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Label } from '@admin/ui/components/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import {
  CONFIG_TYPES, TYPE_LABEL, useCreateConfig, useUpdateConfig, type ConfigItem,
} from './api'


const schema = z.object({
  name: z.string().min(1, '请输入名称').max(32),
  // 键名是业务代码/后端 dynamic_config 引用的东西，约束严一点
  key: z.string().min(1, '请输入键名').max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, '键名请用大写字母、数字和下划线，且以字母开头'),
  type: z.string().optional(),
  value: z.string().max(2000),
  is_frontend: z.boolean(),
  remark: z.string().max(200).optional(),
})
type Values = z.infer<typeof schema>

const NONE = '__none__'
const TYPE_ITEMS: Record<string, string> = {
  [NONE]: '未分组',
  ...Object.fromEntries(CONFIG_TYPES.map((ty) => [ty, TYPE_LABEL[ty] ?? ty])),
}

export function ConfigSheet({
  open, onOpenChange, editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: ConfigItem | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateConfig()
  const update = useUpdateConfig()
  const [err, setErr] = React.useState<string | null>(null)
  // 模块级常量翻不了（加载时求值）—— 在渲染处逐个 t()，注册表本身不用改
  const typeItems = React.useMemo(
    () => Object.fromEntries(Object.entries(TYPE_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: '', key: '', type: NONE, value: '', is_frontend: false, remark: '' },
  })

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            key: editing.key,
            type: editing.type ?? NONE,
            value: editing.value,
            is_frontend: editing.is_frontend,
            remark: editing.remark ?? '',
          }
        : { name: '', key: '', type: NONE, value: '', is_frontend: false, remark: '' }
    )
  }, [open, editing, form])

  const pending = create.isPending || update.isPending
  const errs = form.formState.errors
  const isFrontend = form.watch('is_frontend')
  const type = form.watch('type')

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Sheet 基础类是 data-[side=right]:sm:max-w-sm，覆盖必须带同样的变体前缀 */}
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑参数') : t('新增参数')}</SheetTitle>
          <SheetDescription>
            <Trans
              t={t}
              i18nKey="键名是后端 <c>dynamic_config</c> 和业务代码引用这条配置的唯一入口，建好之后不要改 —— 改了等于把这个参数从系统里摘掉。"
              components={{ c: <code /> }}
            />
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={form.handleSubmit(async (v) => {
            setErr(null)
            const body = {
              name: v.name.trim(),
              key: v.key.trim(),
              type: v.type && v.type !== NONE ? v.type : null,
              value: v.value,
              is_frontend: v.is_frontend,
              remark: v.remark?.trim() || null,
            }
            try {
              if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
              else await create.mutateAsync(body)
              onOpenChange(false)
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : t('保存失败'))
            }
          })}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField label={t("名称")} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} data-testid="cfg-name" autoComplete="off" />
            </FormField>
            <FormField
              label={t("键名")}
              error={fe(errs.key?.message)}
              required
              hint={t('大写下划线风格，如 LOGIN_CAPTCHA_ENABLED')}
            >
              <Input
                {...form.register('key')}
                data-testid="cfg-key"
                autoComplete="off"
                className="font-mono"
                disabled={isEdit}
              />
            </FormField>
            <FormField
              label={t("分组")}
              hint={
                type && type !== NONE
                  ? t('后端按分组整组加载；同组还要求 <分组>_CONFIG_STATUS 为 1 才生效')
                  : t('未分组的参数不会被 dynamic_config 加载，只能由业务代码自己读')
              }
            >
              <Select
                value={type ?? NONE}
                items={typeItems}
                onValueChange={(v) => form.setValue('type', v ?? NONE)}
              >
                <SelectTrigger data-testid="cfg-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(typeItems).map(([v, label]) => (
                    <SelectItem key={v} value={v}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("键值")} error={fe(errs.value?.message)}>
              <Textarea {...form.register('value')} data-testid="cfg-value" rows={3} className="font-mono" />
            </FormField>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div className="flex flex-col">
                <Label>{t('前端可读')}</Label>
                <span className="text-xs text-muted-foreground">
                  {t('标记给前端工程消费的配置，不影响后端行为')}
                </span>
              </div>
              <Switch
                checked={isFrontend}
                data-testid="cfg-frontend"
                onCheckedChange={(c) => form.setValue('is_frontend', c === true)}
              />
            </div>
            <FormField label={t("备注")} error={fe(errs.remark?.message)}>
              <Textarea {...form.register('remark')} data-testid="cfg-remark" rows={2} />
            </FormField>
            {err && <p className="text-sm text-destructive" data-testid="cfg-error">{err}</p>}
          </div>
          <SheetFooter>
            <SheetClose render={<Button type="button" variant="outline" disabled={pending} />}>{t('取消')}</SheetClose>
            <Button type="submit" disabled={pending} data-testid="cfg-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {t('保存')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

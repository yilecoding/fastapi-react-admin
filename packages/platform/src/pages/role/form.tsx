import * as React from 'react'
import { useTranslation } from 'react-i18next'
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
import { STATUS_FORM_ITEMS } from '../_shared/status'
import { useCreateRole, useUpdateRole, type Role } from './api'

const schema = z.object({
  name: z.string().min(1, '请输入角色名称').max(20),
  status: z.coerce.number().int(),
  is_filter_scopes: z.boolean(),
  remark: z.string().max(200).optional(),
})
type Values = z.infer<typeof schema>

export function RoleFormSheet({
  open, onOpenChange, editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: Role | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateRole()
  const update = useUpdateRole()
  const [serverError, setServerError] = React.useState<string | null>(null)

  // Select 的**关闭态**是靠 items 映射显示标签的，直接传中文常量就等于没翻。
  // 常量本身不动（它的值就是 key），在渲染处映射一次。
  const statusItems = React.useMemo(
    () => Object.fromEntries(Object.entries(STATUS_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: '', status: 1, is_filter_scopes: true, remark: '' },
  })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            status: editing.status,
            is_filter_scopes: editing.is_filter_scopes,
            remark: editing.remark ?? '',
          }
        : { name: '', status: 1, is_filter_scopes: true, remark: '' }
    )
  }, [open, editing, form])

  const pending = create.isPending || update.isPending

  async function onSubmit(v: Values) {
    setServerError(null)
    const body = {
      name: v.name.trim(),
      status: v.status,
      is_filter_scopes: v.is_filter_scopes,
      remark: v.remark?.trim() || null,
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑角色') : t('新增角色')}</SheetTitle>
          <SheetDescription>
            {t('角色只定义身份；具体能看哪些菜单、点哪些按钮，在右侧「功能权限」里配。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <div className="flex flex-col gap-2">
              <Label>{t('角色名称')}<span className="ms-0.5 text-destructive">*</span></Label>
              <Input {...form.register('name')} data-testid="r-name" autoComplete="off" />
              {errs.name && <span className="text-xs text-destructive">{fe(errs.name.message)}</span>}
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t('状态')}<span className="ms-0.5 text-destructive">*</span></Label>
              <Select
                value={String(form.watch('status'))}
                items={statusItems}
                onValueChange={(v) => form.setValue('status', Number(v), { shouldValidate: true })}
              >
                <SelectTrigger className="w-full" data-testid="r-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('正常')}</SelectItem>
                  <SelectItem value="0">{t('停用')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="r-scopes">{t('启用数据权限过滤')}</Label>
                <span className="text-xs text-muted-foreground">
                  {t('关闭后该角色不受数据范围限制，可看到全部数据（如集团总部角色）。')}
                </span>
              </div>
              <Switch
                id="r-scopes"
                data-testid="r-filter-scopes"
                checked={form.watch('is_filter_scopes')}
                onCheckedChange={(c) => form.setValue('is_filter_scopes', Boolean(c))}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t('备注')}</Label>
              <Textarea rows={3} {...form.register('remark')} data-testid="r-remark" />
            </div>

            {serverError && <p className="text-sm text-destructive" data-testid="form-error">{serverError}</p>}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="r-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建角色')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

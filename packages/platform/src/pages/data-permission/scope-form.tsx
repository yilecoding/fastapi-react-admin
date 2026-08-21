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

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { STATUS_FORM_ITEMS } from '../_shared/status'
import { useCreateDataScope, useUpdateDataScope, type DataScope } from './api'

const schema = z.object({
  name: z.string().min(1, '请输入范围名称').max(64),
  status: z.coerce.number().int(),
})

export function ScopeFormSheet({
  open, onOpenChange, editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: DataScope | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateDataScope()
  const update = useUpdateDataScope()
  const [err, setErr] = React.useState<string | null>(null)

  // Select 的关闭态用 items 映射显示标签 —— 直接传中文常量等于没翻。
  // 常量本身不动（值就是 key），渲染处映射一次。
  const statusItems = React.useMemo(
    () => Object.fromEntries(Object.entries(STATUS_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: '', status: 1 },
  })

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    form.reset(editing ? { name: editing.name, status: editing.status } : { name: '', status: 1 })
  }, [open, editing, form])

  const pending = create.isPending || update.isPending

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑数据范围') : t('新增数据范围')}</SheetTitle>
          <SheetDescription>
            {t('范围只是一捆规则的名字。建完在右边直接加规则，角色绑的是这个名字。')}
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={form.handleSubmit(async (v) => {
            setErr(null)
            const body = { name: v.name.trim(), status: v.status }
            try {
              if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
              else await create.mutateAsync(body)
              onOpenChange(false)
            } catch (e) { setErr(e instanceof ApiError ? e.message : t('保存失败')) }
          })}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-2">
            <div className="flex flex-col gap-2">
              <Label>{t('范围名称')}<span className="ms-0.5 text-destructive">*</span></Label>
              <Input {...form.register('name')} data-testid="ds-name" autoComplete="off"
                     placeholder={t("如：本部门数据")} />
              {form.formState.errors.name && (
                <span className="text-xs text-destructive">{fe(form.formState.errors.name.message)}</span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t('状态')}<span className="ms-0.5 text-destructive">*</span></Label>
              <Select value={String(form.watch('status'))} items={statusItems}
                      onValueChange={(v) => form.setValue('status', Number(v), { shouldValidate: true })}>
                <SelectTrigger className="w-full" data-testid="ds-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('正常')}</SelectItem>
                  <SelectItem value="0">{t('停用')}</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {t('停用后这个范围里的规则整体失效（`filter_data_permission` 只收 status 为正常的范围）。')}
              </span>
            </div>
            {err && <p className="text-sm text-destructive" data-testid="form-error">{err}</p>}
          </div>
          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="ds-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建范围')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

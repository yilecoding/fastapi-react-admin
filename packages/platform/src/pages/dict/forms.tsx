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
import { Textarea } from '@admin/ui/components/textarea'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import {
  COLOR_CLASS, COLOR_ITEMS,
  useCreateDictData, useCreateDictType, useUpdateDictData, useUpdateDictType,
  type DictData, type DictType,
} from './api'

function Fld({ label, error, required, children }: {
  label: string; error?: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}{required && <span className="ms-0.5 text-destructive">*</span>}</Label>
      {children}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

// ─── 字典类型 ──────────────────────────────────────────────────────────────────

const typeSchema = z.object({
  name: z.string().min(1, '请输入类型名称').max(32),
  code: z.string().min(1, '请输入类型编码').max(32)
    .regex(/^[a-z][a-z0-9_]*$/, '编码只能用小写字母、数字和下划线，且以字母开头'),
  remark: z.string().max(200).optional(),
})
type TypeValues = z.infer<typeof typeSchema>

export function DictTypeSheet({ open, onOpenChange, editing }: {
  open: boolean; onOpenChange: (o: boolean) => void; editing: DictType | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateDictType()
  const update = useUpdateDictType()
  const [err, setErr] = React.useState<string | null>(null)

  const form = useForm<TypeValues>({
    resolver: zodResolver(typeSchema) as never,
    defaultValues: { name: '', code: '', remark: '' },
  })

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    form.reset(editing ? { name: editing.name, code: editing.code, remark: editing.remark ?? '' }
                       : { name: '', code: '', remark: '' })
  }, [open, editing, form])

  const pending = create.isPending || update.isPending
  const errs = form.formState.errors

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑字典类型') : t('新增字典类型')}</SheetTitle>
          <SheetDescription>
            {t('类型编码是业务代码引用字典的键，创建后尽量不要改。')}
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={form.handleSubmit(async (v) => {
            setErr(null)
            const body = { name: v.name.trim(), code: v.code.trim(), remark: v.remark?.trim() || null }
            try {
              if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
              else await create.mutateAsync(body)
              onOpenChange(false)
            } catch (e) { setErr(e instanceof ApiError ? e.message : t('保存失败')) }
          })}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <Fld label={t("类型名称")} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} data-testid="dt-name" autoComplete="off" />
            </Fld>
            <Fld label={t("类型编码")} error={fe(errs.code?.message)} required>
              <Input {...form.register('code')} data-testid="dt-code" autoComplete="off"
                     placeholder={t("如 order_status")} />
            </Fld>
            <Fld label={t("备注")} error={fe(errs.remark?.message)}>
              <Textarea rows={3} {...form.register('remark')} data-testid="dt-remark" />
            </Fld>
            {err && <p className="text-sm text-destructive" data-testid="form-error">{err}</p>}
          </div>
          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="dt-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建类型')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

// ─── 字典数据 ──────────────────────────────────────────────────────────────────

const dataSchema = z.object({
  label: z.string().min(1, '请输入显示文本').max(32),
  value: z.string().min(1, '请输入实际值').max(32),
  color: z.string().optional(),
  sort: z.coerce.number().int().min(0),
  status: z.coerce.number().int(),
  remark: z.string().max(200).optional(),
})
type DataValues = z.infer<typeof dataSchema>

/** 模块级常量翻不了 —— 渲染处过一遍 `t()`（见组件内的 statusItems） */
const STATUS_ITEMS: Record<string, string> = { '1': '正常', '0': '停用' }

export function DictDataSheet({ open, onOpenChange, editing, typeId, typeName }: {
  open: boolean; onOpenChange: (o: boolean) => void
  editing: DictData | null; typeId: string; typeName: string
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateDictData()
  const update = useUpdateDictData()
  const [err, setErr] = React.useState<string | null>(null)

  const form = useForm<DataValues>({
    resolver: zodResolver(dataSchema) as never,
    defaultValues: { label: '', value: '', color: 'default', sort: 0, status: 1, remark: '' },
  })

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    form.reset(editing
      ? {
          label: editing.label, value: editing.value, color: editing.color ?? 'default',
          sort: editing.sort, status: editing.status, remark: editing.remark ?? '',
        }
      : { label: '', value: '', color: 'default', sort: 0, status: 1, remark: '' })
  }, [open, editing, form])

  const pending = create.isPending || update.isPending
  const errs = form.formState.errors
  const color = form.watch('color') ?? 'default'
  const statusItems = React.useMemo(
    () => Object.fromEntries(Object.entries(STATUS_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑字典项') : t('新增字典项')}</SheetTitle>
          <SheetDescription>{t('所属类型：{{name}}', { name: typeName })}</SheetDescription>
        </SheetHeader>
        <form
          onSubmit={form.handleSubmit(async (v) => {
            setErr(null)
            const body = {
              type_id: typeId, label: v.label.trim(), value: v.value.trim(),
              color: v.color || null, sort: v.sort, status: v.status,
              remark: v.remark?.trim() || null,
            }
            try {
              if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
              else await create.mutateAsync(body)
              onOpenChange(false)
            } catch (e) { setErr(e instanceof ApiError ? e.message : t('保存失败')) }
          })}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <Fld label={t("显示文本")} error={fe(errs.label?.message)} required>
                <Input {...form.register('label')} data-testid="dd-label" autoComplete="off" />
              </Fld>
              <Fld label={t("实际值")} error={fe(errs.value?.message)} required>
                <Input {...form.register('value')} data-testid="dd-value" autoComplete="off" />
              </Fld>
            </div>
            <Fld label={t("颜色标记")} error={fe(errs.color?.message)}>
              <div className="flex items-center gap-2">
                <Select value={color} items={Object.fromEntries(Object.entries(COLOR_ITEMS).map(([k, v]) => [k, t(v)]))}
                        onValueChange={(v) => form.setValue('color', v ?? undefined, { shouldValidate: true })}>
                  <SelectTrigger className="flex-1" data-testid="dd-color"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(COLOR_ITEMS).map(([v, l]) => <SelectItem key={v} value={v}>{t(l)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs ring-1 ${COLOR_CLASS[color] ?? COLOR_CLASS.default}`}>
                  {form.watch('label') || t('预览')}
                </span>
              </div>
            </Fld>
            <div className="grid grid-cols-2 gap-4">
              <Fld label={t("排序")} error={fe(errs.sort?.message)}>
                <Input type="number" min={0} {...form.register('sort')} data-testid="dd-sort" />
              </Fld>
              <Fld label={t("状态")} error={fe(errs.status?.message)} required>
                <Select value={String(form.watch('status'))} items={statusItems}
                        onValueChange={(v) => form.setValue('status', Number(v), { shouldValidate: true })}>
                  <SelectTrigger className="w-full" data-testid="dd-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t('正常')}</SelectItem>
                    <SelectItem value="0">{t('停用')}</SelectItem>
                  </SelectContent>
                </Select>
              </Fld>
            </div>
            <Fld label={t("备注")} error={fe(errs.remark?.message)}>
              <Textarea rows={2} {...form.register('remark')} data-testid="dd-remark" />
            </Fld>
            {err && <p className="text-sm text-destructive" data-testid="form-error">{err}</p>}
          </div>
          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="dd-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建字典项')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import { parentOptions, useCreateDept, useUpdateDept, type Dept } from './api'

const schema = z.object({
  name: z.string().min(1, '请输入部门名称').max(50),
  // 与后端 CustomCode 同一条规则。写在两边是刻意的：这里为了当场报错，
  // 后端那份才是权威（前端绕过了也存不进去）。
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, '编码为 2–32 位大写字母、数字或下划线，且以字母开头'),
  parent_id: z.string().optional(),
  sort: z.coerce.number().int().min(0, '排序不能为负'),
  leader: z.string().max(20).optional(),
  phone: z.union([z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'), z.literal('')]).optional(),
  email: z.union([z.email('邮箱格式不正确'), z.literal('')]).optional(),
  status: z.coerce.number().int(),
})
type Values = z.infer<typeof schema>

/** 模块级常量翻不了 —— 渲染处过一遍 `t()`（见组件内的 statusItems） */
const STATUS_ITEMS: Record<string, string> = { '1': '正常', '0': '停用' }
const ROOT = '__root__'

export function DeptFormSheet({
  open, onOpenChange, editing, presetParentId, tree,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: Dept | null
  presetParentId?: string | null
  tree: Dept[]
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateDept()
  const update = useUpdateDept()
  const [serverError, setServerError] = React.useState<string | null>(null)

  // 编辑时不能把自己挂到自己的子树下 —— 选项里排除自身及子孙
  const parents = React.useMemo(() => parentOptions(tree, editing?.id), [tree, editing])
  const parentItems = React.useMemo(
    () => ({ [ROOT]: t('顶级部门'), ...Object.fromEntries(parents.map((p) => [p.id, p.label.trim()])) }),
    [parents, t]
  )

  // Base UI 的 Select 关闭态靠 items 映射显示标签 —— 在渲染处翻，别把常量本身改成 t()
  const statusItems = React.useMemo(
    () => Object.fromEntries(Object.entries(STATUS_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: '', code: '', parent_id: ROOT, sort: 0, leader: '', phone: '', email: '', status: 1 },
  })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            code: editing.code,
            parent_id: editing.parent_id ?? ROOT,
            sort: editing.sort,
            leader: editing.leader ?? '',
            phone: editing.phone ?? '',
            email: editing.email ?? '',
            status: editing.status,
          }
        : { name: '', code: '', parent_id: presetParentId ?? ROOT, sort: 0, leader: '', phone: '', email: '', status: 1 }
    )
  }, [open, editing, presetParentId, form])

  const pending = create.isPending || update.isPending

  async function onSubmit(v: Values) {
    setServerError(null)
    const body = {
      name: v.name.trim(),
      parent_id: v.parent_id === ROOT ? null : v.parent_id || null,
      sort: v.sort,
      leader: v.leader?.trim() || null,
      phone: v.phone?.trim() || null,
      email: v.email?.trim() || null,
      status: v.status,
    }
    try {
      // 编辑时**不带 code** —— 后端 UpdateDeptParam 里没有这个字段，带了也只是被丢掉
      if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
      else await create.mutateAsync({ ...body, code: v.code.trim().toUpperCase() })
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
          <SheetTitle>{isEdit ? t('编辑部门') : t('新增部门')}</SheetTitle>
          <SheetDescription>
            {isEdit ? t('修改部门信息与层级归属。') : t('部门层级用于数据权限隔离（如按大区、子公司划分）。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField label={t("部门名称")} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} data-testid="d-name" autoComplete="off" />
            </FormField>

            <FormField
              label={t("部门编码")}
              error={fe(errs.code?.message)}
              required={!isEdit}
              hint={
                isEdit
                  ? t('编码创建后不可修改 —— 配置、数据权限规则和外部系统都按它引用这个部门。')
                  : t('给代码和外部系统用的稳定标识，如 FIN、TECH_DEV。大写字母开头。')
              }
            >
              <Input
                {...form.register('code')}
                data-testid="d-code"
                autoComplete="off"
                disabled={isEdit}
                placeholder={isEdit ? undefined : 'FIN'}
                className="font-mono uppercase"
              />
            </FormField>

            <FormField label={t("上级部门")} error={fe(errs.parent_id?.message)}>
              <Select
                value={form.watch('parent_id') || ROOT}
                items={parentItems}
                onValueChange={(v) => form.setValue('parent_id', v ?? undefined, { shouldValidate: true })}
              >
                <SelectTrigger className="w-full" data-testid="d-parent"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT}>{t('顶级部门')}</SelectItem>
                  {parents.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label={t("负责人")} error={fe(errs.leader?.message)}>
                <Input {...form.register('leader')} data-testid="d-leader" autoComplete="off" />
              </FormField>
              <FormField label={t("排序")} error={fe(errs.sort?.message)}>
                <Input type="number" min={0} {...form.register('sort')} data-testid="d-sort" />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField label={t("联系电话")} error={fe(errs.phone?.message)}>
                <Input {...form.register('phone')} data-testid="d-phone" autoComplete="off" />
              </FormField>
              <FormField label={t("邮箱")} error={fe(errs.email?.message)}>
                <Input {...form.register('email')} data-testid="d-email" autoComplete="off" />
              </FormField>
            </div>

            <FormField label={t("状态")} error={fe(errs.status?.message)} required>
              <Select
                value={String(form.watch('status'))}
                items={statusItems}
                onValueChange={(v) => form.setValue('status', Number(v), { shouldValidate: true })}
              >
                <SelectTrigger className="w-full" data-testid="d-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('正常')}</SelectItem>
                  <SelectItem value="0">{t('停用')}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            {serverError && <p className="text-sm text-destructive" data-testid="form-error">{serverError}</p>}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="d-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建部门')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}


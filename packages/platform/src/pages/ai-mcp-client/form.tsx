import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
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
import { splitList, useCreateMcpClient, useUpdateMcpClient, type IssuedToken, type McpClient } from './api'

const schema = z.object({
  // 和后端 `schema/mcp_client.py: CLIENT_ID_PATTERN` 同一个格式（这里只为当场报错，后端才是权威）
  client_id: z
    .string()
    .min(1, '请输入凭据标识')
    .max(48, '凭据标识不能超过 48 个字符')
    .regex(/^[a-z0-9][a-z0-9_-]*$/, '只能用小写字母、数字、- 和 _，且以字母或数字开头'),
  name: z.string().min(1, '请输入名称').max(64, '名称不能超过 64 个字符'),
  act_as: z.string().refine((v) => splitList(v).length > 0, '至少填一个可代表的用户名'),
  allow_superuser: z.boolean(),
  allow_write: z.boolean(),
  tools: z.string().optional(),
  rate_per_minute: z.string().regex(/^\d*$/, '请输入正整数').optional(),
  status: z.boolean(),
  remark: z.string().optional(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = {
  client_id: '',
  name: '',
  act_as: '',
  allow_superuser: false,
  allow_write: false,
  tools: '',
  rate_per_minute: '',
  status: true,
  remark: '',
}

export function McpClientFormSheet({
  open,
  onOpenChange,
  editing,
  onIssued,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: McpClient | null
  /** 新建成功后把明文令牌交给页面去弹「只显示一次」的窗口 */
  onIssued: (issued: IssuedToken) => void
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateMcpClient()
  const update = useUpdateMcpClient()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            client_id: editing.client_id,
            name: editing.name,
            act_as: editing.act_as.join('\n'),
            allow_superuser: editing.allow_superuser,
            allow_write: editing.allow_write,
            tools: (editing.tools ?? []).join('\n'),
            rate_per_minute: editing.rate_per_minute === null ? '' : String(editing.rate_per_minute),
            status: editing.status === 1,
            remark: editing.remark ?? '',
          }
        : EMPTY,
    )
  }, [open, editing, form])

  async function onSubmit(v: Values) {
    setServerError(null)
    const tools = splitList(v.tools ?? '')
    const body = {
      name: v.name.trim(),
      act_as: splitList(v.act_as),
      allow_superuser: v.allow_superuser,
      allow_write: v.allow_write,
      // 空 = 不限。**不要传 []**：空白名单在语义上是「一个工具都不许用」，和「不限」正好相反
      tools: tools.length ? tools : null,
      rate_per_minute: v.rate_per_minute ? Number(v.rate_per_minute) : null,
      status: v.status ? 1 : 0,
      remark: v.remark?.trim() || null,
    }
    try {
      if (isEdit && editing) {
        await update.mutateAsync({ id: editing.id, body })
      } else {
        onIssued(await create.mutateAsync({ ...body, client_id: v.client_id }))
      }
      onOpenChange(false)
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const errs = form.formState.errors
  const pending = create.isPending || update.isPending

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑 MCP 凭据') : t('新建 MCP 凭据')}</SheetTitle>
          <SheetDescription>
            {t('外部系统用它调用 AI 工具（只读）。每次调用都以请求头里声明的用户身份执行，只能看到那个人有权限的数据。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField
              label={t('凭据标识')}
              error={fe(errs.client_id?.message)}
              required
              hint={t('审计里显示为 mcp:<标识>，建好后不能改')}
            >
              <Input {...form.register('client_id')} autoComplete="off" disabled={isEdit} placeholder="pis-agent" />
            </FormField>

            <FormField label={t('名称')} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} autoComplete="off" maxLength={64} />
            </FormField>

            <FormField
              label={t('可代表的用户')}
              error={fe(errs.act_as?.message)}
              required
              hint={t('每行一个用户名；填 * 表示任何普通用户。用户名不存在会保存失败')}
            >
              <Textarea {...form.register('act_as')} rows={3} className="font-mono text-xs" />
            </FormField>

            <FormField
              label={t('允许代表超级管理员')}
              hint={t('超管绕过所有权限码和数据范围：凭据一旦泄露就是整个系统。没有明确需要不要打开')}
            >
              <Switch
                checked={form.watch('allow_superuser')}
                onCheckedChange={(c) => form.setValue('allow_superuser', c, { shouldDirty: true })}
              />
            </FormField>

            <FormField
              label={t('允许写操作')}
              hint={t('外部系统可以发起写操作，但不会直接执行：每次都要被代表的人本人登录网页点确认')}
            >
              <Switch
                checked={form.watch('allow_write')}
                onCheckedChange={(c) => form.setValue('allow_write', c, { shouldDirty: true })}
              />
            </FormField>

            <FormField
              label={t('工具白名单')}
              error={fe(errs.tools?.message)}
              hint={t('每行一个工具名；留空表示不限。只能收窄，被代表的人没权限的工具照样调不到')}
            >
              <Textarea {...form.register('tools')} rows={3} className="font-mono text-xs" placeholder="dept_list" />
            </FormField>

            <FormField
              label={t('每分钟请求上限')}
              error={fe(errs.rate_per_minute?.message)}
              hint={t('留空使用全局默认（AI_MCP_RATE_PER_MINUTE）')}
            >
              <Input {...form.register('rate_per_minute')} inputMode="numeric" autoComplete="off" />
            </FormField>

            <FormField label={t('启用')} hint={t('停用后这把令牌立即失效，重新启用即恢复')}>
              <Switch
                checked={form.watch('status')}
                onCheckedChange={(c) => form.setValue('status', c, { shouldDirty: true })}
              />
            </FormField>

            <FormField label={t('备注')}>
              <Textarea {...form.register('remark')} rows={2} />
            </FormField>

            {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {isEdit ? t('保存') : t('创建并生成令牌')}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

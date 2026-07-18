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
import { RichTextEditor } from '@admin/ui/components/rich-text'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import { useRichTextImages } from '../file/rich-text-images'
import {
  NOTICE_STATUS_FORM_ITEMS, NOTICE_TYPE_FORM_ITEMS,
  useCreateNotice, useSyncNoticeImages, useUpdateNotice, type Notice,
} from './api'

const schema = z.object({
  // 后端 `sys_notice.title` 是 UniversalStr(64)，超了会被数据库截断/报错
  title: z.string().min(1, '请输入标题').max(64, '标题不能超过 64 个字符'),
  type: z.coerce.number().int(),
  status: z.coerce.number().int(),
  content: z.string().min(1, '请输入内容'),
})
type Values = z.infer<typeof schema>

export function NoticeFormSheet({
  open, onOpenChange, editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: Notice | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateNotice()
  const update = useUpdateNotice()
  const syncImages = useSyncNoticeImages()
  // 正文里的图片能力。ui 不能 import platform，所以从这里注入
  const images = useRichTextImages()
  const [serverError, setServerError] = React.useState<string | null>(null)
  // 模块级常量翻不了（加载时求值）—— 在渲染处逐个 t()
  const typeItems = React.useMemo(
    () => Object.fromEntries(Object.entries(NOTICE_TYPE_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )
  const statusItems = React.useMemo(
    () => Object.fromEntries(Object.entries(NOTICE_STATUS_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: { title: '', type: 0, status: 1, content: '' },
  })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? { title: editing.title, type: editing.type, status: editing.status, content: editing.content }
        : { title: '', type: 0, status: 1, content: '' }
    )
  }, [open, editing, form])

  const pending = create.isPending || update.isPending

  async function onSubmit(v: Values) {
    setServerError(null)
    const body = {
      title: v.title.trim(),
      type: v.type,
      status: v.status,
      content: v.content,
    }
    try {
      // 正文里的内联图要挂到 `sys_file_relation` 上，否则删掉这条公告之后
      // 那些图会永远留在磁盘和「文件管理」里，没人知道它们是谁的。
      // 新建时 id 只能等接口返回 —— 这也是把 POST 改成下发创建结果的原因
      const id = isEdit && editing ? editing.id : (await create.mutateAsync(body)).id
      if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
      // 关联同步内部吞掉自己的错误：正文已经存进库了，
      // 让它把一次成功的保存报成失败会让人再存一遍
      await syncImages(id, body.content)
      onOpenChange(false)
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const errs = form.formState.errors
  const content = form.watch('content') ?? ''

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 正文要写得开一点。基础类是 `data-[side=right]:sm:max-w-sm`，
          覆盖时**必须带同样的变体前缀**，纯 `sm:max-w-2xl` 优先级更低会失效 */}
      <SheetContent side="right" className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑通知公告') : t('新增通知公告')}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? t('修改标题、类型与正文。状态改成「隐藏」后前台不再展示。')
              : t('「通知」偏日常提醒，「公告」偏正式发布；状态控制是否对外展示。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField label={t("标题")} error={fe(errs.title?.message)} required>
              <Input {...form.register('title')} data-testid="n-title" autoComplete="off" maxLength={64} />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label={t("类型")} error={fe(errs.type?.message)} required>
                <Select
                  value={String(form.watch('type'))}
                  items={typeItems}
                  onValueChange={(v) => form.setValue('type', Number(v), { shouldDirty: true })}
                >
                  <SelectTrigger data-testid="n-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(typeItems).map(([v, label]) => (
                      <SelectItem key={v} value={v}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label={t("状态")} error={fe(errs.status?.message)} required>
                <Select
                  value={String(form.watch('status'))}
                  items={statusItems}
                  onValueChange={(v) => form.setValue('status', Number(v), { shouldDirty: true })}
                >
                  <SelectTrigger data-testid="n-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(statusItems).map(([v, label]) => (
                      <SelectItem key={v} value={v}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <FormField label={t("正文")} error={fe(errs.content?.message)} required>
              {/*
                富文本存 HTML 字符串，`content` 是 NVARCHAR(MAX)，后端不用动。
                这里不能用 form.register —— 那是给原生 input 的（要 ref + onChange 事件），
                富文本给的是「HTML 字符串」，得走受控的 watch/setValue。
              */}
              <RichTextEditor
                value={content}
                onChange={(html) => form.setValue('content', html, { shouldDirty: true, shouldValidate: true })}
                data-testid="n-content"
                minHeight="min-h-64"
                images={images}
                placeholder={t("支持标题、列表、引用、链接与图片；截图可以直接粘贴进来")}
              />
              <span className="hidden" data-testid="n-content-count">
                {t('{{n}} 字', { n: content.length })}
              </span>
            </FormField>

            {serverError && <p className="text-sm text-destructive" data-testid="form-error">{serverError}</p>}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="n-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('发布')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}


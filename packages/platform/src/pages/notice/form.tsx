import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { useQueryClient } from '@tanstack/react-query'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DateTimeValuePicker } from '@admin/ui/components/datetime-picker'
import { Input } from '@admin/ui/components/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { RichTextEditor } from '@admin/ui/components/rich-text'
import { Switch } from '@admin/ui/components/switch'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import { fileKeys } from '../file/api'
import { useRichTextImages } from '../file/rich-text-images'
import {
  NOTICE_ATTACHMENT_MAX, NOTICE_ATTACHMENT_TARGET, NOTICE_LEVEL_FORM_ITEMS, NOTICE_STATUS_FORM_ITEMS, NOTICE_TYPE_FORM_ITEMS,
  isExpired, useCreateNotice, useSyncNoticeImages, useUpdateNotice, type Notice,
} from './api'
import { NoticeAttachmentField, useNoticeAttachments } from './attachment-field'
import { toWallTime, wallTimeToIso } from './wall-time'

const schema = z.object({
  // 后端 `sys_notice.title` 是 UniversalStr(64)，超了会被数据库截断/报错
  title: z.string().min(1, '请输入标题').max(64, '标题不能超过 64 个字符'),
  type: z.coerce.number().int(),
  status: z.coerce.number().int(),
  content: z.string().min(1, '请输入内容'),
  pinned: z.boolean(),
  level: z.coerce.number().int(),
  /** 选择器给的「显示时区的墙上时间」`YYYY-MM-DD HH:mm:ss`；空 = 不过期 */
  expire_time: z.string().optional(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = { title: '', type: 0, status: 1, content: '', pinned: false, level: 0, expire_time: undefined }

function toValues(n: Notice): Values {
  return {
    title: n.title,
    type: n.type,
    status: n.status,
    content: n.content,
    pinned: n.pinned,
    level: n.level,
    // 过期时间进出都按**显示时区**（`wall-time.ts`），和列表上印出来的是同一个钟点
    expire_time: toWallTime(n.expire_time),
  }
}

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
  const qc = useQueryClient()
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
  const levelItems = React.useMemo(
    () => Object.fromEntries(Object.entries(NOTICE_LEVEL_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: EMPTY,
  })

  const attachments = useNoticeAttachments({ open, noticeId: editing?.id ?? null })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(editing ? toValues(editing) : EMPTY)
  }, [open, editing, form])

  const pending = create.isPending || update.isPending
  // 还有文件在传就不能提交：提交出去的 `attachment_ids` 里会少了它们，
  // 而广播已经随这次保存发出去了 —— 正是 #186 要堵的「读者收到通知时附件还没挂上」
  const blocked = attachments.pending > 0 || attachments.tooMany

  async function onSubmit(v: Values) {
    setServerError(null)
    if (blocked) return
    const body = {
      title: v.title.trim(),
      type: v.type,
      status: v.status,
      content: v.content,
      pinned: v.pinned,
      level: v.level,
      expire_time: wallTimeToIso(v.expire_time),
      attachment_ids: attachments.ids,
    }
    try {
      // 正文里的内联图要挂到 `sys_file_relation` 上，否则删掉这条公告之后
      // 那些图会永远留在磁盘和「文件管理」里，没人知道它们是谁的。
      // 新建时 id 只能等接口返回 —— 这也是把 POST 改成下发创建结果的原因
      const id = isEdit && editing ? editing.id : (await create.mutateAsync(body)).id
      if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
      // 附件是服务端在同一个事务里挂的，「查看」抽屉里那份附件列表的缓存跟着作废
      if (body.attachment_ids !== undefined) {
        void qc.invalidateQueries({ queryKey: fileKeys.target(NOTICE_ATTACHMENT_TARGET, id) })
      }
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
  const expireTime = form.watch('expire_time')
  const expiresInPast = isExpired(wallTimeToIso(expireTime))

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

              <FormField label={t('级别')} hint={t('「紧急」「重要」在读者列表里带醒目标签')}>
                <Select
                  value={String(form.watch('level'))}
                  items={levelItems}
                  onValueChange={(v) => form.setValue('level', Number(v), { shouldDirty: true })}
                >
                  <SelectTrigger data-testid="n-level"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(levelItems).map(([v, label]) => (
                      <SelectItem key={v} value={v}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label={t('置顶')} hint={t('置顶的排在工作台和读者列表最前面')}>
                <Switch
                  checked={form.watch('pinned')}
                  onCheckedChange={(c) => form.setValue('pinned', c, { shouldDirty: true })}
                  aria-label={t('置顶')}
                  data-testid="n-pinned"
                />
              </FormField>
            </div>

            <FormField
              label={t('过期时间')}
              hint={
                expiresInPast ? (
                  <span className="text-amber-700 dark:text-amber-300" data-testid="n-expire-past">
                    {t('这个时间已经过了 —— 保存后读者就看不到这条公告了')}
                  </span>
                ) : (
                  t('留空表示一直有效；过期后从工作台和读者列表里消失，这里照样看得到')
                )
              }
            >
              <DateTimeValuePicker
                value={expireTime}
                onChange={(v) => form.setValue('expire_time', v, { shouldDirty: true })}
                withTime
                placeholder={t('不过期')}
                aria-label={t('过期时间')}
                data-testid="n-expire"
              />
            </FormField>

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
              {/* 内联图走的是公开子树（`<img src>` 带不上鉴权头，见 rich-text 分册），
                  不登录也打得开，公告隐藏 / 删掉之后照样打得开 —— 保密的东西不能贴成图 */}
              <span className="text-xs text-muted-foreground" data-testid="n-content-public-hint">
                {t('正文里的图片是公开文件，不登录也能打开；保密材料请放进下面的附件。')}
              </span>
            </FormField>

            <FormField
              label={t('附件')}
              hint={t('最多 {{n}} 个，读者在公告详情里预览或下载。PDF、Office 文档和图片能直接预览，其余类型只能下载。', {
                n: NOTICE_ATTACHMENT_MAX,
              })}
              error={attachments.tooMany ? t('附件最多 {{n}} 个，请先移除一些', { n: NOTICE_ATTACHMENT_MAX }) : undefined}
            >
              <NoticeAttachmentField state={attachments} />
            </FormField>

            {serverError && <p className="text-sm text-destructive" data-testid="form-error">{serverError}</p>}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending || blocked} data-testid="n-submit">
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


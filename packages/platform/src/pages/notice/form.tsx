import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { useQueryClient } from '@tanstack/react-query'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { IconLoader2 } from '@tabler/icons-react'

import { toEpochMs } from '@admin/i18n'
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
import { FormField, FormSection } from '../_shared/form-fields'
import { fileKeys } from '../file/api'
import { useRichTextImages } from '../file/rich-text-images'
import {
  NOTICE_ATTACHMENT_MAX, NOTICE_ATTACHMENT_TARGET, NOTICE_LEVEL, NOTICE_LEVEL_FORM_ITEMS, NOTICE_STATUS_FORM_ITEMS,
  NOTICE_TYPE_FORM_ITEMS, isExpired, isScheduled, useCreateNotice, useSyncNoticeImages, useUpdateNotice, type Notice, type NoticeBody,
} from './api'
import { NoticeAttachmentField, useNoticeAttachments } from './attachment-field'
import {
  AUDIENCE_ALL, NoticeAudienceField, audienceDraftOf, audienceEntriesOf, audienceIsEmpty, sameAudience,
  type AudienceDraft,
} from './audience-field'
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
  /** 登录后弹窗（#190） */
  popup: z.boolean(),
  /** 必须点「我已阅读」—— 只在弹窗开着时可选（后端：反过来 422） */
  require_ack: z.boolean(),
  /** 定时发布，同过期时间一样是显示时区的墙上时间；空 = 保存即发布 */
  publish_time: z.string().optional(),
  /** 登录页可见。和发布范围互斥（后端 422） */
  public: z.boolean(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = {
  title: '', type: 0, status: 1, content: '', pinned: false, level: 0, expire_time: undefined,
  popup: false, require_ack: false, publish_time: undefined, public: false,
}

function toValues(n: Notice): Values {
  return {
    title: n.title,
    type: n.type,
    status: n.status,
    content: n.content,
    pinned: n.pinned,
    level: n.level,
    // 过期时间 / 发布时间进出都按**显示时区**（`wall-time.ts`），和列表上印出来的是同一个钟点
    expire_time: toWallTime(n.expire_time),
    popup: n.popup,
    require_ack: n.require_ack,
    publish_time: toWallTime(n.publish_time),
    public: n.public,
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

  // 发布范围不进 zod：它是三组 ID 加一个模式，校验规则（「指定」至少选一个）在提交时判
  const initialAudience = React.useMemo(() => (editing ? audienceDraftOf(editing.audience ?? []) : AUDIENCE_ALL), [editing])
  const [audience, setAudience] = React.useState<AudienceDraft>(initialAudience)
  const [audienceError, setAudienceError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    setAudienceError(null)
    setAudience(initialAudience)
    form.reset(editing ? toValues(editing) : EMPTY)
  }, [open, editing, form, initialAudience])

  const pending = create.isPending || update.isPending
  // 还有文件在传就不能提交：提交出去的 `attachment_ids` 里会少了它们，
  // 而广播已经随这次保存发出去了 —— 正是 #186 要堵的「读者收到通知时附件还没挂上」
  const blocked = attachments.pending > 0 || attachments.tooMany

  async function onSubmit(v: Values) {
    setServerError(null)
    setAudienceError(null)
    if (blocked) return
    // 🔴 「指定」一个都没选时不能发：`[]` 在契约里是「全员」，会把一条想定向的公告悄悄发给所有人
    if (audienceIsEmpty(audience)) {
      setAudienceError(t('请至少选一个部门、角色或人员；要发给所有人请选「全员」'))
      return
    }
    const body: NoticeBody = {
      title: v.title.trim(),
      type: v.type,
      status: v.status,
      content: v.content,
      pinned: v.pinned,
      level: v.level,
      expire_time: wallTimeToIso(v.expire_time),
      popup: v.popup,
      // 两个开关的约束在界面上已经拦了（弹窗关着时「必须确认」禁用、有范围时「登录页可见」禁用），
      // 这里再收一道，不把一个注定 422 的组合发出去
      require_ack: v.popup && v.require_ack,
      publish_time: wallTimeToIso(v.publish_time),
      public: audience.mode === 'all' && v.public,
      attachment_ids: attachments.ids,
      // 编辑时没动过范围就不发（`undefined` = 不改）—— 范围里点过的对象后来被删了的话，原样发回去会整条 400
      ...(isEdit && sameAudience(audience, initialAudience) ? {} : { audience: audienceEntriesOf(audience) }),
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
      // 后端的 422（必须确认却不弹窗 / 登录页可见却限定了范围）和 400（范围里有不存在的对象、附件不合格）
      // 都只有一句话、没有字段位置 —— 放在提交按钮上方，原文照登（后端已按界面语言翻好）
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const errs = form.formState.errors
  const content = form.watch('content') ?? ''
  const expireTime = form.watch('expire_time')
  const expiresInPast = isExpired(wallTimeToIso(expireTime))
  const popup = form.watch('popup')
  const isPublic = form.watch('public')
  const publishTime = form.watch('publish_time')
  const publishMs = toEpochMs(wallTimeToIso(publishTime))
  const expireMs = toEpochMs(wallTimeToIso(expireTime))
  const scheduled = isScheduled(wallTimeToIso(publishTime))
  // 已经发出去的（显示中，没定时或定时已过）改成未来的时间 = 先撤回、到点再发（后端 `_align_inbox`）——
  // 读者那边是「这条公告不见了」，发的人得事先知道
  const wasPublished = editing !== null && editing.status === 1 && !isScheduled(editing.publish_time)
  const unpublishes = wasPublished && scheduled
  const neverVisible = publishMs !== null && expireMs !== null && expireMs <= publishMs
  const showsBanner = form.watch('pinned') && form.watch('level') === NOTICE_LEVEL.URGENT

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
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto overflow-x-hidden px-4 py-2">
            {/* 字段从 7 个长到 13 个（#190），按「写什么 / 给谁 / 怎么推 / 什么时候」分四组 */}
            <FormSection title={t('内容')}>
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

              {showsBanner && (
                // 横幅的条件是后端定的（置顶 + 紧急 + 没读），不是一个单独的开关 —— 告诉人他刚刚打开了它
                <p className="text-xs text-muted-foreground" data-testid="n-banner-hint">
                  {t('置顶 + 紧急：读者的顶栏下面会出一条横幅，直到他点开或点「知道了」。')}
                </p>
              )}

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
                    不登录也打得开，公告隐藏 / 删掉之后照样打得开 —— 保密的东西不能贴成图。
                    #190 起附件还受发布范围约束，内联图不受 */}
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
            </FormSection>

            <FormSection title={t('发布范围')}>
              <NoticeAudienceField
                value={audience}
                onChange={(next) => {
                  setAudience(next)
                  setAudienceError(null)
                }}
                known={editing?.audience ?? []}
                lockedToAll={isPublic}
                error={audienceError ?? undefined}
              />
            </FormSection>

            <FormSection title={t('触达方式')}>
              <div className="grid grid-cols-2 gap-4">
                <FormField label={t('登录后弹窗')} hint={t('读者登录后（或在线时刚发出）弹出来，一次一条')}>
                  <Switch
                    checked={popup}
                    onCheckedChange={(c) => {
                      form.setValue('popup', c, { shouldDirty: true })
                      // 「必须确认」只在弹窗里有出口：关掉弹窗就一起关掉（后端：反过来 422）
                      if (!c) form.setValue('require_ack', false, { shouldDirty: true })
                    }}
                    aria-label={t('登录后弹窗')}
                    data-testid="n-popup"
                  />
                </FormField>

                <FormField
                  label={t('必须确认')}
                  hint={
                    popup
                      ? t('弹窗只能点「我已阅读」关掉；新来的人也要点（不按建号时间算已读）')
                      : t('先打开「登录后弹窗」：必须确认要有一个弹出来让人点的地方')
                  }
                >
                  <Switch
                    checked={form.watch('require_ack')}
                    disabled={!popup}
                    onCheckedChange={(c) => form.setValue('require_ack', c, { shouldDirty: true })}
                    aria-label={t('必须确认')}
                    data-testid="n-require-ack"
                  />
                </FormField>

                <FormField
                  label={t('登录页可见')}
                  className="col-span-2"
                  hint={
                    audience.mode === 'some'
                      ? t('限定了发布范围就不能放到登录页：不登录的人都看得到。要放登录页，先把范围改回「全员」。')
                      : t('不用登录就能在登录页看到标题和一段纯文本摘要（正文里的图和附件不会出去）')
                  }
                >
                  <Switch
                    checked={isPublic}
                    disabled={audience.mode === 'some'}
                    onCheckedChange={(c) => form.setValue('public', c, { shouldDirty: true })}
                    aria-label={t('登录页可见')}
                    data-testid="n-public"
                  />
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t('时间')}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label={t('定时发布')}
                  hint={
                    unpublishes ? (
                      <span className="text-amber-700 dark:text-amber-300" data-testid="n-publish-unpublish">
                        {t('这条已经发出去了：改成未来的时间会先撤回，到点再重新发出')}
                      </span>
                    ) : scheduled ? (
                      t('到点之前读者看不到、也不进收件箱；到点后自动发出（每分钟检查一次）')
                    ) : publishMs !== null ? (
                      t('这个时间已经过了 —— 保存后立即发布')
                    ) : (
                      t('留空表示保存后立即发布')
                    )
                  }
                >
                  <DateTimeValuePicker
                    value={publishTime}
                    onChange={(v) => form.setValue('publish_time', v, { shouldDirty: true })}
                    withTime
                    placeholder={t('立即发布')}
                    aria-label={t('定时发布')}
                    data-testid="n-publish"
                  />
                </FormField>

                <FormField
                  label={t('过期时间')}
                  hint={
                    neverVisible ? (
                      <span className="text-amber-700 dark:text-amber-300" data-testid="n-expire-before-publish">
                        {t('过期时间不晚于发布时间 —— 这条公告不会有人看到')}
                      </span>
                    ) : expiresInPast ? (
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
              </div>
            </FormSection>

            {serverError && <p className="text-sm text-destructive" data-testid="form-error">{serverError}</p>}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending || blocked} data-testid="n-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : scheduled ? t('定时发布') : t('发布')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

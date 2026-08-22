import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { useQuery } from '@tanstack/react-query'
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
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField, FormSection } from '../_shared/form-fields'
import { CronBuilder } from './cron-builder'
import {
  INTERVAL_PERIOD_ITEMS, SCHEDULER_TYPE_FORM_ITEMS,
  schedulerMetaQuery, useCreateScheduler, useUpdateScheduler, type TaskScheduler,
} from './api'

/**
 * 🔴 校验和后端 `schema/scheduler.py` 是**同一套规则的两份实现**，前端这份
 * 只为当场报错，**后端才是权威**（同部门/角色编码那条）。
 *
 * 为什么值得写两遍：配错的调度不像配错的筛选条件——它会**自己跑**。
 * 让用户点了保存、等一个来回、再看到红字，不如在他离开输入框时就说。
 */
const schema = z
  .object({
    name: z.string().min(1, '请输入任务名称').max(64, '名称不能超过 64 个字符'),
    task: z.string().min(1, '请选择要执行的任务'),
    type: z.coerce.number().int(),
    crontab: z.string().default('* * * * *'),
    interval_every: z.coerce.number().int().positive().nullable().optional(),
    interval_period: z.string().nullable().optional(),
    kwargs: z.string().nullable().optional(),
    one_off: z.boolean().default(false),
    enabled: z.boolean().default(true),
    remark: z.string().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 1) {
      // 只校验**段数**：`*/5`、`mon-fri` 这些各有规矩，手写正则一定漏，
      // 而漏掉的结果是「存进去了但永远不触发」。取值范围交给后端（它用
      // celery 自己的 crontab 解析，那份才是运行时真正用的）
      if ((v.crontab ?? '').trim().split(/\s+/).length !== 5) {
        ctx.addIssue({ code: 'custom', path: ['crontab'], message: 'Crontab 必须是 5 段（分 时 日 月 周）' })
      }
    } else if (!v.interval_every || !v.interval_period) {
      ctx.addIssue({ code: 'custom', path: ['interval_every'], message: '间隔调度要填间隔数与单位' })
    }
    if (v.kwargs) {
      try {
        const parsed = JSON.parse(v.kwargs)
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          ctx.addIssue({ code: 'custom', path: ['kwargs'], message: '参数必须是 JSON 对象，例如 {"days": 30}' })
        }
      } catch {
        ctx.addIssue({ code: 'custom', path: ['kwargs'], message: '参数不是合法 JSON' })
      }
    }
  })

type Values = z.infer<typeof schema>

const EMPTY: Values = {
  name: '', task: '', type: 1, crontab: '* * * * *',
  interval_every: null, interval_period: 'minutes',
  kwargs: '', one_off: false, enabled: true, remark: '',
}

export function SchedulerFormSheet({
  open, onOpenChange, editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: TaskScheduler | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateScheduler()
  const update = useUpdateScheduler()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const { data: meta } = useQuery(schedulerMetaQuery())
  const tasks = meta?.tasks ?? []

  const typeItems = React.useMemo(
    () => Object.fromEntries(Object.entries(SCHEDULER_TYPE_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )
  const periodItems = React.useMemo(
    () => Object.fromEntries(Object.entries(INTERVAL_PERIOD_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )
  const taskItems = React.useMemo(() => Object.fromEntries(tasks.map((n) => [n, n])), [tasks])

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: EMPTY,
  })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            task: editing.task,
            type: editing.type,
            crontab: editing.crontab || '* * * * *',
            interval_every: editing.interval_every,
            interval_period: editing.interval_period ?? 'minutes',
            kwargs: editing.kwargs ?? '',
            one_off: editing.one_off,
            enabled: editing.enabled,
            remark: editing.remark ?? '',
          }
        : EMPTY
    )
  }, [open, editing, form])

  const pending = create.isPending || update.isPending
  const type = form.watch('type')
  const errs = form.formState.errors

  async function onSubmit(v: Values) {
    setServerError(null)
    const body = {
      name: v.name.trim(),
      task: v.task,
      type: v.type,
      // 后端按 type 只看对应那一组，另一组传了也不用；但传 null 比传上一次的
      // 残留值干净 —— 否则从「定时」切到「间隔」再存，库里会留着一条对不上的 crontab
      crontab: v.type === 1 ? v.crontab.trim() : '* * * * *',
      interval_every: v.type === 0 ? (v.interval_every ?? null) : null,
      interval_period: v.type === 0 ? (v.interval_period ?? null) : null,
      kwargs: v.kwargs?.trim() || null,
      one_off: v.one_off,
      enabled: v.enabled,
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 覆盖抽屉宽度**必须带同样的变体前缀** —— 基础类是
          `data-[side=right]:sm:max-w-sm`，纯 `sm:max-w-xl` 优先级更低会失效 */}
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑任务调度') : t('新增任务调度')}</SheetTitle>
          <SheetDescription>
            {t('调度改完立刻生效，不用重启 —— beat 会在下一拍重新载入。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-4 py-2">
            <FormSection title={t('基本信息')}>
              <FormField label={t('任务名称')} error={fe(errs.name?.message)} required>
                <Input {...form.register('name')} data-testid="s-name" autoComplete="off" maxLength={64} />
              </FormField>

              <FormField label={t('Celery 任务')} error={fe(errs.task?.message)} required>
                {/* 🔴 只能选不能敲。打错一个字就是「调度按时触发、worker 收到
                    不认识的名字」—— celery 只记一条 Received unregistered task，
                    而界面上「累计触发」照涨，看起来一切正常 */}
                <Select
                  value={form.watch('task')}
                  items={taskItems}
                  onValueChange={(v) => v && form.setValue('task', v, { shouldDirty: true })}
                >
                  <SelectTrigger data-testid="s-task"><SelectValue placeholder={t('请选择')} /></SelectTrigger>
                  <SelectContent>
                    {tasks.map((n) => (
                      <SelectItem key={n} value={n} className="font-mono text-xs">{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </FormSection>

            <FormSection title={t('触发策略')}>
              <FormField label={t('调度类型')} required>
                <Select
                  value={String(type)}
                  items={typeItems}
                  onValueChange={(v) => v && form.setValue('type', Number(v), { shouldDirty: true })}
                >
                  <SelectTrigger data-testid="s-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(typeItems).map(([v, label]) => (
                      <SelectItem key={v} value={v}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {type === 1 ? (
                <FormField label={t('Crontab 表达式')} error={fe(errs.crontab?.message)} required>
                  <CronBuilder
                    value={form.watch('crontab') ?? ''}
                    onChange={(v) => form.setValue('crontab', v, { shouldDirty: true })}
                    invalid={Boolean(errs.crontab)}
                    timeZone={meta?.timezone ?? 'UTC'}
                  />
                </FormField>
              ) : (
                <FormField label={t('执行间隔')} error={fe(errs.interval_every?.message)} required>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      data-testid="s-interval-every"
                      className="w-28"
                      {...form.register('interval_every')}
                    />
                    <Select
                      value={form.watch('interval_period') ?? 'minutes'}
                      items={periodItems}
                      onValueChange={(v) => v && form.setValue('interval_period', v, { shouldDirty: true })}
                    >
                      <SelectTrigger className="w-28" data-testid="s-interval-period">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(periodItems).map(([v, label]) => (
                          <SelectItem key={v} value={v}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </FormField>
              )}

              <FormField
                label={t('只运行一次')}
                hint={t('触发过一次就不再触发；记录会保留，不会自动删除。')}
              >
                <Switch
                  checked={form.watch('one_off')}
                  data-testid="s-one-off"
                  onCheckedChange={(c) => form.setValue('one_off', c, { shouldDirty: true })}
                />
              </FormField>

              <FormField label={t('启用')}>
                <Switch
                  checked={form.watch('enabled')}
                  data-testid="s-enabled"
                  onCheckedChange={(c) => form.setValue('enabled', c, { shouldDirty: true })}
                />
              </FormField>
            </FormSection>

            <FormSection title={t('高级')}>
              <FormField
                label={t('关键字参数')}
                error={fe(errs.kwargs?.message)}
                hint={t('JSON 对象，例如 {"days": 30}。留空表示不传参数。')}
              >
                <Textarea
                  {...form.register('kwargs')}
                  data-testid="s-kwargs"
                  rows={3}
                  className="font-mono text-xs"
                  placeholder='{"days": 30}'
                />
              </FormField>

              <FormField label={t('备注')}>
                <Textarea {...form.register('remark')} data-testid="s-remark" rows={2} />
              </FormField>
            </FormSection>

            {serverError && (
              <p className="text-sm text-destructive" data-testid="s-server-error">{serverError}</p>
            )}
          </div>

          <SheetFooter>
            <SheetClose render={<Button type="button" variant="outline" />}>{t('取消')}</SheetClose>
            <Button type="submit" disabled={pending} data-testid="s-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

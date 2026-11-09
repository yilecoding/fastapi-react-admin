import { IconArrowRight } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { cn } from '@admin/ui/lib/utils'

import { StatusPill, type Tone } from '../status'
import type { DataChange, DataChangeAction, DataChangeItem, DataChangeMember } from './api'

export const ACTION_TONE: Record<DataChangeAction, Tone> = {
  create: 'success',
  update: 'info',
  delete: 'danger',
  bulk: 'warning',
}

/** 和后端 `registry.ACTIONS` 同一份中文（那边下发给筛选下拉，这边给行内的标签）。
 *  不用「新建 / 修改 / 删除」：那是按钮上的动词（New / Edit / Delete），一个 key 只能有一个意思 */
export const ACTION_LABEL: Record<DataChangeAction, string> = {
  create: '已新建',
  update: '已修改',
  delete: '已删除',
  bulk: '已批量修改',
}

export function ActionPill({ action }: { action: DataChangeAction }) {
  const { t } = useTranslation()
  return <StatusPill tone={ACTION_TONE[action] ?? 'muted'}>{t(ACTION_LABEL[action] ?? action)}</StatusPill>
}

/** 后端下发的时间都是带偏移的 ISO 8601（`phone_verified_time` 这类列） */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function Value({ value, label }: { value: unknown; label?: string }) {
  const { t } = useTranslation()
  if (label != null) {
    // 取值的中文名（状态「正常」）是仓库里写的 → t() 翻得了；引用的名字（部门名）是业务数据 → 原样
    return (
      <span className="font-medium" title={value == null ? undefined : String(value)}>
        {t(label)}
      </span>
    )
  }
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground italic">{t('空')}</span>
  }
  if (typeof value === 'boolean') return <span className="font-medium">{t(value ? '是' : '否')}</span>
  if (typeof value === 'string' && ISO_TIME.test(value)) {
    return <span className="font-mono text-xs tabular-nums">{formatDateTime(value)}</span>
  }
  const text = String(value)
  return (
    <span className="max-w-full truncate font-medium break-all" title={text.length > 40 ? text : undefined}>
      {text}
    </span>
  )
}

function Members({ items, kind }: { items: DataChangeMember[]; kind: 'added' | 'removed' }) {
  return (
    <>
      {items.map((m) => (
        <span
          key={`${kind}-${m.id}`}
          title={String(m.id)}
          className={cn(
            'inline-flex items-center rounded px-1.5 py-0.5 text-xs ring-1',
            kind === 'added'
              ? 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300'
              : 'bg-destructive/10 text-destructive ring-destructive/25 line-through'
          )}
        >
          {kind === 'added' ? '+' : '−'} {m.label ?? m.id}
        </span>
      ))}
    </>
  )
}

function ChangeValue({ change, created }: { change: DataChangeItem; created: boolean }) {
  const { t } = useTranslation()
  if (change.secret) {
    return <span className="text-muted-foreground">{t('已修改（不记录内容）')}</span>
  }
  if (change.added || change.removed) {
    return (
      <span className="flex flex-wrap gap-1">
        <Members items={change.added ?? []} kind="added" />
        <Members items={change.removed ?? []} kind="removed" />
      </span>
    )
  }
  if (created) return <Value value={change.new} label={change.new_label} />
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="min-w-0 text-muted-foreground line-through decoration-muted-foreground/40">
        <Value value={change.old} label={change.old_label} />
      </span>
      <IconArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('改成')} />
      <Value value={change.new} label={change.new_label} />
    </span>
  )
}

/** 一条变更记录里的字段变化：旧值 → 新值，集合字段是 +/− 标签，敏感字段只说「改过」 */
export function ChangeList({ record, className }: { record: DataChange; className?: string }) {
  const { t } = useTranslation()
  const changes = record.changes ?? []
  if (record.action === 'delete' && changes.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>{t('删除了这个对象')}</p>
  }
  const created = record.action === 'create' || record.action === 'bulk'
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {record.action === 'bulk' && (
        <p className="text-sm text-muted-foreground">
          {t('一条语句改了 {{n}} 行，只记改成了什么', { n: record.entity_label ?? '?' })}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 text-sm">
        {changes.map((c) => (
          <div key={c.field} className="contents" data-testid={`change-field-${c.field}`}>
            <dt className="text-muted-foreground">{t(c.label)}</dt>
            <dd className="min-w-0">
              <ChangeValue change={c} created={created} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

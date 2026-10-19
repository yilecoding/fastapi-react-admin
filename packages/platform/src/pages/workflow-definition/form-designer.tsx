import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconAlignLeft, IconArrowDown, IconArrowUp, IconCalendar, IconCalendarEvent, IconCash, IconCircleDot,
  IconForms, IconHash, IconInfoCircle, IconListCheck, IconPaperclip, IconPlus, IconSitemap, IconTable,
  IconTrash, IconUser,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'
import { cn } from '@admin/ui/lib/utils'

import { ConfirmDialog } from '../../shell/confirm-dialog'
import { FormField as Row } from '../_shared/form-fields'
import type { Calc, Cond, FieldType, FormField, FormSchema } from '../workflow/api'
import { newId } from '../workflow/flow-edit'
import { FormRenderer } from '../workflow/form-renderer'
import { LeafEditor, OPS_BY_TYPE, type Leaf } from './flow-designer'

export const FIELD_TYPES: { type: FieldType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { type: 'text', label: '单行文本', icon: IconForms },
  { type: 'textarea', label: '多行文本', icon: IconAlignLeft },
  { type: 'number', label: '数字', icon: IconHash },
  { type: 'amount', label: '金额', icon: IconCash },
  { type: 'date', label: '日期', icon: IconCalendar },
  { type: 'daterange', label: '日期区间', icon: IconCalendarEvent },
  { type: 'select', label: '单选', icon: IconCircleDot },
  { type: 'multiselect', label: '多选', icon: IconListCheck },
  { type: 'user', label: '人员', icon: IconUser },
  { type: 'dept', label: '部门', icon: IconSitemap },
  { type: 'table', label: '明细表', icon: IconTable },
  { type: 'attachment', label: '附件', icon: IconPaperclip },
  { type: 'description', label: '说明文字', icon: IconInfoCircle },
]

const PALETTE_GROUPS: { label: string; types: FieldType[] }[] = [
  { label: '文本与数字', types: ['text', 'textarea', 'number', 'amount'] },
  { label: '日期与选项', types: ['date', 'daterange', 'select', 'multiselect'] },
  { label: '人员与组织', types: ['user', 'dept'] },
  { label: '其他', types: ['table', 'attachment', 'description'] },
]

/** 明细表里能放的列（与后端 `COLUMN_TYPES` 一致，不能 table 套 table） */
const COLUMN_TYPES: FieldType[] = ['text', 'textarea', 'number', 'amount', 'date', 'select']

function blankField(type: FieldType, label: string): FormField {
  const f: FormField = { id: newId('f'), type, label, required: false }
  if (type === 'select' || type === 'multiselect') f.options = [{ label: '选项 1', value: 'opt1' }, { label: '选项 2', value: 'opt2' }]
  if (type === 'amount') f.precision = 2
  if (type === 'table') f.columns = [{ id: newId('c'), type: 'text', label: '项目', required: true }]
  if (type === 'description') f.content = '在这里写给填写人的说明'
  return f
}

/**
 * 表单设计器（#107 设计 6.5）。
 *
 * 字段 ID 是生成的、**不随标签变** —— 条件分支、字段权限、历史数据都按 ID 引用。
 * 排序用上 / 下按钮而不是拖拽：`@dnd-kit` 只是 `packages/ui` 的依赖，platform 要用就得
 * 在 `package.json` 里声明（根 CLAUDE.md 那条「依赖关系必须写进 package.json」），
 * 一版先不为它加依赖。
 *
 * 删字段时如果流程里有条件 / 审批人规则在用它，要先提示 —— 删了发布校验会报
 * `CONDITION_VAR_UNKNOWN`，但那时用户已经不知道是哪一步删的了。
 */
export function FormDesigner({
  form,
  onChange,
  selected,
  onSelect,
  usedByFlow,
  issueFields,
}: {
  form: FormSchema
  onChange: (f: FormSchema) => void
  selected: string | null
  onSelect: (id: string | null) => void
  usedByFlow: Set<string>
  issueFields: Set<string>
}) {
  const { t } = useTranslation()
  const [preview, setPreview] = React.useState(false)
  const [previewData, setPreviewData] = React.useState<Record<string, unknown>>({})
  const fields = form.fields
  const current = fields.find((f) => f.id === selected) ?? null

  const set = (next: FormField[]) => onChange({ ...form, fields: next })
  const add = (type: FieldType, label: string) => {
    const f = blankField(type, t(label))
    set([...fields, f])
    onSelect(f.id)
  }
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= fields.length) return
    const next = [...fields]
    ;[next[i], next[j]] = [next[j], next[i]]
    set(next)
  }
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null)
  const doRemove = (id: string) => {
    set(fields.filter((f) => f.id !== id))
    if (selected === id) onSelect(null)
  }
  const remove = (id: string) => (usedByFlow.has(id) ? setConfirmRemove(id) : doRemove(id))
  const patch = (p: Partial<FormField>) => current && set(fields.map((f) => (f.id === current.id ? { ...f, ...p } : f)))

  return (
    <div className="grid min-h-[32rem] gap-4 lg:grid-cols-[11rem_minmax(0,1fr)_20rem]">
      <aside className="flex flex-col gap-4 rounded-xl border bg-card p-3 lg:sticky lg:top-4 lg:self-start" data-testid="fd-palette">
        {PALETTE_GROUPS.map((g) => (
          <div key={g.label} className="flex flex-col gap-1.5">
            <p className="px-1 text-xs font-medium text-muted-foreground">{t(g.label)}</p>
            <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
              {FIELD_TYPES.filter((x) => g.types.includes(x.type)).map((x) => (
                <button
                  key={x.type}
                  type="button"
                  onClick={() => add(x.type, x.label)}
                  className="flex items-center gap-2 rounded-md border border-transparent bg-muted/50 px-2.5 py-1.5 text-sm transition-colors hover:border-primary/40 hover:bg-primary/5"
                  data-testid={`fd-add-${x.type}`}
                >
                  <x.icon className="size-4 text-muted-foreground" />
                  {t(x.label)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </aside>

      <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/40 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{t('共 {{n}} 个字段', { n: fields.length })}</span>
          <Button variant="outline" size="sm" onClick={() => setPreview(!preview)} data-testid="fd-preview">
            {preview ? t('返回编辑') : t('预览')}
          </Button>
        </div>
        {preview ? (
          <div className="mx-auto w-full max-w-xl rounded-xl border bg-card p-5 shadow-sm">
            <FormRenderer schema={form} value={previewData} onChange={setPreviewData} mode="edit" />
          </div>
        ) : fields.length === 0 ? (
          <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-2 rounded-xl border border-dashed bg-card py-20 text-center">
            <p className="text-sm font-medium">{t('表单还是空的')}</p>
            <p className="text-xs text-muted-foreground">{t('从左边点一个控件加进来，比如「单行文本」')}</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-xl flex-col gap-1 rounded-xl border bg-card p-3 shadow-sm">
            {fields.map((f, i) => {
              const meta = FIELD_TYPES.find((x) => x.type === f.type)
              return (
                <div
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(f.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelect(f.id)}
                  className={cn(
                    'group relative flex flex-col gap-1.5 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:bg-muted/50',
                    selected === f.id && 'border-primary bg-primary/5 hover:bg-primary/5',
                    issueFields.has(f.id) && 'border-destructive'
                  )}
                  data-testid={`fd-field-${f.id}`}
                >
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="truncate font-medium">{f.label}</span>
                    {f.required && <span className="text-destructive">*</span>}
                    {usedByFlow.has(f.id) && (
                      <span className="rounded bg-emerald-500/10 px-1.5 text-[11px] leading-5 text-emerald-700 dark:text-emerald-400">
                        {t('流程在用')}
                      </span>
                    )}
                    {f.calc && (
                      <span className="rounded bg-sky-500/10 px-1.5 text-[11px] leading-5 text-sky-700 dark:text-sky-400">
                        {t('自动计算')}
                      </span>
                    )}
                    {f.visibleWhen && (
                      <span className="rounded bg-amber-500/10 px-1.5 text-[11px] leading-5 text-amber-700 dark:text-amber-400">
                        {t('按条件显示')}
                      </span>
                    )}
                    <span className="ms-auto flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      <IconBtn label={t('上移')} onClick={() => move(i, -1)} disabled={i === 0}><IconArrowUp className="size-3.5" /></IconBtn>
                      <IconBtn label={t('下移')} onClick={() => move(i, 1)} disabled={i === fields.length - 1}><IconArrowDown className="size-3.5" /></IconBtn>
                      <IconBtn label={t('删除')} onClick={() => remove(f.id)} testId={`fd-remove-${f.id}`}><IconTrash className="size-3.5" /></IconBtn>
                    </span>
                  </span>
                  {/* 只是示意它长什么样；真实效果点「预览」 */}
                  {f.type === 'description' ? (
                    <span className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{f.content}</span>
                  ) : (
                    <span
                      className={cn(
                        'flex items-center gap-2 rounded-md border border-dashed bg-background px-3 text-xs text-muted-foreground',
                        f.type === 'textarea' || f.type === 'table' ? 'h-14 items-start pt-2' : 'h-9'
                      )}
                    >
                      {meta && <meta.icon className="size-3.5 shrink-0" />}
                      {f.placeholder || t(meta?.label ?? f.type)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title={t('删除这个字段？')}
        description={t('流程里有条件或审批人规则用到了这个字段，删掉之后发布会报错。')}
        destructive
        onConfirm={() => {
          if (confirmRemove) doRemove(confirmRemove)
          setConfirmRemove(null)
        }}
      />
      <aside className="rounded-xl border bg-card p-4 lg:sticky lg:top-4 lg:self-start" data-testid="fd-props">
        {current ? (
          <FieldProps field={current} before={fields.slice(0, fields.indexOf(current))} onChange={patch} />
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('选中一个字段编辑属性')}</p>
        )}
      </aside>
    </div>
  )
}

function IconBtn({
  label, onClick, disabled, children, testId,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  testId?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      data-testid={testId}
    >
      {children}
    </Button>
  )
}

function FieldProps({
  field: f, before, onChange,
}: {
  field: FormField
  /** 排在它前面的字段：显示条件和自动计算只能引用它们（后端发布校验同一条） */
  before: FormField[]
  onChange: (p: Partial<FormField>) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t('字段 ID')}：<code className="font-mono">{f.id}</code>
      </p>
      <Row label={t('标题')} required>
        <Input value={f.label} maxLength={64} onChange={(e) => onChange({ label: e.target.value })} data-testid="fd-prop-label" />
      </Row>
      {f.type === 'description' ? (
        <Row label={t('说明内容')}>
          <Textarea rows={4} value={f.content ?? ''} onChange={(e) => onChange({ content: e.target.value })} />
        </Row>
      ) : (
        <>
          {!f.calc && (
            <label className="flex items-center justify-between text-sm">
              {t('必填')}
              <Switch checked={!!f.required} onCheckedChange={(v) => onChange({ required: v })} data-testid="fd-prop-required" />
            </label>
          )}
          {['text', 'textarea', 'number', 'amount', 'select', 'multiselect'].includes(f.type) && (
            <Row label={t('提示文字')}>
              <Input value={f.placeholder ?? ''} onChange={(e) => onChange({ placeholder: e.target.value || null })} />
            </Row>
          )}
        </>
      )}
      {f.type === 'amount' && (
        <Row label={t('小数位')}>
          <Input
            type="number"
            min={0}
            max={6}
            value={f.precision ?? 2}
            onChange={(e) => onChange({ precision: Math.max(0, Math.min(6, Number(e.target.value) || 0)) })}
          />
        </Row>
      )}
      {f.type === 'user' && (
        <label className="flex items-center justify-between text-sm">
          {t('可以选多人')}
          <Switch checked={!!f.multiple} onCheckedChange={(v) => onChange({ multiple: v })} />
        </label>
      )}
      {(f.type === 'select' || f.type === 'multiselect') && (
        <OptionsEditor options={f.options ?? []} onChange={(options) => onChange({ options })} />
      )}
      {f.type === 'table' && <ColumnsEditor columns={f.columns ?? []} onChange={(columns) => onChange({ columns })} />}
      {(f.type === 'number' || f.type === 'amount') && <CalcEditor field={f} before={before} onChange={onChange} />}
      {f.type !== 'description' && <VisibleWhenEditor field={f} before={before} onChange={onChange} />}
    </div>
  )
}

/**
 * 自动计算：天数（从日期区间）/ 合计（明细表的一列）。算出来的值服务端会重算，填了也不收 ——
 * 所以开了之后「必填」没有意义，不显示也不提交那个开关的效果
 */
function CalcEditor({
  field: f, before, onChange,
}: {
  field: FormField
  before: FormField[]
  onChange: (p: Partial<FormField>) => void
}) {
  const { t } = useTranslation()
  const ranges = before.filter((x) => x.type === 'daterange')
  const sums = before.flatMap((x) =>
    x.type === 'table'
      ? (x.columns ?? [])
          .filter((c) => c.type === 'number' || c.type === 'amount')
          .map((c) => ({ value: `sum:${x.id}:${c.id}`, label: t('「{{t}}」的「{{c}}」合计', { t: x.label, c: c.label }) }))
      : []
  )
  const options = [
    { value: '', label: t('不自动计算，由人填写') },
    // 天数是整数：只给数字字段
    ...(f.type === 'number'
      ? ranges.map((x) => ({ value: `days:${x.id}`, label: t('按「{{f}}」算天数（含首尾）', { f: x.label }) }))
      : []),
    ...sums,
  ]
  const value = !f.calc ? '' : f.calc.kind === 'days' ? `days:${f.calc.field}` : `sum:${f.calc.field}:${f.calc.column}`
  const parse = (v: string): Calc | null => {
    const [kind, field, column] = v.split(':')
    if (kind === 'days') return { kind: 'days', field }
    if (kind === 'sum') return { kind: 'sum', field, column }
    return null
  }
  return (
    <Row
      label={t('自动计算')}
      hint={options.length > 1 ? t('算出来的值只读；提交后由服务端重新算一遍') : t('前面还没有日期区间或带数字列的明细表')}
    >
      <select
        className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
        value={options.some((o) => o.value === value) ? value : ''}
        disabled={options.length === 1}
        onChange={(e) => onChange({ calc: parse(e.target.value) })}
        data-testid="fd-prop-calc"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Row>
  )
}

/** 显示条件：一层「全部满足」（同分支条件的编辑器）。只能用排在前面的字段 */
function VisibleWhenEditor({
  field: f, before, onChange,
}: {
  field: FormField
  before: FormField[]
  onChange: (p: Partial<FormField>) => void
}) {
  const { t } = useTranslation()
  const pool: FormSchema = { schemaVersion: 1, fields: before.filter((x) => x.type in OPS_BY_TYPE) }
  const when = f.visibleWhen
  const editable = !when || ('all' in when && when.all.every((c) => 'var' in c))
  const leaves = (when && 'all' in when ? when.all : []) as Leaf[]
  const setLeaves = (next: Leaf[]) => onChange({ visibleWhen: next.length ? { all: next as Cond[] } : null })
  return (
    <Row
      label={t('显示条件')}
      hint={leaves.length ? t('条件都满足时才显示；不显示时不用填，填过的值也不会保存') : t('不设置就是一直显示')}
    >
      {!editable ? (
        <p className="text-sm text-amber-700">{t('这个条件比较复杂，设计器编辑不了；保持原样不会被改动')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {leaves.map((c, i) => (
            <LeafEditor
              key={i}
              leaf={c}
              form={pool}
              builtins={false}
              testPrefix="fd-vis"
              index={i}
              onChange={(nc) => setLeaves(leaves.map((x, j) => (j === i ? nc : x)))}
              onRemove={() => setLeaves(leaves.filter((_, j) => j !== i))}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={pool.fields.length === 0}
            onClick={() => {
              const x = pool.fields[0]
              setLeaves([...leaves, { var: x.id, op: OPS_BY_TYPE[x.type][0] }])
            }}
            data-testid="fd-vis-add"
          >
            <IconPlus className="size-4" />
            {t('添加显示条件')}
          </Button>
          {pool.fields.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('前面还没有能当条件的字段（数字 / 金额 / 单选 / 人员 / 部门…）')}</p>
          )}
        </div>
      )}
    </Row>
  )
}

function OptionsEditor({
  options, onChange,
}: {
  options: { label: string; value: string }[]
  onChange: (v: { label: string; value: string }[]) => void
}) {
  const { t } = useTranslation()
  return (
    <Row label={t('选项')} hint={t('选项的值存进数据、条件按值判断 —— 已经发起过的单子里有它，就别改值，改显示名')}>
      <div className="flex flex-col gap-2">
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input
              className="h-8"
              value={o.label}
              placeholder={t('显示名')}
              onChange={(e) => onChange(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            <Input
              className="h-8 w-28 font-mono"
              value={o.value}
              placeholder={t('值')}
              onChange={(e) => onChange(options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t('删除选项')}
              onClick={() => onChange(options.filter((_, j) => j !== i))}
            >
              <IconTrash className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            // 值不能按「个数 + 1」生成：删过一个再加，新值会和剩下的某个撞上（opt1/2/3 删 opt1 再加 → 又一个 opt3），
            // 两个选项同一个值，存进去分不出来（发布校验 FIELD_OPTION_DUPLICATE 也会拦）
            const used = new Set(options.map((o) => o.value))
            let n = options.length + 1
            while (used.has(`opt${n}`)) n += 1
            onChange([...options, { label: t('选项 {{n}}', { n }), value: `opt${n}` }])
          }}
        >
          <IconPlus className="size-4" />
          {t('添加选项')}
        </Button>
      </div>
    </Row>
  )
}

function ColumnsEditor({ columns, onChange }: { columns: FormField[]; onChange: (c: FormField[]) => void }) {
  const { t } = useTranslation()
  return (
    <Row label={t('明细表的列')}>
      <div className="flex flex-col gap-2">
        {columns.map((c, i) => (
          <div key={c.id} className="flex flex-col gap-1 rounded-md border p-2">
            <div className="flex items-center gap-1">
              <Input
                className="h-8"
                value={c.label}
                onChange={(e) => onChange(columns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <select
                className="h-8 rounded-md border bg-transparent px-2 text-sm"
                value={c.type}
                onChange={(e) => {
                  const type = e.target.value as FieldType
                  onChange(columns.map((x, j) => (j === i ? { ...blankField(type, x.label), id: x.id, required: x.required } : x)))
                }}
              >
                {COLUMN_TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(FIELD_TYPES.find((x) => x.type === ty)?.label ?? ty)}</option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={t('删除列')}
                onClick={() => onChange(columns.filter((_, j) => j !== i))}
              >
                <IconTrash className="size-3.5" />
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={!!c.required}
                onCheckedChange={(v) => onChange(columns.map((x, j) => (j === i ? { ...x, required: v } : x)))}
              />
              {t('必填')}
            </label>
            {c.type === 'select' && (
              <OptionsEditor
                options={c.options ?? []}
                onChange={(options) => onChange(columns.map((x, j) => (j === i ? { ...x, options } : x)))}
              />
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => onChange([...columns, { id: newId('c'), type: 'text', label: t('新列'), required: false }])}
        >
          <IconPlus className="size-4" />
          {t('添加列')}
        </Button>
      </div>
    </Row>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [
    t('单行文本'), t('多行文本'), t('数字'), t('金额'), t('日期'), t('日期区间'), t('单选'), t('多选'),
    t('人员'), t('部门'), t('明细表'), t('附件'), t('说明文字'),
    t('文本与数字'), t('日期与选项'), t('人员与组织'), t('其他'),
  ]
}

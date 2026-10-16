import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconPlus, IconTrash } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Combobox } from '@admin/ui/components/combobox'
import { DateTimeRangePicker, DateTimeValuePicker } from '@admin/ui/components/datetime-picker'
import { Input } from '@admin/ui/components/input'
import { MultiSelect } from '@admin/ui/components/multi-select'
import { Textarea } from '@admin/ui/components/textarea'
import { cn } from '@admin/ui/lib/utils'

import { FormField as Row } from '../_shared/form-fields'
import { directoryDeptsQuery, directoryUsersQuery, type FieldPerm, type FormData, type FormField, type FormSchema } from './api'
import { DeptSelect, UserSelect } from './pickers'

/**
 * 表单渲染器：发起页、审批详情、设计器预览**三处用同一个**（#107 设计 6.5）。
 *
 * - `mode="edit"`：全部可填（发起页 / 设计器预览）
 * - `mode="view"`：全部只读；传了 `perms` 时，`editable` 的字段可改（审批人在详情页里填「人事备注」）
 *
 * 🔴 这里的字段权限**只是体验**：隐藏字段服务端已经从 schema 和数据里裁掉了，
 * 「只收可编辑字段」也是服务端拒的。前端藏起来不算权限。
 *
 * 值的形状和后端 `engine/form.py` 的表一致：金额是十进制**字符串**、人员 / 部门是 ID **字符串**。
 */
export function FormRenderer({
  schema,
  value,
  onChange,
  mode,
  perms,
  errors,
}: {
  schema: FormSchema
  value: FormData
  onChange?: (v: FormData) => void
  mode: 'edit' | 'view'
  perms?: Record<string, FieldPerm>
  errors?: Record<string, string>
}) {
  const set = (id: string, v: unknown) => onChange?.({ ...value, [id]: v })
  return (
    <div className="flex flex-col gap-4" data-testid="wf-form">
      {schema.fields.map((f) => {
        if (f.type === 'description') {
          return (
            <p key={f.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap text-muted-foreground">
              {f.content || f.label}
            </p>
          )
        }
        const editable = mode === 'edit' || perms?.[f.id] === 'editable'
        return (
          <Row key={f.id} label={f.label} required={editable && f.required} error={errors?.[f.id]}>
            <div data-testid={`wf-field-${f.id}`} data-editable={editable}>
              {editable ? (
                <FieldInput field={f} value={value[f.id]} onChange={(v) => set(f.id, v)} />
              ) : (
                <FieldDisplay field={f} value={value[f.id]} />
              )}
            </div>
          </Row>
        )
      })}
    </div>
  )
}

function empty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

function FieldInput({ field: f, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation()
  const options = React.useMemo(() => (f.options ?? []).map((o) => ({ value: o.value, label: o.label })), [f.options])
  switch (f.type) {
    case 'text':
      return <Input value={(value as string) ?? ''} placeholder={f.placeholder ?? undefined} onChange={(e) => onChange(e.target.value)} />
    case 'textarea':
      return (
        <Textarea
          value={(value as string) ?? ''}
          placeholder={f.placeholder ?? undefined}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
      return (
        <Input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={f.placeholder ?? undefined}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
    case 'amount':
      // 金额留成字符串交给后端按精度归一 —— 前端不做浮点运算
      return (
        <Input
          inputMode="decimal"
          value={(value as string) ?? ''}
          placeholder={f.placeholder ?? '0.00'}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.-]/g, ''))}
        />
      )
    case 'date':
      return <DateTimeValuePicker value={(value as string) || undefined} onChange={(v) => onChange(v ?? null)} />
    case 'daterange': {
      const v = Array.isArray(value) ? (value as [string, string]) : undefined
      return (
        <DateTimeRangePicker
          value={v}
          presets={false}
          onChange={(r) => onChange(r && r[0] && r[1] ? [r[0], r[1]] : null)}
        />
      )
    }
    case 'select':
      return (
        <Combobox
          value={(value as string) ?? null}
          onValueChange={(v) => onChange(v)}
          options={options}
          placeholder={f.placeholder ?? t('请选择')}
        />
      )
    case 'multiselect':
      return (
        <MultiSelect
          value={(value as string[]) ?? []}
          onValueChange={(v) => onChange(v)}
          options={options}
          placeholder={f.placeholder ?? t('请选择')}
        />
      )
    case 'user': {
      const ids = empty(value) ? [] : Array.isArray(value) ? (value as string[]) : [value as string]
      return (
        <UserSelect
          value={ids}
          multiple={f.multiple}
          onChange={(v) => onChange(f.multiple ? v : (v[0] ?? null))}
          testId={`wf-user-${f.id}`}
        />
      )
    }
    case 'dept':
      return <DeptSelect value={(value as string) ?? null} onChange={(v) => onChange(v)} />
    case 'table':
      return <TableInput field={f} value={(value as Record<string, unknown>[]) ?? []} onChange={onChange} />
    case 'attachment':
      return <p className="text-sm text-muted-foreground">{t('附件控件将在下一版接入文件模块')}</p>
    default:
      return null
  }
}

function TableInput({
  field: f,
  value,
  onChange,
}: {
  field: FormField
  value: Record<string, unknown>[]
  onChange: (v: unknown) => void
}) {
  const { t } = useTranslation()
  const cols = f.columns ?? []
  return (
    <div className="flex flex-col gap-2">
      {value.map((row, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border p-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('第 {{n}} 行', { n: i + 1 })}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t('删除这一行')}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <IconTrash className="size-3.5" />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {cols.map((c) => (
              <Row key={c.id} label={c.label} required={c.required}>
                <FieldInput
                  field={c}
                  value={row[c.id]}
                  onChange={(v) => onChange(value.map((r, j) => (j === i ? { ...r, [c.id]: v } : r)))}
                />
              </Row>
            ))}
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange([...value, {}])}>
        <IconPlus className="size-4" />
        {t('添加一行')}
      </Button>
    </div>
  )
}

function FieldDisplay({ field: f, value }: { field: FormField; value: unknown }) {
  const { t } = useTranslation()
  const text = 'min-h-9 py-2 text-sm whitespace-pre-wrap break-words'
  if (empty(value)) return <p className={cn(text, 'text-muted-foreground')}>—</p>
  switch (f.type) {
    case 'select':
      return <p className={text}>{f.options?.find((o) => o.value === value)?.label ?? String(value)}</p>
    case 'multiselect':
      return (
        <p className={text}>
          {(value as string[]).map((v) => f.options?.find((o) => o.value === v)?.label ?? v).join('、')}
        </p>
      )
    case 'daterange':
      return <p className={text}>{(value as string[]).join(' ~ ')}</p>
    case 'user':
      return <UserNames ids={Array.isArray(value) ? (value as string[]) : [value as string]} className={text} />
    case 'dept':
      return <DeptName id={value as string} className={text} />
    case 'table': {
      const cols = f.columns ?? []
      const rows = value as Record<string, unknown>[]
      return (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>{cols.map((c) => <th key={c.id} className="px-2 py-1.5 text-start font-medium">{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t">
                  {cols.map((c) => (
                    <td key={c.id} className="px-2 py-1.5">
                      {c.type === 'select'
                        ? (c.options?.find((o) => o.value === r[c.id])?.label ?? String(r[c.id] ?? '—'))
                        : String(r[c.id] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'attachment':
      return <p className={text}>{t('{{n}} 个附件', { n: (value as string[]).length })}</p>
    default:
      return <p className={text}>{String(value)}</p>
  }
}

export function UserNames({ ids, className }: { ids: string[]; className?: string }) {
  const { data, isPending } = useQuery({ ...directoryUsersQuery({ ids }), enabled: ids.length > 0 })
  if (isPending) return <p className={className}>…</p>
  const byId = new Map((data ?? []).map((u) => [u.id, u.nickname]))
  return <p className={className}>{ids.map((id) => byId.get(id) ?? id).join('、')}</p>
}

function DeptName({ id, className }: { id: string; className?: string }) {
  const { data } = useQuery(directoryDeptsQuery())
  return <p className={className}>{data?.find((d) => d.id === id)?.name ?? id}</p>
}

/**
 * 前端的必填检查 —— 只为当场提示，后端那份才算数（`validate_form_data`）。
 * 只查「必填但空」，格式交给后端：两边各写一套格式规则迟早对不上。
 */
export function missingRequired(schema: FormSchema, value: FormData, only?: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of schema.fields) {
    if (f.type === 'description' || !f.required) continue
    if (only && !only.has(f.id)) continue
    if (empty(value[f.id])) out[f.id] = f.label
  }
  return out
}

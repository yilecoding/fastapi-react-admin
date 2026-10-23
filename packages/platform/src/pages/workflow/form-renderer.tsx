import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2, IconPaperclip, IconPlus, IconTrash, IconUpload, IconX } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Combobox } from '@admin/ui/components/combobox'
import { DateTimeRangePicker, DateTimeValuePicker } from '@admin/ui/components/datetime-picker'
import { Input } from '@admin/ui/components/input'
import { MultiSelect } from '@admin/ui/components/multi-select'
import { Textarea } from '@admin/ui/components/textarea'
import { toast } from '@admin/ui/components/toast'
import { cn } from '@admin/ui/lib/utils'

import { api } from '../../api-client/client'
import { ApiError } from '../../api-client/errors'
import { FormField as Row } from '../_shared/form-fields'
import {
  directoryDeptsQuery, directoryUsersQuery, downloadAttachment, uploadAttachment,
  type FieldPerm, type FileMeta, type FormData, type FormField, type FormSchema,
} from './api'
import { formRules } from './form-rules'
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
 *
 * 联动（`form-rules.ts`）：显示条件不成立的字段不渲染；自动计算的字段只读，显示当场算出来的值。
 * 父组件拿到的 `value` 里不含算出来的值 —— 提交时服务端自己算，前端算的只用来看。
 */
export function FormRenderer({
  schema,
  value,
  onChange,
  mode,
  perms,
  errors,
  files,
  marks,
}: {
  schema: FormSchema
  value: FormData
  onChange?: (v: FormData) => void
  mode: 'edit' | 'view'
  perms?: Record<string, FieldPerm>
  errors?: Record<string, string>
  /** 已有附件的文件名 / 大小（详情接口带的）。新上传的由附件控件自己记着 */
  files?: Record<string, FileMeta>
  /** 字段下面挂的标记（发起页：「AI 填的，请核对」）。只挂在能填的字段上 */
  marks?: Record<string, React.ReactNode>
}) {
  const { t } = useTranslation()
  // 🔴 用最新的值合并，不用这次渲染闭包里的 `value`：附件上传是异步的，传完才回调 ——
  // 用闭包里的旧值，上传期间在别的字段里打的字会被整个盖回去（自动保存再把盖回去的存成草稿）
  const latest = React.useRef(value)
  latest.current = value
  const set = (id: string, v: unknown) => onChange?.({ ...latest.current, [id]: v })
  const ruled = React.useMemo(() => formRules(schema, value), [schema, value])
  return (
    <FilesContext.Provider value={files ?? EMPTY_FILES}>
    <div className="flex flex-col gap-4" data-testid="wf-form">
      {schema.fields.map((f) => {
        if (ruled.inactive.has(f.id)) return null
        if (f.type === 'description') {
          return (
            <p key={f.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap text-muted-foreground">
              {f.content || f.label}
            </p>
          )
        }
        // 自动计算：在「填」的人那里显示成只读框 + 提示（他知道不用填）；只是看的人就是普通的一行
        if (f.calc && (mode === 'edit' || perms?.[f.id] === 'editable')) {
          return (
            <Row key={f.id} label={f.label}>
              <div
                className={cn('flex h-9 items-center justify-between rounded-md border border-dashed bg-muted/40 px-3 text-sm', LOCATE_FLASH)}
                data-testid={`wf-field-${f.id}`}
                data-field-id={f.id}
                data-editable={false}
              >
                <span className="tabular-nums">{empty(ruled.data[f.id]) ? '—' : String(ruled.data[f.id])}</span>
                <span className="text-xs text-muted-foreground">{t('自动计算')}</span>
              </div>
            </Row>
          )
        }
        const editable = !f.calc && (mode === 'edit' || perms?.[f.id] === 'editable')
        if (!editable) {
          // 只读：标签在左、值在右的紧凑行 —— 审批人主要是在「看」，竖排会把一屏只摆三四个字段
          return (
            <div
              key={f.id}
              className={cn(
                'grid grid-cols-[minmax(5rem,8rem)_minmax(0,1fr)] items-baseline gap-3 border-b border-dashed pb-2 last:border-b-0',
                LOCATE_FLASH
              )}
              data-testid={`wf-field-${f.id}`}
              data-field-id={f.id}
              data-editable={false}
            >
              <span className="text-sm text-muted-foreground">{f.label}</span>
              <FieldDisplay field={f} value={f.calc ? ruled.data[f.id] : value[f.id]} />
            </div>
          )
        }
        return (
          <Row key={f.id} label={f.label} required={editable && f.required} error={errors?.[f.id]}>
            <div className={LOCATE_FLASH} data-testid={`wf-field-${f.id}`} data-field-id={f.id} data-editable={editable}>
              <FieldInput field={f} value={value[f.id]} onChange={(v) => set(f.id, v)} />
            </div>
            {editable && marks?.[f.id]}
          </Row>
        )
      })}
    </div>
    </FilesContext.Provider>
  )
}

/** AI 预审里点了字段名（`instance-sheet.tsx: locateField`）：外框闪一下，告诉人「就是这一个」 */
const LOCATE_FLASH =
  'rounded-sm ring-offset-background transition-shadow duration-500 data-[flash=true]:ring-2 data-[flash=true]:ring-primary/60 data-[flash=true]:ring-offset-4'

const EMPTY_FILES: Record<string, FileMeta> = {}
const FilesContext = React.createContext<Record<string, FileMeta>>(EMPTY_FILES)

export function empty(v: unknown): boolean {
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
      return <AttachmentInput ids={(value as string[]) ?? []} onChange={onChange} testId={`wf-files-${f.id}`} />
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
  const text = 'text-sm whitespace-pre-wrap break-words'
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
      return <AttachmentList ids={value as string[]} />
    default:
      return <p className={text}>{String(value)}</p>
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function AttachmentRow({ id, meta: given, onRemove }: { id: string; meta?: FileMeta; onRemove?: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)
  // 手上只有 ID（从草稿恢复的附件）：按 ID 现查一次名字。读不到（被删了 / 不是他的）才显示「已删除」
  const fallback = useQuery({
    queryKey: ['sys', 'files', 'meta', id],
    queryFn: () =>
      api
        .GET<{ original_name: string; size: number; ext: string; content_type: string | null }>(`/api/v1/sys/files/${id}`)
        .then((f): FileMeta => ({ name: f.original_name, size: f.size, ext: f.ext, content_type: f.content_type })),
    enabled: !given,
    retry: false,
    staleTime: Infinity,
  })
  const meta = given ?? fallback.data
  // 只有 404 才是「真的没了」；网络抖动 / 500 要说「没取到」并给重试（硬纪律 9），
  // 否则用户以为附件丢了、删掉重传
  const gone = fallback.error instanceof ApiError && fallback.error.httpStatus === 404
  const name =
    meta?.name ?? (fallback.isPending && !given ? '…' : gone || !fallback.error ? t('（文件已删除）') : t('（文件信息没取到）'))
  return (
    <li className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm">
      <IconPaperclip className="size-4 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-start hover:text-primary hover:underline disabled:no-underline"
        disabled={!meta || busy}
        onClick={async () => {
          if (!meta) return
          setBusy(true)
          try {
            await downloadAttachment(id, meta.name)
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : t('下载失败，请稍后重试'))
          } finally {
            setBusy(false)
          }
        }}
        title={t('下载')}
      >
        {name}
      </button>
      {meta && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtSize(meta.size)}</span>}
      {!meta && fallback.error && !gone && (
        <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => fallback.refetch()}>
          {t('重试')}
        </button>
      )}
      {busy && <IconLoader2 className="size-3.5 animate-spin text-muted-foreground" />}
      {onRemove && (
        <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('移除附件')} onClick={onRemove}>
          <IconX className="size-3.5" />
        </Button>
      )}
    </li>
  )
}

function AttachmentList({ ids }: { ids: string[] }) {
  const files = React.useContext(FilesContext)
  return (
    <ul className="flex flex-col gap-1.5">
      {ids.map((id) => <AttachmentRow key={id} id={id} meta={files[id]} />)}
    </ul>
  )
}

/** 附件上传：一次可选多个，传完立刻挂进表单值（文件 ID 字符串数组） */
function AttachmentInput({ ids, onChange, testId }: { ids: string[]; onChange: (v: unknown) => void; testId: string }) {
  const { t } = useTranslation()
  const known = React.useContext(FilesContext)
  const [uploaded, setUploaded] = React.useState<Record<string, FileMeta>>({})
  const [busy, setBusy] = React.useState(0)
  const input = React.useRef<HTMLInputElement>(null)
  // 上传是异步的，多个文件一起传完再各自回调 —— 用 ref 拿最新的值，别让后回来的覆盖先回来的
  const latest = React.useRef(ids)
  latest.current = ids

  async function pick(list: FileList | null) {
    const picked = [...(list ?? [])]
    if (input.current) input.current.value = '' // 同一个文件再选一次也要能触发 change
    for (const file of picked) {
      setBusy((n) => n + 1)
      try {
        const meta = await uploadAttachment(file)
        const id = String(meta.id)
        setUploaded((u) => ({ ...u, [id]: meta }))
        latest.current = [...latest.current, id]
        onChange(latest.current)
      } catch (e) {
        toast.error(e instanceof ApiError ? `${file.name}：${e.message}` : t('上传失败，请稍后重试'))
      } finally {
        setBusy((n) => n - 1)
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {ids.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {ids.map((id) => (
            <AttachmentRow
              key={id}
              id={id}
              meta={uploaded[id] ?? known[id]}
              onRemove={() => onChange(ids.filter((x) => x !== id))}
            />
          ))}
        </ul>
      )}
      <input ref={input} type="file" multiple hidden onChange={(e) => pick(e.target.files)} data-testid={`${testId}-input`} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={busy > 0}
        onClick={() => input.current?.click()}
      >
        {busy > 0 ? <IconLoader2 className="size-4 animate-spin" /> : <IconUpload className="size-4" />}
        {busy > 0 ? t('上传中…') : t('添加附件')}
      </Button>
    </div>
  )
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
  // 显示条件不成立的不算必填；自动计算的不归人填（同后端 validate_form_data）
  const { inactive } = formRules(schema, value)
  for (const f of schema.fields) {
    if (f.type === 'description' || !f.required || f.calc || inactive.has(f.id)) continue
    if (only && !only.has(f.id)) continue
    if (empty(value[f.id])) out[f.id] = f.label
  }
  return out
}

import * as DocumentPicker from 'expo-document-picker'
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, FlatList, Pressable, ScrollView, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { Overlay, ReadonlyValue, UserPicker } from '@/components/workflow'
import { formatBytes } from '@/lib/attachments'
import {
  uploadWorkflowFile,
  useDirectoryDepts,
  useDirectoryUsersByIds,
  useFileDetails,
  type FieldPerm,
  type FormData,
  type FormField,
  type FormSchema,
} from '@/lib/workflow'
import { formRules, isEmpty } from '@admin/api'

/**
 * 审批表单渲染器（原生版）—— 发起页、审批人可编辑字段、被退回后重新提交**三处用同一个**。
 * 口径照 web `packages/platform/src/pages/workflow/form-renderer.tsx`，控件换成手机上的：
 * 下拉 / 日期 / 选人 / 选部门都是**底部弹层**，不是 web 的下拉框。
 *
 * - `perms` 不传 = 全部可填（发起页传的是开始节点上的发起人权限，没配的当可填）
 * - `perms[id] === 'editable'` 的才是输入框，其余只读
 *
 * 🔴 这里的字段权限**只是体验**：隐藏字段服务端已经从 schema 和数据里裁掉了，
 * 「只收可编辑字段」也是服务端拒的。
 *
 * 值的形状和后端 `engine/form.py` 的表一致：日期 `YYYY-MM-DD`、日期区间 `[开始, 结束]`、
 * 金额是十进制**字符串**、人员 / 部门是 ID **字符串**（硬纪律 6）。
 *
 * 联动（`lib/workflow-form.ts`）：显示条件不成立的字段不画；自动计算的字段只读、显示当场算出来的值。
 * `onChange` 回去的值里**不含**算出来的值 —— 提交时服务端自己算。
 */
export function WorkflowForm({
  schema,
  value,
  onChange,
  perms,
  errors,
  files,
}: {
  schema: FormSchema
  value: FormData
  onChange: (v: FormData) => void
  perms?: Record<string, FieldPerm | string>
  errors?: Record<string, string>
  /** 已有附件的文件名（详情接口带的）。新上传的由附件控件自己记着 */
  files?: Record<string, { name: string }>
}) {
  const { t } = useTranslation()
  // 🔴 用最新的值合并，不用这次渲染闭包里的 `value`：附件上传是异步的，传完才回调 ——
  // 用闭包里的旧值，上传期间在别的字段里打的字会被整个盖回去（同 web）
  const latestRef = useLatest(value)
  const set = (id: string, v: unknown) => {
    const next = { ...latestRef.current, [id]: v }
    latestRef.current = next
    onChange(next)
  }
  const ruled = React.useMemo(() => formRules(schema, value), [schema, value])
  // 不传 `perms` = 全部可填（发起页）；传了的话没列出来的当只读（审批节点上没配 = 只读，同 web）
  const canEdit = (f: FormField) => !f.calc && (!perms || perms[f.id] === 'editable')
  const shown = schema.fields.filter((f) => !ruled.inactive.has(f.id))
  if (shown.length === 0) return null

  return (
    <View className="bg-card mx-4 rounded-2xl px-4 py-1" testID="wf-form">
      {shown.map((f, i) => {
        const border = i > 0 ? 'border-border border-t' : ''
        if (f.type === 'description') {
          return (
            <View key={f.id} className={`py-3 ${border}`}>
              <Text className="text-muted-foreground text-[13px] leading-5">{f.content || f.label}</Text>
            </View>
          )
        }
        const editable = canEdit(f)
        return (
          <View key={f.id} className={`gap-1.5 py-3 ${border}`} testID={`wf-field-${f.id}`}>
            <View className="flex-row items-center gap-1">
              <Text className="text-muted-foreground text-[13px]">{f.label}</Text>
              {editable && f.required ? <Text className="text-destructive text-[13px]">*</Text> : null}
              {f.calc ? <Text className="text-muted-foreground/70 ml-auto text-xs">{t('自动计算')}</Text> : null}
            </View>
            {f.calc ? (
              <Text className="text-[15px]">{isEmpty(ruled.data[f.id]) ? '—' : String(ruled.data[f.id])}</Text>
            ) : editable ? (
              <FieldInput field={f} value={value[f.id]} onChange={(v) => set(f.id, v)} files={files} />
            ) : (
              <ReadonlyValue field={f} value={value[f.id]} files={files ?? {}} />
            )}
            {errors?.[f.id] ? (
              <Text className="text-destructive text-xs" testID={`wf-error-${f.id}`}>
                {errors[f.id]}
              </Text>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

/**
 * 一个总是指向最新 props 的 ref（异步回调里读它，不读闭包）。
 * 在 layout effect 里更新 —— 渲染期写 ref 是 react-hooks/refs 禁止的；layout effect 在提交后、
 * 任何用户事件之前同步跑完，回调读到的不会比屏幕上的旧。回调自己改了值也要顺手写回去（见 `set`）。
 */
function useLatest<T>(v: T) {
  const ref = React.useRef(v)
  React.useLayoutEffect(() => {
    ref.current = v
  })
  return ref
}

/* ────────────────────────── 单个字段 ────────────────────────── */

function FieldInput({
  field: f,
  value,
  onChange,
  files,
}: {
  field: FormField
  value: unknown
  onChange: (v: unknown) => void
  files?: Record<string, { name: string }>
}) {
  const { t } = useTranslation()
  const placeholder = f.placeholder ?? undefined
  switch (f.type) {
    case 'text':
      return (
        <Input
          value={(value as string) ?? ''}
          placeholder={placeholder}
          onChangeText={onChange}
          testID={`wf-input-${f.id}`}
        />
      )
    case 'textarea':
      return (
        <Input
          value={(value as string) ?? ''}
          placeholder={placeholder}
          onChangeText={onChange}
          multiline
          textAlignVertical="top"
          className="h-24 py-2"
          testID={`wf-input-${f.id}`}
        />
      )
    case 'number':
      return <NumberInput id={f.id} value={value} placeholder={placeholder} onChange={onChange} />
    case 'amount':
      // 金额留成字符串交给后端按精度归一 —— 前端不做浮点运算（同 web）
      return (
        <Input
          value={(value as string) ?? ''}
          placeholder={placeholder ?? '0.00'}
          keyboardType="decimal-pad"
          onChangeText={(s) => onChange(s.replace(/[^\d.-]/g, ''))}
          testID={`wf-input-${f.id}`}
        />
      )
    case 'date':
      return <DateField id={f.id} mode="single" value={value} onChange={onChange} placeholder={placeholder} />
    case 'daterange':
      return <DateField id={f.id} mode="range" value={value} onChange={onChange} placeholder={placeholder} />
    case 'select':
    case 'multiselect':
      return <OptionField field={f} value={value} onChange={onChange} />
    case 'user':
      return <UserField field={f} value={value} onChange={onChange} />
    case 'dept':
      return <DeptField id={f.id} value={value} onChange={onChange} placeholder={placeholder ?? t('请选择部门')} />
    case 'table':
      return <TableInput field={f} value={(value as Record<string, unknown>[]) ?? []} onChange={onChange} />
    case 'attachment':
      return <AttachmentInput id={f.id} ids={(value as string[]) ?? []} onChange={onChange} files={files} />
    default:
      return null
  }
}

/**
 * 数字：输入框里留着**原样的字符串**，往外交的是数字。
 * 直接 `Number(text)` 回填的话，打到「1.」那一刻会被吃成「1」，小数点永远打不出来。
 */
function NumberInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string
  value: unknown
  placeholder?: string
  onChange: (v: unknown) => void
}) {
  const outer = value === undefined || value === null ? '' : String(value)
  const [text, setText] = React.useState(outer)
  const [prevOuter, setPrevOuter] = React.useState(outer)
  // 外面的值变了（清空重填）而且和输入框里的不是同一个数：跟外面走。
  // 渲染期对齐（React 文档「根据 props 调整 state」那一招），不走 effect —— 自己打字引起的变化数值相同、不会被冲掉
  if (outer !== prevOuter) {
    setPrevOuter(outer)
    if (parseNum(text) !== (outer === '' ? null : Number(outer))) setText(outer)
  }
  return (
    <Input
      value={text}
      placeholder={placeholder}
      keyboardType="numeric"
      onChangeText={(s) => {
        const clean = s.replace(/[^\d.-]/g, '')
        setText(clean)
        onChange(parseNum(clean))
      }}
      testID={`wf-input-${id}`}
    />
  )
}

function parseNum(s: string): number | null {
  if (s === '' || s === '-' || s === '.' || s === '-.') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 点开弹层的那种字段：看起来像输入框，右边一个小图标 */
function PickerBox({
  text,
  placeholder,
  icon,
  onPress,
  testID,
}: {
  text: string | null
  placeholder: string
  icon: React.ComponentProps<typeof Icon>['as']
  onPress: () => void
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className="border-input bg-background dark:bg-input/30 active:bg-muted min-h-10 flex-row items-center gap-2 rounded-md border px-3 py-2"
    >
      <Text className={`flex-1 text-base leading-5 ${text ? '' : 'text-muted-foreground/50'}`}>{text || placeholder}</Text>
      <Icon as={icon} className="text-muted-foreground size-4" />
    </Pressable>
  )
}

/* ────────────────────────── 下拉 / 多选 ────────────────────────── */

function OptionField({ field: f, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const multiple = f.type === 'multiselect'
  const options = f.options ?? []
  const picked = multiple ? ((value as string[]) ?? []) : isEmpty(value) ? [] : [value as string]
  const label = picked.map((v) => options.find((o) => o.value === v)?.label ?? v).join('、')
  return (
    <>
      <PickerBox
        text={label || null}
        placeholder={f.placeholder ?? t('请选择')}
        icon={ChevronDownIcon}
        onPress={() => setOpen(true)}
        testID={`wf-input-${f.id}`}
      />
      {open ? (
        <OptionSheet
          title={f.label}
          options={options}
          multiple={multiple}
          initial={picked}
          onClose={() => setOpen(false)}
          onDone={(v) => {
            setOpen(false)
            onChange(multiple ? v : (v[0] ?? null))
          }}
        />
      ) : null}
    </>
  )
}

/** 调用方只在打开时挂载（每次打开都是新的一份状态，同 `UserPicker`） */
function OptionSheet({
  title,
  options,
  multiple,
  initial,
  onClose,
  onDone,
}: {
  title: string
  options: { label: string; value: string }[]
  multiple: boolean
  initial: string[]
  onClose: () => void
  onDone: (v: string[]) => void
}) {
  const { t } = useTranslation()
  const [picked, setPicked] = React.useState(() => new Set(initial))
  return (
    <Overlay open onClose={onClose} variant="bottom" testID="wf-options">
      <View className="mb-3 flex-row items-center">
        <Text className="flex-1 text-base font-semibold">{title}</Text>
        {multiple ? (
          // 保持原选项的顺序，不按点的先后
          <Button size="sm" onPress={() => onDone(options.filter((o) => picked.has(o.value)).map((o) => o.value))}>
            <Text>{t('确定')}</Text>
          </Button>
        ) : null}
      </View>
      <ScrollView style={{ maxHeight: 360 }}>
        {options.map((o, i) => {
          const on = picked.has(o.value)
          return (
            <Pressable
              key={o.value}
              testID={`wf-option-${o.value}`}
              onPress={() => {
                if (!multiple) return onDone([o.value])
                setPicked((prev) => {
                  const next = new Set(prev)
                  if (next.has(o.value)) next.delete(o.value)
                  else next.add(o.value)
                  return next
                })
              }}
              className={`active:bg-muted flex-row items-center py-3.5 ${i > 0 ? 'border-border border-t' : ''}`}
            >
              <Text className={`flex-1 text-[15px] ${on ? 'text-primary font-medium' : ''}`}>{o.label}</Text>
              {on ? <Icon as={CheckIcon} className="text-primary size-5" /> : null}
            </Pressable>
          )
        })}
      </ScrollView>
    </Overlay>
  )
}

/* ────────────────────────── 日期 ────────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function DateField({
  id,
  mode,
  value,
  onChange,
  placeholder,
}: {
  id: string
  mode: 'single' | 'range'
  value: unknown
  onChange: (v: unknown) => void
  placeholder?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const range = mode === 'range' && Array.isArray(value) ? (value as string[]) : null
  const text = mode === 'range' ? (range ? `${range[0]} ~ ${range[1]}` : null) : ((value as string) || null)
  return (
    <>
      <PickerBox
        text={text}
        placeholder={placeholder ?? (mode === 'range' ? t('选择开始和结束日期') : t('选择日期'))}
        icon={CalendarIcon}
        onPress={() => setOpen(true)}
        testID={`wf-input-${id}`}
      />
      {open ? (
        <Calendar
          mode={mode}
          initial={mode === 'range' ? (range ?? []) : typeof value === 'string' && DATE_RE.test(value) ? [value] : []}
          onClose={() => setOpen(false)}
          onClear={() => {
            setOpen(false)
            onChange(null)
          }}
          onDone={(v) => {
            setOpen(false)
            onChange(mode === 'range' ? v : v[0])
          }}
        />
      ) : null}
    </>
  )
}

/**
 * 月历弹层。自己画，不装 `@react-native-community/datetimepicker`：系统的日期框一次只能选一个日期，
 * 区间要弹两次；而且两端长得完全不一样。
 *
 * 区间：第一下是开始，第二下是结束（点在开始之前就当新的开始）；两头都有了才能点「确定」。
 * 周一开头（中文日历的习惯）。日期全按**本地日历**算，只拼 `YYYY-MM-DD`，不经过时区换算。
 */
function Calendar({
  mode,
  initial,
  onClose,
  onClear,
  onDone,
}: {
  mode: 'single' | 'range'
  initial: string[]
  onClose: () => void
  onClear: () => void
  onDone: (v: string[]) => void
}) {
  const { t } = useTranslation()
  const now = new Date()
  const today = ymd(now.getFullYear(), now.getMonth(), now.getDate())
  const [sel, setSel] = React.useState<string[]>(initial.filter((s) => DATE_RE.test(s)))
  const anchor = sel[0] ?? today
  const [ym, setYm] = React.useState(() => ({ y: Number(anchor.slice(0, 4)), m: Number(anchor.slice(5, 7)) - 1 }))

  const first = new Date(ym.y, ym.m, 1)
  const lead = (first.getDay() + 6) % 7 // 周一 = 0
  const count = new Date(ym.y, ym.m + 1, 0).getDate()
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: count }, (_, i) => ymd(ym.y, ym.m, i + 1)),
  ]
  while (cells.length % 7) cells.push(null)

  const shift = (d: number) => setYm(({ y, m }) => ({ y: m + d < 0 ? y - 1 : m + d > 11 ? y + 1 : y, m: (m + d + 12) % 12 }))

  function tap(d: string) {
    if (mode === 'single') return onDone([d])
    setSel((prev) => (prev.length !== 1 || d < prev[0] ? [d] : [prev[0], d]))
  }

  const [a, b] = sel
  return (
    <Overlay open onClose={onClose} variant="bottom" testID="wf-calendar">
      <View className="mb-2 flex-row items-center">
        <Pressable onPress={() => shift(-1)} hitSlop={10} className="p-1" accessibilityLabel={t('上个月')}>
          <Icon as={ChevronLeftIcon} className="text-foreground size-5" />
        </Pressable>
        <Text className="flex-1 text-center text-base font-semibold">{t('{{y}} 年 {{m}} 月', { y: ym.y, m: ym.m + 1 })}</Text>
        <Pressable onPress={() => shift(1)} hitSlop={10} className="p-1" accessibilityLabel={t('下个月')}>
          <Icon as={ChevronRightIcon} className="text-foreground size-5" />
        </Pressable>
      </View>
      <View className="flex-row">
        {[t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六'), t('周日')].map((w) => (
          <Text key={w} className="text-muted-foreground flex-1 py-1 text-center text-xs">
            {w}
          </Text>
        ))}
      </View>
      <View className="flex-row flex-wrap">
        {cells.map((d, i) => {
          if (!d) return <View key={i} style={{ width: `${100 / 7}%` }} className="h-11" />
          const edge = d === a || d === b
          const inside = !!a && !!b && d > a && d < b
          return (
            <Pressable
              key={d}
              onPress={() => tap(d)}
              style={{ width: `${100 / 7}%` }}
              className={`h-11 items-center justify-center ${inside ? 'bg-primary/10' : ''}`}
              testID={`wf-day-${d}`}
            >
              <View className={`size-9 items-center justify-center rounded-full ${edge ? 'bg-primary' : ''}`}>
                <Text
                  className={`text-[15px] ${edge ? 'text-primary-foreground font-semibold' : d === today ? 'text-primary font-semibold' : ''}`}
                >
                  {Number(d.slice(8))}
                </Text>
              </View>
            </Pressable>
          )
        })}
      </View>
      <View className="mt-3 flex-row items-center gap-2">
        <Button variant="ghost" size="sm" onPress={onClear}>
          <Text>{t('清空')}</Text>
        </Button>
        {mode === 'range' ? (
          <Text className="text-muted-foreground flex-1 text-center text-xs">
            {a && b ? `${a} ~ ${b}` : a ? t('再点一下结束日期') : t('先点开始日期')}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        {mode === 'range' ? (
          <Button size="sm" disabled={!a || !b} onPress={() => onDone([a!, b!])} testID="wf-calendar-done">
            <Text>{t('确定')}</Text>
          </Button>
        ) : null}
      </View>
    </Overlay>
  )
}

/* ────────────────────────── 人员 / 部门 ────────────────────────── */

function UserField({ field: f, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const ids = isEmpty(value) ? [] : Array.isArray(value) ? (value as string[]) : [value as string]
  const users = useDirectoryUsersByIds(ids)
  const names = ids.map((id) => users.data?.find((u) => u.id === id)?.nickname ?? (users.isPending ? '…' : id))
  return (
    <>
      <PickerBox
        text={names.join('、') || null}
        placeholder={f.placeholder ?? (f.multiple ? t('选择人员（可多选）') : t('选择人员'))}
        icon={ChevronRightIcon}
        onPress={() => setOpen(true)}
        testID={`wf-input-${f.id}`}
      />
      {open ? (
        <UserPicker
          open
          multiple={!!f.multiple}
          initial={ids}
          title={f.label}
          onClose={() => setOpen(false)}
          onDone={(us) => {
            setOpen(false)
            onChange(f.multiple ? us.map((u) => u.id) : (us[0]?.id ?? null))
          }}
        />
      ) : null}
    </>
  )
}

function DeptField({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string
  value: unknown
  onChange: (v: unknown) => void
  placeholder: string
}) {
  const [open, setOpen] = React.useState(false)
  const depts = useDirectoryDepts(true)
  const v = isEmpty(value) ? null : (value as string)
  const name = v ? (depts.data?.find((d) => d.id === v)?.name ?? (depts.isPending ? '…' : v)) : null
  return (
    <>
      <PickerBox text={name} placeholder={placeholder} icon={ChevronRightIcon} onPress={() => setOpen(true)} testID={`wf-input-${id}`} />
      {open ? (
        <DeptPicker
          current={v}
          onClose={() => setOpen(false)}
          onDone={(d) => {
            setOpen(false)
            onChange(d)
          }}
        />
      ) : null}
    </>
  )
}

/** 部门：整棵树拍平成带缩进的列表；搜索时只按名字过滤、不缩进 */
function DeptPicker({
  current,
  onClose,
  onDone,
}: {
  current: string | null
  onClose: () => void
  onDone: (id: string) => void
}) {
  const { t } = useTranslation()
  const q = useDirectoryDepts(true)
  const [keyword, setKeyword] = React.useState('')
  const rows = React.useMemo(() => {
    const list = q.data ?? []
    const kw = keyword.trim()
    if (kw) return list.filter((d) => d.name.includes(kw)).map((d) => ({ ...d, depth: 0 }))
    const kids = new Map<string | null, typeof list>()
    const ids = new Set(list.map((d) => d.id))
    for (const d of list) {
      // 父部门不在列表里（被删了 / 没权限）的当根
      const p = d.parent_id && ids.has(d.parent_id) ? d.parent_id : null
      kids.set(p, [...(kids.get(p) ?? []), d])
    }
    const out: ((typeof list)[number] & { depth: number })[] = []
    const walk = (p: string | null, depth: number) => {
      for (const d of kids.get(p) ?? []) {
        out.push({ ...d, depth })
        walk(d.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [q.data, keyword])

  return (
    <Overlay open onClose={onClose} variant="full" testID="wf-dept-picker">
      <View className="flex-1">
        <View className="flex-row items-center gap-3 px-4 py-3">
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('取消')}>
            <Icon as={XIcon} className="text-foreground size-5" />
          </Pressable>
          <Text className="flex-1 text-base font-semibold">{t('选择部门')}</Text>
        </View>
        <View className="bg-card mx-4 flex-row items-center gap-2 rounded-xl px-3">
          <Icon as={SearchIcon} className="text-muted-foreground size-4" />
          <Input
            value={keyword}
            onChangeText={setKeyword}
            placeholder={t('搜索部门')}
            className="h-11 flex-1 border-0 bg-transparent px-0 shadow-none"
          />
        </View>
        {q.error && !q.data ? (
          <View className="items-center gap-2 pt-10">
            <Text className="text-destructive text-sm">{q.error.message}</Text>
            <Button variant="outline" size="sm" onPress={() => void q.refetch()}>
              <Text>{t('重试')}</Text>
            </Button>
          </View>
        ) : q.isPending ? (
          <ActivityIndicator className="pt-10" />
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(d) => d.id}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-4 pt-3 pb-10"
            ListEmptyComponent={<Text className="text-muted-foreground pt-10 text-center text-sm">{t('没有匹配的部门')}</Text>}
            renderItem={({ item, index }) => (
              <Pressable
                onPress={() => onDone(item.id)}
                testID={`wf-dept-${item.id}`}
                style={{ paddingLeft: 16 + item.depth * 18 }}
                className={`bg-card active:bg-muted flex-row items-center gap-3 py-3 pr-4 ${index === 0 ? 'rounded-t-xl' : 'border-border border-t'} ${index === rows.length - 1 ? 'rounded-b-xl' : ''}`}
              >
                <Text className={`flex-1 text-[15px] ${item.id === current ? 'text-primary font-medium' : ''}`}>{item.name}</Text>
                {item.id === current ? <Icon as={CheckIcon} className="text-primary size-5" /> : null}
              </Pressable>
            )}
          />
        )}
      </View>
    </Overlay>
  )
}

/* ────────────────────────── 明细表 ────────────────────────── */

/** 明细表：手机上横排的表格填不了，每一行是一张小卡片，列竖着排 */
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
    <View className="gap-2">
      {value.map((row, i) => (
        <View key={i} className="bg-muted/50 gap-2 rounded-xl px-3 py-2.5">
          <View className="flex-row items-center">
            <Text className="text-muted-foreground flex-1 text-xs">{t('第 {{n}} 行', { n: i + 1 })}</Text>
            <Pressable
              hitSlop={10}
              accessibilityLabel={t('删除这一行')}
              onPress={() => onChange(value.filter((_, j) => j !== i))}
              testID={`wf-row-del-${f.id}-${i}`}
            >
              <Icon as={Trash2Icon} className="text-muted-foreground size-4" />
            </Pressable>
          </View>
          {cols.map((c) => (
            <View key={c.id} className="gap-1">
              <View className="flex-row gap-1">
                <Text className="text-muted-foreground text-xs">{c.label}</Text>
                {c.required ? <Text className="text-destructive text-xs">*</Text> : null}
              </View>
              <FieldInput
                field={{ ...c, id: `${f.id}-${i}-${c.id}` }}
                value={row[c.id]}
                onChange={(v) => onChange(value.map((r, j) => (j === i ? { ...r, [c.id]: v } : r)))}
              />
            </View>
          ))}
        </View>
      ))}
      <Button variant="outline" size="sm" className="self-start" onPress={() => onChange([...value, {}])} testID={`wf-row-add-${f.id}`}>
        <Icon as={PlusIcon} className="size-4" />
        <Text>{t('添加一行')}</Text>
      </Button>
    </View>
  )
}

/* ────────────────────────── 附件 ────────────────────────── */

/**
 * 附件：系统文件选择器（可多选）→ 逐个传到 `/sys/workflow/files` → 文件 ID 挂进表单值。
 *
 * 名字从哪来：这次刚传的记在本地；详情接口带的 `files`；都没有（从草稿恢复的）就按 ID 现查一次。
 */
function AttachmentInput({
  id,
  ids,
  onChange,
  files,
}: {
  id: string
  ids: string[]
  onChange: (v: unknown) => void
  files?: Record<string, { name: string }>
}) {
  const { t } = useTranslation()
  const [uploaded, setUploaded] = React.useState<Record<string, { name: string; size: number }>>({})
  const [busy, setBusy] = React.useState(0)
  // 上传是异步的、一个个传：用 ref 拿最新的值，别让后回来的覆盖先回来的（同 web）
  const latestRef = useLatest(ids)
  const unknown = ids.filter((x) => !uploaded[x] && !files?.[x])
  const details = useFileDetails(unknown)

  async function pick() {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (res.canceled) return
    for (const a of res.assets) {
      setBusy((n) => n + 1)
      try {
        const meta = await uploadWorkflowFile({ uri: a.uri, name: a.name, mimeType: a.mimeType })
        setUploaded((u) => ({ ...u, [meta.id]: { name: meta.name || a.name, size: meta.size } }))
        latestRef.current = [...latestRef.current, meta.id]
        onChange(latestRef.current)
      } catch (e) {
        toast.error(`${a.name}：${e instanceof Error ? e.message : t('上传失败，请稍后重试')}`)
      } finally {
        setBusy((n) => n - 1)
      }
    }
  }

  return (
    <View className="gap-1.5" testID={`wf-files-${id}`}>
      {ids.map((fid) => {
        const i = unknown.indexOf(fid)
        const d = i >= 0 ? details[i] : undefined
        const name =
          uploaded[fid]?.name ?? files?.[fid]?.name ?? d?.data?.original_name ?? (d?.isError ? t('（文件信息没取到）') : '…')
        const size = uploaded[fid]?.size ?? d?.data?.size
        return (
          <View key={fid} className="bg-muted/50 flex-row items-center gap-2 rounded-lg px-3 py-2">
            <Icon as={PaperclipIcon} className="text-muted-foreground size-4" />
            <Text className="flex-1 text-[14px]" numberOfLines={1}>
              {name}
            </Text>
            {size !== undefined ? <Text className="text-muted-foreground text-xs">{formatBytes(size)}</Text> : null}
            <Pressable
              hitSlop={10}
              accessibilityLabel={t('移除附件')}
              onPress={() => onChange(ids.filter((x) => x !== fid))}
            >
              <Icon as={XIcon} className="text-muted-foreground size-4" />
            </Pressable>
          </View>
        )
      })}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={busy > 0}
        onPress={() => void pick()}
        testID={`wf-files-add-${id}`}
      >
        {busy > 0 ? <ActivityIndicator size="small" /> : <Icon as={PlusIcon} className="size-4" />}
        <Text>{busy > 0 ? t('上传中…') : t('添加附件')}</Text>
      </Button>
    </View>
  )
}

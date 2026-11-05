import { formatDateTime } from '@admin/i18n'
import { CheckIcon, SearchIcon, XIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { Portal } from '@rn-primitives/portal'
import { ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AttachmentList } from '@/components/attachment-list'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { useDebounced } from '@/lib/debounce'
import {
  STATUS_TEXT,
  useDirectoryDepts,
  useDirectoryUsers,
  useDirectoryUsersByIds,
  useFileDetails,
  type FormField,
  type InstanceStatus,
} from '@/lib/workflow'
import type { TrackItem, TrackState, Tone } from '@/lib/workflow-progress'

/* ────────────────────────── 状态徽标 ────────────────────────── */

/** 审批中 = 主色、通过 = 绿、驳回 = 红、撤回 = 灰、终止 = 琥珀（同 web `INSTANCE_STATUS` 的语气） */
const STATUS_TONE: Record<InstanceStatus, { bg: string; fg: string }> = {
  running: { bg: 'bg-primary/10', fg: 'text-primary' },
  approved: { bg: 'bg-emerald-500/15', fg: 'text-emerald-700 dark:text-emerald-400' },
  rejected: { bg: 'bg-destructive/10', fg: 'text-destructive' },
  withdrawn: { bg: 'bg-muted', fg: 'text-muted-foreground' },
  terminated: { bg: 'bg-amber-500/15', fg: 'text-amber-700 dark:text-amber-400' },
}

export function StatusBadge({ status }: { status: InstanceStatus }) {
  const { t } = useTranslation()
  const tone = STATUS_TONE[status] ?? STATUS_TONE.withdrawn
  return (
    <View className={`rounded-full px-2 py-0.5 ${tone.bg}`} testID="wf-status">
      <Text className={`text-[11px] font-medium ${tone.fg}`}>{t(STATUS_TEXT[status] ?? status)}</Text>
    </View>
  )
}

/* ────────────────────────── 流程方块 ────────────────────────── */

/** 流程的小方块：名字第一个字 + 按名字固定挑一个底色（同一个流程每次颜色一样） */
const TILE = [
  'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
]

export function Tile({ name, large }: { name: string; large?: boolean }) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const [bg, ...fg] = TILE[h % TILE.length].split(' ')
  return (
    <View className={`${bg} items-center justify-center rounded-xl ${large ? 'size-12' : 'size-9'}`}>
      <Text className={`${fg.join(' ')} font-semibold ${large ? 'text-lg' : 'text-[15px]'}`}>{[...name][0] ?? '?'}</Text>
    </View>
  )
}

/* ────────────────────────── 只读表单 ────────────────────────── */

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

/**
 * 申请内容（只读）。字段的显示口径照 web `form-renderer.tsx: FieldDisplay`。
 *
 * ⚠️ **空值的字段整行不画。** web 画「—」，但 web 同时按显示条件把不该出现的字段藏掉了
 * （`form-rules.ts`）；移动端没移植那套条件，空字段里分不清「没填」和「条件不成立、本来就不该出现」——
 * 画成「—」会让审批人以为申请人漏填了。必填字段服务端保证有值，不会被这条规则藏掉。
 */
export function FormFields({
  fields,
  data,
  files,
}: {
  fields: FormField[]
  data: Record<string, unknown>
  files: Record<string, { name: string }>
}) {
  const shown = fields.filter((f) => f.type === 'description' || !isEmpty(data[f.id]))
  // 名字一次性查回来，不在每一行里各查一遍
  const userIds = shown
    .filter((f) => f.type === 'user')
    .flatMap((f) => (Array.isArray(data[f.id]) ? (data[f.id] as string[]) : [data[f.id] as string]))
  const users = useDirectoryUsersByIds(userIds)
  const depts = useDirectoryDepts(shown.some((f) => f.type === 'dept'))
  const userName = (id: string) => users.data?.find((u) => u.id === id)?.nickname ?? (users.isPending ? '…' : id)
  const deptName = (id: string) => depts.data?.find((d) => d.id === id)?.name ?? (depts.isPending ? '…' : id)

  if (shown.length === 0) return null

  return (
    <View className="bg-card mx-4 rounded-2xl px-4 py-1">
      {shown.map((f, i) => (
        <View key={f.id} className={`gap-1 py-3 ${i > 0 ? 'border-border border-t' : ''}`} testID={`wf-field-${f.id}`}>
          {f.type === 'description' ? (
            <Text className="text-muted-foreground text-[13px] leading-5">{f.content ?? f.label}</Text>
          ) : (
            <>
              <Text className="text-muted-foreground text-[13px]">{f.label}</Text>
              <FieldValue field={f} value={data[f.id]} userName={userName} deptName={deptName} files={files} />
            </>
          )}
        </View>
      ))}
    </View>
  )
}

/**
 * 单个字段的只读值（表单渲染器里「只能看」的那几个字段用）。名字自己查 —— 一张表单里只读字段不多，
 * 每个各查一次走的是同一份缓存。
 */
export function ReadonlyValue({
  field,
  value,
  files,
}: {
  field: FormField
  value: unknown
  files: Record<string, { name: string }>
}) {
  const ids =
    field.type === 'user' && !isEmpty(value) ? (Array.isArray(value) ? (value as string[]) : [value as string]) : []
  const users = useDirectoryUsersByIds(ids)
  const depts = useDirectoryDepts(field.type === 'dept' && !isEmpty(value))
  if (isEmpty(value)) return <Text className="text-muted-foreground text-[15px]">—</Text>
  const userName = (id: string) => users.data?.find((u) => u.id === id)?.nickname ?? (users.isPending ? '…' : id)
  const deptName = (id: string) => depts.data?.find((d) => d.id === id)?.name ?? (depts.isPending ? '…' : id)
  return <FieldValue field={field} value={value} userName={userName} deptName={deptName} files={files} />
}

function plain(field: FormField, value: unknown, userName: (id: string) => string, deptName: (id: string) => string) {
  switch (field.type) {
    case 'select':
      return field.options?.find((o) => o.value === value)?.label ?? String(value)
    case 'multiselect':
      return (value as string[]).map((v) => field.options?.find((o) => o.value === v)?.label ?? v).join('、')
    case 'daterange':
      return (value as string[]).join(' ~ ')
    case 'user':
      return (Array.isArray(value) ? (value as string[]) : [value as string]).map(userName).join('、')
    case 'dept':
      return deptName(value as string)
    default:
      return String(value)
  }
}

function FieldValue({
  field,
  value,
  userName,
  deptName,
  files,
}: {
  field: FormField
  value: unknown
  userName: (id: string) => string
  deptName: (id: string) => string
  files: Record<string, { name: string }>
}) {
  if (field.type === 'attachment') return <Attachments ids={value as string[]} files={files} />
  if (field.type === 'table') {
    // 手机上横向表格读不了：每行展开成一张小卡片，列名在左、值在右
    const cols = field.columns ?? []
    return (
      <View className="gap-2 pt-1">
        {(value as Record<string, unknown>[]).map((row, i) => (
          <View key={i} className="bg-muted/50 gap-1 rounded-lg px-3 py-2">
            {cols.map((c) =>
              isEmpty(row[c.id]) ? null : (
                <View key={c.id} className="flex-row gap-3">
                  <Text className="text-muted-foreground w-20 text-[13px]" numberOfLines={1}>
                    {c.label}
                  </Text>
                  <Text className="flex-1 text-[13px]">{plain(c, row[c.id], userName, deptName)}</Text>
                </View>
              ),
            )}
          </View>
        ))}
      </View>
    )
  }
  return <Text className="text-[15px] leading-6">{plain(field, value, userName, deptName)}</Text>
}

function Attachments({ ids, files }: { ids: string[]; files: Record<string, { name: string }> }) {
  const { t } = useTranslation()
  const results = useFileDetails(ids)
  const ok = results.flatMap((r) => (r.data ? [r.data] : []))
  const failed = ids.filter((_, i) => results[i]?.isError)
  const pending = results.some((r) => r.isPending)
  return (
    <View className="gap-1 pt-1">
      {ok.length > 0 ? <AttachmentList files={ok} /> : null}
      {pending ? <ActivityIndicator size="small" className="self-start" /> : null}
      {/* 取不到详情的也要列出来（硬纪律 9）：名字从详情接口的 `files` 里拿，写明没取到 */}
      {failed.map((id) => (
        <Text key={id} className="text-muted-foreground text-[13px]">
          {t('{{name}}（没取到这个附件）', { name: files[id]?.name ?? id })}
        </Text>
      ))}
    </View>
  )
}

/* ────────────────────────── 审批进度 ────────────────────────── */

const DOT: Record<TrackState, string> = {
  done: 'bg-emerald-500',
  current: 'bg-primary',
  future: 'bg-border',
  skipped: 'bg-muted-foreground/40',
  rejected: 'bg-destructive',
  withdrawn: 'bg-muted-foreground',
  warn: 'bg-amber-500',
}

const RESULT: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
  pending: 'text-primary',
}

/** 竖向时间轴：圆点 + 连线 + 步骤名 / 标签 / 每个人的结果和意见。条目来自 `lib/workflow-progress.ts` */
export function Track({ items }: { items: TrackItem[] }) {
  return (
    <View className="bg-card mx-4 rounded-2xl px-4 py-3">
      {items.map((it, i) => {
        const last = i === items.length - 1
        const faded = it.state === 'future' || it.state === 'skipped'
        return (
          <View key={it.key} className="flex-row gap-3" testID={`wf-track-${it.key}`}>
            <View className="items-center pt-1.5">
              <View
                className={`size-2.5 rounded-full ${DOT[it.state]} ${it.state === 'current' ? 'ring-primary/30 ring-4' : ''}`}
              />
              {last ? null : <View className="bg-border mt-1 w-px flex-1" />}
            </View>
            <View className={`flex-1 gap-1 ${last ? '' : 'pb-4'}`}>
              <View className="flex-row flex-wrap items-center gap-x-2">
                <Text className={`text-[15px] font-medium ${faded ? 'text-muted-foreground' : ''}`}>{it.title}</Text>
                {it.tag ? <Text className="text-muted-foreground text-xs">{it.tag}</Text> : null}
                {it.time ? (
                  <Text className="text-muted-foreground/80 ml-auto text-xs">{formatDateTime(it.time)}</Text>
                ) : null}
              </View>
              {it.people?.map((p, j) => (
                <View key={j} className="gap-0.5">
                  <View className="flex-row flex-wrap items-center gap-x-2">
                    <Text className={`text-[13px] ${faded ? 'text-muted-foreground' : ''}`}>{p.name}</Text>
                    {p.result ? <Text className={`text-[13px] ${RESULT[p.result.tone]}`}>{p.result.text}</Text> : null}
                  </View>
                  {p.opinion ? (
                    <Text className="text-muted-foreground bg-muted/60 self-start rounded-md px-2 py-1 text-[13px] leading-5">
                      {p.opinion}
                    </Text>
                  ) : null}
                </View>
              ))}
              {it.note ? <Text className="text-muted-foreground text-xs leading-5">{it.note}</Text> : null}
            </View>
          </View>
        )
      })}
    </View>
  )
}

/* ────────────────────────── 浮层 ────────────────────────── */

/**
 * 审批用的浮层：全屏（选人）或底部弹出（动作面板）。
 *
 * 🔴 **不用 RN 的 `Modal`**，同 `ui/confirm-dialog.tsx`：它挂在另一个原生根上，那里样式失效
 * 打包和 typecheck 都不报（`components` 分册「确认框走 portal」）。代价同样要付：
 * - Android 返回键自己接（`BackHandler`），否则按返回是把底下的详情屏 pop 掉、浮层还开着
 * - portal 的 `name` 每个实例唯一（同一屏会同时挂选人和动作面板两个）
 * `busy`（请求在飞）时吃掉返回键、点遮罩也不关。
 */
export function Overlay({
  open,
  onClose,
  busy,
  variant,
  children,
  testID,
}: {
  open: boolean
  onClose: () => void
  busy?: boolean
  variant: 'full' | 'bottom'
  children: React.ReactNode
  testID?: string
}) {
  const insets = useSafeAreaInsets()
  const name = `wf-overlay-${React.useId()}`

  React.useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) onClose()
      return true
    })
    return () => sub.remove()
  }, [open, busy, onClose])

  if (!open) return null

  return (
    <Portal name={name}>
      {variant === 'full' ? (
        <View
          className="bg-background absolute inset-0 z-40"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
          testID={testID}
        >
          {children}
        </View>
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          className="absolute inset-0 z-40 justify-end"
          testID={testID}
        >
          <Pressable
            className="absolute inset-0 bg-black/50"
            onPress={() => {
              if (!busy) onClose()
            }}
          />
          <View className="bg-card rounded-t-3xl px-5 pt-5" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
            {children}
          </View>
        </KeyboardAvoidingView>
      )}
    </Portal>
  )
}

/* ────────────────────────── 选人 ────────────────────────── */

/**
 * 选人弹层（转交 / 抄送 / 加签 / 改办理人）。数据走审批的通讯录接口（只要登录）。
 * `exclude`：不能选的人（发起人、这一步已经有份的人）—— 服务端同样会拒，这里提前拦住只是少一次 409。
 */
export function UserPicker({
  open,
  multiple,
  exclude = [],
  initial = [],
  title,
  onClose,
  onDone,
}: {
  open: boolean
  multiple: boolean
  exclude?: string[]
  initial?: string[]
  title: string
  onClose: () => void
  onDone: (users: { id: string; name: string }[]) => void
}) {
  const { t } = useTranslation()
  const [keyword, setKeyword] = React.useState('')
  const debounced = useDebounced(keyword, 300)
  const q = useDirectoryUsers(debounced)
  // ⚠️ 调用方只在打开时挂载它（`{picking ? <UserPicker … /> : null}`），每次打开都是新的一份状态 ——
  // 不在 effect 里按 `open` 重置（那是 setState-in-effect，多渲染一轮）
  const [picked, setPicked] = React.useState<Map<string, string>>(() => new Map(initial.map((id) => [id, id])))

  const users = (q.data ?? []).filter((u) => !exclude.includes(u.id))

  function toggle(id: string, name: string) {
    if (!multiple) {
      onDone([{ id, name }])
      return
    }
    setPicked((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, name)
      return next
    })
  }

  return (
    <Overlay open={open} onClose={onClose} variant="full" testID="wf-picker">
      <View className="flex-1">
        <View className="flex-row items-center gap-3 px-4 py-3">
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('取消')}>
            <Icon as={XIcon} className="text-foreground size-5" />
          </Pressable>
          <Text className="flex-1 text-base font-semibold">{title}</Text>
          {multiple ? (
            <Button
              size="sm"
              disabled={picked.size === 0}
              onPress={() => onDone([...picked].map(([id, name]) => ({ id, name })))}
              testID="wf-picker-done"
            >
              <Text>{picked.size > 0 ? t('确定（{{n}}）', { n: picked.size }) : t('确定')}</Text>
            </Button>
          ) : null}
        </View>
        <View className="bg-card mx-4 flex-row items-center gap-2 rounded-xl px-3">
          <Icon as={SearchIcon} className="text-muted-foreground size-4" />
          <Input
            value={keyword}
            onChangeText={setKeyword}
            placeholder={t('搜索姓名或账号')}
            autoFocus
            testID="wf-picker-search"
            className="h-11 flex-1 border-0 bg-transparent px-0 shadow-none"
          />
          {q.isFetching ? <ActivityIndicator size="small" /> : null}
        </View>
        {q.error && !q.data ? (
          <View className="items-center gap-2 pt-10">
            <Text className="text-destructive text-sm">{q.error.message}</Text>
            <Button variant="outline" size="sm" onPress={() => void q.refetch()}>
              <Text>{t('重试')}</Text>
            </Button>
          </View>
        ) : (
          <FlatList
            data={users}
            keyExtractor={(u) => u.id}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-4 pt-3 pb-10"
            ListEmptyComponent={
              q.isPending ? null : (
                <Text className="text-muted-foreground pt-10 text-center text-sm">{t('没有匹配的人')}</Text>
              )
            }
            renderItem={({ item, index }) => {
              const on = picked.has(item.id)
              return (
                <Pressable
                  onPress={() => toggle(item.id, item.nickname)}
                  testID={`wf-picker-user-${item.id}`}
                  className={`bg-card active:bg-muted flex-row items-center gap-3 px-4 py-3 ${index === 0 ? 'rounded-t-xl' : 'border-border border-t'} ${index === users.length - 1 ? 'rounded-b-xl' : ''}`}
                >
                  <View className="flex-1 gap-0.5">
                    <Text className="text-[15px]">{item.nickname}</Text>
                    <Text className="text-muted-foreground text-xs">
                      {[item.username, item.dept_name].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  {on ? <Icon as={CheckIcon} className="text-primary size-5" /> : null}
                </Pressable>
              )
            }}
          />
        )}
      </View>
    </Overlay>
  )
}

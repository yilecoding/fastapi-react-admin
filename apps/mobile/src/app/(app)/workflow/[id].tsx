import { ApiError } from '@admin/api'
import { formatDateTime } from '@admin/i18n'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronRightIcon, EllipsisIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { GroupHeader } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { FormFields, Overlay, StatusBadge, Track, UserPicker } from '@/components/workflow'
import { useSession } from '@/lib/session'
import {
  ACTION_TEXT,
  DONE_TEXT,
  useAct,
  useInstance,
  useMarkRead,
  type ActBody,
  type Action,
  type Capability,
  type InstanceDetail,
} from '@/lib/workflow'
import { progressItems } from '@/lib/workflow-progress'

/**
 * 审批详情（#224 2a）：概要 · 申请内容 · 审批进度 · 底部动作栏。
 *
 * ## 🔴 按钮只按能力信封出（同 web，`pages/workflow` 分册第一条）
 *
 * `capabilities` 和执行接口用的是**同一个服务端函数**。这里不根据状态、「我是不是发起人」自己推按钮 ——
 * 推出来的规则迟早和服务端漂移，表现是「按钮在、点了报 409」或者「该有的按钮没有」。
 * `enabled: false` 的也画出来（灰的 + 服务端给的原因），不画的话用户不知道为什么没有。
 *
 * ## 移动端没做的两件，明说
 *
 * - 这一步有**审批人可填**的字段：移动端只读展示，提示去网页端填（服务端照样校验必填）
 * - **被退回后重新提交**（我的待办在开始节点上）：要改申请内容、重选审批人，移动端不做，「同意」禁用并写明
 */

/** 每个动作在面板里要填什么。照 web `instance-sheet.tsx: DIALOG`，同意 / 驳回也走面板（手机上没有常驻的意见框） */
type Need = {
  opinion?: 'optional' | 'required'
  users?: 'one' | 'many'
  node?: true
  task?: true
  sign?: true
}

const NEED: Record<Action, Need> = {
  approve: { opinion: 'optional' },
  reject: { opinion: 'required' },
  transfer: { users: 'one', opinion: 'optional' },
  cc: { users: 'many' },
  withdraw: { opinion: 'required' },
  terminate: { opinion: 'required' },
  send_back: { node: true, opinion: 'required' },
  reassign: { task: true, users: 'one', opinion: 'optional' },
  add_sign: { sign: true, users: 'many', opinion: 'optional' },
  take_back: {},
  remind: {},
}

/** 动作说明（和 web 的同一批文案） */
const HINT: Partial<Record<Action, string>> = {
  withdraw: '撤回后这张审批单作废，已经审批过的人会收到通知。',
  terminate: '终止后审批立即结束，发起人会收到通知。',
  transfer: '转交后这条待办交给对方处理，你的待办随之结束。',
  cc: '对方会收到通知，并能在「抄送我的」里看到这张单。',
  send_back: '单子回到你选的那一步重新处理，这一步的待办随之结束。退回给发起人时，由发起人改好后重新提交。',
  reassign: '把这条待办交给另一个人处理，不需要原办理人同意。适合办理人离职或长期不在。',
  add_sign: '临时请别人一起审这一步，他们都同意才算数。',
}

/** 办完自己那一步就回列表；撤回 / 催办 / 拿回 / 抄送之后留在详情里看结果（同 web） */
const LEAVE_AFTER: Action[] = ['approve', 'reject', 'transfer', 'send_back', 'add_sign']

/** 底部主按钮。其余的收进「更多」 */
const PRIMARY: Action[] = ['approve', 'reject']

export default function WorkflowDetailScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { user } = useSession()
  const q = useInstance(id)
  const markRead = useMarkRead()
  const [refreshing, setRefreshing] = React.useState(false)
  const [sheet, setSheet] = React.useState<Action | 'more' | null>(null)

  const d = q.data
  const me = user ? String(user.id) : null

  // 打开即已读：办理人记「看过了」（进度里「审批中 · 已读」）；抄送人记抄送已读（角标跟着减）。接口都只记第一次
  const markedFor = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!d || markedFor.current === d.instance.id) return
    markedFor.current = d.instance.id
    if (d.my_task_id) markRead.mutate({ id: d.instance.id, kind: 'task' })
    if (me && d.ccs.some((c) => c.user_id === me && !c.read_time)) markRead.mutate({ id: d.instance.id, kind: 'cc' })
  }, [d, me, markRead])

  async function onRefresh() {
    setRefreshing(true)
    try {
      await q.refetch()
    } finally {
      setRefreshing(false)
    }
  }

  if (q.error && !d) {
    return (
      <View className="bg-background flex-1 p-4">
        <Alert variant="destructive" icon={TriangleAlertIcon}>
          <AlertTitle>{t('审批单打不开')}</AlertTitle>
          <AlertDescription>{q.error.message}</AlertDescription>
          <Button variant="outline" size="sm" onPress={() => void q.refetch()} className="mt-2 self-start">
            <Text>{t('重试')}</Text>
          </Button>
        </Alert>
      </View>
    )
  }

  if (!d) {
    return (
      <View className="bg-background flex-1 gap-3 p-4">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </View>
    )
  }

  const caps = d.capabilities
  const resubmit = isResubmit(d)
  const editable = Object.values(d.field_perms).some((p) => p === 'editable')
  const primary = PRIMARY.flatMap((a) => caps.filter((c) => c.action === a))
  const more = caps.filter((c) => !PRIMARY.includes(c.action))

  return (
    <View className="bg-background flex-1">
      <ScrollView
        contentContainerClassName="pb-6"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <Summary d={d} />

        {resubmit ? (
          <Notice text={t('这张单被退回给你了。重新提交要改申请内容、重选审批人，请到网页端的审批中心办理。')} />
        ) : editable ? (
          <Notice text={t('这一步有需要你填写的内容，移动端只能查看。要填的话请到网页端的审批中心办理。')} />
        ) : null}

        <GroupHeader>{t('申请内容')}</GroupHeader>
        <FormFields fields={d.form_schema.fields} data={d.form_data} files={d.files} />

        <GroupHeader>{t('审批进度')}</GroupHeader>
        <Track items={progressItems(d, t)} />
      </ScrollView>

      {caps.length > 0 ? (
        <View
          className="bg-card border-border flex-row gap-2 border-t px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          testID="wf-action-bar"
        >
          {more.length > 0 ? (
            <Button
              variant="outline"
              className="h-12 rounded-xl px-4"
              onPress={() => setSheet('more')}
              testID="wf-action-more"
              accessibilityLabel={t('更多')}
            >
              <Icon as={EllipsisIcon} className="size-5" />
            </Button>
          ) : null}
          {primary.map((c) => (
            <Button
              key={c.action}
              variant={c.action === 'approve' ? 'default' : 'outline'}
              disabled={!c.enabled || (c.action === 'approve' && resubmit)}
              className="h-12 flex-1 rounded-xl"
              onPress={() => setSheet(c.action)}
              testID={`wf-action-${c.action}`}
            >
              <Text className={`text-base font-semibold ${c.action === 'reject' ? 'text-destructive' : ''}`}>
                {t(ACTION_TEXT[c.action])}
              </Text>
            </Button>
          ))}
        </View>
      ) : null}

      <MoreSheet
        open={sheet === 'more'}
        caps={more}
        onClose={() => setSheet(null)}
        onPick={(a) => setSheet(a)}
      />
      {sheet && sheet !== 'more' ? (
        <ActionSheet
          key={sheet}
          action={sheet}
          detail={d}
          onClose={() => setSheet(null)}
          onDone={(a) => {
            setSheet(null)
            if (LEAVE_AFTER.includes(a)) {
              if (router.canGoBack()) router.back()
            }
          }}
        />
      ) : null}
    </View>
  )
}

/** 单被退回到发起人：他的那条待办在开始节点上（同 web `isResubmit`） */
function isResubmit(d: InstanceDetail): boolean {
  const mine = d.tasks.find((x) => x.id === d.my_task_id)
  return !!mine && mine.node_id === d.model.root.id
}

function Summary({ d }: { d: InstanceDetail }) {
  const { t } = useTranslation()
  const i = d.instance
  return (
    <View className="bg-card mx-4 mt-4 gap-2 rounded-2xl px-4 py-4">
      <View className="flex-row items-start gap-2">
        <Text className="flex-1 text-lg font-semibold leading-7" testID="wf-title">
          {i.title}
        </Text>
        <StatusBadge status={i.status} />
      </View>
      {i.summary ? <Text className="text-muted-foreground text-[13px] leading-5">{i.summary}</Text> : null}
      <View className="gap-1 pt-1">
        <Meta label={t('申请人')} value={i.initiator_name ?? '—'} />
        <Meta label={t('流程')} value={i.definition_name ?? '—'} />
        <Meta label={t('提交时间')} value={formatDateTime(i.created_time)} />
        {i.finished_time ? <Meta label={t('结束时间')} value={formatDateTime(i.finished_time)} /> : null}
        <Meta label={t('编号')} value={String(i.seq)} mono />
      </View>
    </View>
  )
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View className="flex-row gap-3">
      <Text className="text-muted-foreground w-[72px] text-[13px]">{label}</Text>
      <Text className={`flex-1 text-[13px] ${mono ? 'font-mono' : ''}`}>{value}</Text>
    </View>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <View className="px-4 pt-3">
      <Alert icon={InfoIcon}>
        <AlertDescription>{text}</AlertDescription>
      </Alert>
    </View>
  )
}

/** 「更多」：除同意 / 驳回以外的动作。服务端说不能做的画成灰的并写原因 */
function MoreSheet({
  open,
  caps,
  onClose,
  onPick,
}: {
  open: boolean
  caps: Capability[]
  onClose: () => void
  onPick: (a: Action) => void
}) {
  const { t } = useTranslation()
  return (
    <Overlay open={open} onClose={onClose} variant="bottom" testID="wf-more">
      <Text className="pb-2 text-base font-semibold">{t('更多操作')}</Text>
      <View className="bg-background overflow-hidden rounded-2xl">
        {caps.map((c, i) => (
          <Pressable
            key={c.action}
            disabled={!c.enabled}
            onPress={() => onPick(c.action)}
            testID={`wf-more-${c.action}`}
            className={`active:bg-muted flex-row items-center gap-3 px-4 py-3.5 ${i > 0 ? 'border-border border-t' : ''}`}
          >
            <View className="flex-1 gap-0.5">
              <Text className={`text-[15px] ${c.enabled ? (c.action === 'terminate' || c.action === 'withdraw' ? 'text-destructive' : '') : 'text-muted-foreground'}`}>
                {t(ACTION_TEXT[c.action])}
              </Text>
              {!c.enabled && c.reason ? <Text className="text-muted-foreground text-xs">{c.reason}</Text> : null}
            </View>
            {c.enabled ? <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" /> : null}
          </Pressable>
        ))}
      </View>
    </Overlay>
  )
}

/** 一个动作的面板：按 `NEED` 收意见 / 选人 / 选退回节点 / 选加签位置，然后提交 */
function ActionSheet({
  action,
  detail: d,
  onClose,
  onDone,
}: {
  action: Action
  detail: InstanceDetail
  onClose: () => void
  onDone: (a: Action) => void
}) {
  const { t } = useTranslation()
  const act = useAct(d.instance.id)
  const need = NEED[action]
  const pendingTasks = d.tasks.filter((x) => x.status === 'pending')

  const [opinion, setOpinion] = React.useState('')
  const [users, setUsers] = React.useState<{ id: string; name: string }[]>([])
  const [picking, setPicking] = React.useState(false)
  // 默认选最近的那一步（列表最后一个）；改办理人只有一条待办时直接选上（同 web）
  const [node, setNode] = React.useState<string | null>(d.send_back_targets.at(-1)?.node_id ?? null)
  const [resume, setResume] = React.useState(false)
  const [task, setTask] = React.useState<string | null>(pendingTasks.length === 1 ? pendingTasks[0].id : null)
  const [signMode, setSignMode] = React.useState<'before' | 'after'>('before')
  const [error, setError] = React.useState<string | null>(null)

  const ok =
    (need.opinion !== 'required' || opinion.trim().length > 0) &&
    (!need.users || users.length > 0) &&
    (!need.node || !!node) &&
    (!need.task || !!task)

  // 转交 / 改办理人 / 加签不能给发起人，也不能给这一步已经有份的人（服务端同样会拒）
  const exclude =
    action === 'transfer' || action === 'reassign' || action === 'add_sign'
      ? [d.instance.initiator_id, ...pendingTasks.map((x) => x.assignee_id)]
      : []

  async function submit() {
    if (!ok || act.isPending) return
    setError(null)
    const body: ActBody = { action, opinion: opinion.trim() || undefined }
    if (need.users) body.target_user_ids = users.map((u) => u.id)
    if (need.node && node) {
      body.target_node_id = node
      body.resume = resume
    }
    if (need.task && task) body.task_id = task
    if (need.sign) body.sign_mode = signMode
    try {
      await act.mutateAsync(body)
      toast.success(t(DONE_TEXT[action]))
      onDone(action)
    } catch (e) {
      // 409「已被他人处理」之类：留在面板里显示原因，详情已经在 `onSettled` 里重取了
      setError(e instanceof ApiError || e instanceof Error ? e.message : t('操作失败，请稍后重试'))
    }
  }

  const opinionLabel =
    action === 'transfer' || action === 'reassign' || action === 'add_sign'
      ? t('说明')
      : action === 'send_back'
        ? t('退回原因')
        : action === 'approve'
          ? t('审批意见')
          : t('原因')

  return (
    <>
      <Overlay open onClose={onClose} busy={act.isPending} variant="bottom" testID="wf-action-sheet">
        <View className="gap-4">
          <View className="gap-1">
            <Text className="text-lg font-semibold">{t(ACTION_TEXT[action])}</Text>
            {HINT[action] ? <Text className="text-muted-foreground text-[13px] leading-5">{t(HINT[action])}</Text> : null}
          </View>

          {need.node ? (
            <Field label={t('退回到')}>
              <Choices
                value={node}
                onChange={setNode}
                options={d.send_back_targets.map((x, i) => ({
                  value: x.node_id,
                  label: x.name,
                  hint: i === 0 ? t('改好后重新提交') : undefined,
                }))}
                testID="wf-back-targets"
              />
            </Field>
          ) : null}
          {need.node ? (
            <Field label={t('重新处理之后')}>
              <Choices
                value={resume ? 'me' : 'restart'}
                onChange={(v) => setResume(v === 'me')}
                options={[
                  { value: 'restart', label: t('照常往下走（后面的步骤再审一遍）') },
                  { value: 'me', label: t('直接回到我这一步') },
                ]}
              />
            </Field>
          ) : null}
          {need.sign ? (
            <Field label={t('加在')}>
              <Choices
                value={signMode}
                onChange={(v) => setSignMode(v as 'before' | 'after')}
                options={[
                  { value: 'before', label: t('我之前'), hint: t('他们都同意后，回到我这里再审') },
                  { value: 'after', label: t('我之后'), hint: t('我现在就同意，他们都同意后才往下走') },
                ]}
                testID="wf-sign-mode"
              />
            </Field>
          ) : null}
          {need.task && pendingTasks.length > 1 ? (
            <Field label={t('改哪一位的待办')}>
              <Choices
                value={task}
                onChange={setTask}
                options={pendingTasks.map((x) => ({ value: x.id, label: x.assignee_name, hint: x.node_name }))}
              />
            </Field>
          ) : null}
          {need.users ? (
            <Field
              label={
                action === 'cc'
                  ? t('抄送给')
                  : action === 'reassign'
                    ? t('改给')
                    : action === 'add_sign'
                      ? t('请谁一起审')
                      : t('转交给')
              }
            >
              <Pressable
                onPress={() => setPicking(true)}
                testID="wf-action-users"
                className="bg-background active:bg-muted flex-row items-center gap-2 rounded-xl px-4 py-3"
              >
                <Text className={`flex-1 text-[15px] ${users.length ? '' : 'text-muted-foreground'}`} numberOfLines={2}>
                  {users.length ? users.map((u) => u.name).join('、') : t('选择人员')}
                </Text>
                <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
              </Pressable>
            </Field>
          ) : null}
          {need.opinion ? (
            <Field label={need.opinion === 'required' ? `${opinionLabel} *` : opinionLabel}>
              <Input
                value={opinion}
                onChangeText={setOpinion}
                multiline
                maxLength={512}
                placeholder={
                  need.opinion === 'required'
                    ? action === 'reject'
                      ? t('驳回时请写明原因')
                      : t('必填')
                    : t('选填')
                }
                testID="wf-action-opinion"
                className="bg-background h-auto min-h-[88px] rounded-xl border-0 px-4 py-3 text-[15px]"
                style={{ textAlignVertical: 'top' }}
              />
            </Field>
          ) : null}

          {error ? (
            <Text className="text-destructive text-sm leading-5" testID="wf-action-error">
              {error}
            </Text>
          ) : null}

          <Button
            disabled={!ok || act.isPending}
            variant={action === 'reject' || action === 'terminate' || action === 'withdraw' ? 'destructive' : 'default'}
            onPress={() => void submit()}
            className="h-12 rounded-xl"
            testID="wf-action-submit"
          >
            {act.isPending ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Text className="text-base font-semibold">{t('确认{{a}}', { a: t(ACTION_TEXT[action]) })}</Text>
          </Button>
        </View>
      </Overlay>
      {need.users && picking ? (
        <UserPicker
          open
          multiple={need.users === 'many'}
          exclude={exclude}
          title={t(ACTION_TEXT[action])}
          onClose={() => setPicking(false)}
          onDone={(picked) => {
            setUsers(picked)
            setPicking(false)
          }}
        />
      ) : null}
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-muted-foreground text-[13px]">{label}</Text>
      {children}
    </View>
  )
}

function Choices({
  value,
  onChange,
  options,
  testID,
}: {
  value: string | null
  onChange: (v: string) => void
  options: { value: string; label: string; hint?: string }[]
  testID?: string
}) {
  return (
    <View className="bg-background overflow-hidden rounded-xl" testID={testID}>
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            testID={testID ? `${testID}-${o.value}` : undefined}
            className={`active:bg-muted flex-row items-center gap-3 px-4 py-3 ${i > 0 ? 'border-border border-t' : ''}`}
          >
            <View
              className={`size-5 items-center justify-center rounded-full border-2 ${on ? 'border-primary' : 'border-muted-foreground/40'}`}
            >
              {on ? <View className="bg-primary size-2.5 rounded-full" /> : null}
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-[15px]">{o.label}</Text>
              {o.hint ? <Text className="text-muted-foreground text-xs">{o.hint}</Text> : null}
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

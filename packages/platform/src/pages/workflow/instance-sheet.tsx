import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'
import { RadioGroup, RadioGroupItem } from '@admin/ui/components/radio-group'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'
import { Textarea } from '@admin/ui/components/textarea'
import { toast } from '@admin/ui/components/toast'
import { formatDateTime } from '@admin/i18n'

import { ApiError } from '../../api-client/errors'
import { meQuery } from '../../auth/queries'
import { useTabPortalContainer } from '../../shell/tab-outlet'
import { FormField as Row } from '../_shared/form-fields'
import {
  detailQuery, idempotencyKey, useAct, useMarkCcRead, useMarkTaskRead,
  type Action, type FormData, type InstanceDetail,
} from './api'
import { AiReviewPanel } from './ai-review-panel'
import { FlowView } from './flow-view'
import { FormRenderer, missingRequired } from './form-renderer'
import { UserSelect } from './pickers'
import { progressItems } from './progress'
import { InstanceStatusPill } from './status'
import { ApprovalTrack, PersonAvatar, UrgentTag } from './track'

/**
 * 审批详情（右侧抽屉）。审批中心和实例监控共用。
 *
 * 左边是申请内容，右边是审批进度（审批轨道：已办的、正在等谁、后面还有谁）。
 * 审批人的意见框直接放在底部 —— 同意 / 驳回是最高频的两个动作，不该再弹一层。
 *
 * 🔴 **按钮只按能力信封渲染**（`capabilities`），不根据实例状态自己推导 ——
 * 同一个函数在服务端也用来判定执行，前端推出来的规则迟早和它漂移。
 */
export function InstanceSheet({
  id, onClose, onResubmit,
}: {
  id: string | null
  onClose: () => void
  /** 给了才有「重新发起」（审批中心给，实例监控不给）：用这张单的内容新开一张 */
  onResubmit?: (code: string, fromId: string) => void
}) {
  const { t } = useTranslation()
  // 抽屉开在 URL 上：portal 挂进本 tab 的根节点，后台时跟着 tab 一起隐藏、状态不丢（见 `useTabPortalContainer` 的注释）
  const container = useTabPortalContainer()
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        container={container}
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:w-3/4 data-[side=right]:sm:max-w-5xl" data-testid="wf-instance-sheet">
        {id ? (
          <Body id={id} onClose={onClose} onResubmit={onResubmit} />
        ) : (
          <SheetTitle className="sr-only">{t('审批详情')}</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Body({
  id, onClose, onResubmit,
}: {
  id: string
  onClose: () => void
  onResubmit?: (code: string, fromId: string) => void
}) {
  const { t } = useTranslation()
  const query = useQuery(detailQuery(id))
  const markCc = useMarkCcRead()
  const me = useQuery(meQuery).data
  const d = query.data

  // 抄送人打开详情 = 读过了。只有自己是抄送人且还没读时才发：接口幂等，但每次打开都发是纯噪音
  const unreadCc = !!d && !!me && d.ccs.some((c) => c.user_id === me.id && !c.read_time)
  const { mutate: markCcRead } = markCc
  React.useEffect(() => {
    if (unreadCc) markCcRead(id)
  }, [unreadCc, id, markCcRead])
  // 办理人打开 = 已读（发起人在进度里看得到「已读 / 未读」）。同样只在自己有没读的待办时才发
  const { mutate: markTaskRead } = useMarkTaskRead()
  const unreadTask =
    !!d && !!me && d.tasks.some((x) => x.assignee_id === me.id && x.status === 'pending' && !x.read_time)
  React.useEffect(() => {
    if (unreadTask) markTaskRead(id)
  }, [unreadTask, id, markTaskRead])

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <SheetTitle className="sr-only">{t('审批详情')}</SheetTitle>
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (query.error || !d) {
    return (
      <div className="p-6">
        <SheetTitle className="sr-only">{t('审批详情')}</SheetTitle>
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      </div>
    )
  }
  // 被驳回 / 撤回之后**不能改了复活**（#107 生命周期第 3 条），要重新提交就复制成一张新单
  const canResubmit =
    !!onResubmit && !!me && d.instance.initiator_id === me.id && ['rejected', 'withdrawn'].includes(d.instance.status)
  return (
    <Detail
      detail={d}
      onDone={onClose}
      onResubmit={canResubmit ? () => onResubmit?.(d.instance.definition_code, d.instance.id) : undefined}
    />
  )
}

function Detail({
  detail: d, onDone, onResubmit,
}: {
  detail: InstanceDetail
  onDone: () => void
  onResubmit?: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = React.useState('form')
  // 审批人可编辑的字段：草稿只存「改了的那几个」，同意时一起提交
  const [patch, setPatch] = React.useState<FormData>({})
  const editable = React.useMemo(
    () => new Set(Object.entries(d.field_perms).filter(([, p]) => p === 'editable').map(([k]) => k)),
    [d.field_perms]
  )
  const merged = React.useMemo(() => ({ ...d.form_data, ...patch }), [d.form_data, patch])
  // 被退回后重新提交：「发起人自选」节点的人（预填上次选的）
  const [picks, setPicks] = React.useState<Record<string, string[]>>(() =>
    Object.fromEntries(d.select_nodes.map((n) => [n.id, n.selected]))
  )
  const track = React.useMemo(() => progressItems(d, t), [d, t])
  // 被退回到自己手上：最近那条退回记录说了什么
  const sentBack = isResubmit(d)
    ? [...d.records].reverse().find((r) => r.action === 'send_back' && r.detail?.to === d.model.root.id)
    : undefined

  return (
    <>
      <header className="flex items-start gap-3 border-b px-6 pt-5 pb-4 pe-14">
        <PersonAvatar name={d.instance.initiator_name ?? ''} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <SheetTitle className="truncate text-lg" data-testid="wf-title">{d.instance.title}</SheetTitle>
            <InstanceStatusPill status={d.instance.status} />
            {d.instance.urgent && <UrgentTag />}
          </div>
          <SheetDescription className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            <span>{d.instance.definition_name}</span>
            <span>{t('提交于 {{at}}', { at: formatDateTime(d.instance.created_time) })}</span>
            <span className="font-mono">{t('编号 {{n}}', { n: d.instance.id })}</span>
          </SheetDescription>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b px-6">
          <TabsList variant="line">
            <TabsTrigger value="form" data-testid="wf-tab-form">{t('审批详情')}</TabsTrigger>
            <TabsTrigger value="flow" data-testid="wf-tab-flow">{t('流程图')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="form" keepMounted className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_22rem]">
            <section className="flex flex-col gap-4 px-6 py-5">
              {sentBack && (
                <div
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  data-testid="wf-sent-back"
                >
                  <p className="font-medium">{t('{{n}} 退回了你的申请', { n: sentBack.actor_name ?? '' })}</p>
                  {sentBack.opinion && <p className="mt-0.5 whitespace-pre-wrap">{sentBack.opinion}</p>}
                  <p className="mt-1 text-xs opacity-80">{t('改好之后点「重新提交」，审批从头开始')}</p>
                </div>
              )}
              <AiReviewPanel id={d.instance.id} schema={d.form_schema} />
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{t('申请内容')}</h3>
              <FormRenderer
                schema={d.form_schema}
                value={merged}
                mode="view"
                perms={d.field_perms}
                files={d.files}
                onChange={(v) => {
                  const next: FormData = {}
                  for (const k of editable) if (k in v) next[k] = v[k]
                  setPatch(next)
                }}
              />
              {d.select_nodes.map((n) => (
                <Row key={n.id} label={t('{{node}}：选择审批人', { node: n.name })}>
                  <UserSelect
                    value={picks[n.id] ?? []}
                    multiple
                    onChange={(v) => setPicks({ ...picks, [n.id]: v })}
                    testId={`wf-resubmit-select-${n.id}`}
                  />
                </Row>
              ))}
              {/* 被退回的发起人：顶上的横幅已经说了怎么做，这句是给审批人的 */}
              {editable.size > 0 && !sentBack && (
                <p className="rounded-md border-s-2 border-primary bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {t('带输入框的字段由你在这一步填写，同意时一起提交')}
                </p>
              )}
            </section>
            <aside
              className="flex flex-col gap-4 border-t bg-muted/30 px-5 py-5 lg:border-t-0 lg:border-s"
              data-testid="wf-timeline"
            >
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{t('审批进度')}</h3>
              <ApprovalTrack items={track} />
              {d.ccs.length > 0 && (
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  {t('已抄送')}：{d.ccs.map((c) => c.user_name).join('、')}
                </p>
              )}
            </aside>
          </div>
        </TabsContent>
        <TabsContent value="flow" keepMounted className="min-h-0 flex-1 overflow-auto bg-muted/30">
          <FlowView
            model={d.model}
            form={d.form_schema}
            editable={false}
            state={d.node_state}
            userName={(id) => d.names.users[id] ?? id}
            roleName={(id) => d.names.roles[id] ?? id}
          />
        </TabsContent>
      </Tabs>
      {onResubmit ? (
        <footer className="flex items-center gap-3 border-t bg-background px-6 py-4">
          <span className="text-sm text-muted-foreground">
            {t('这张单已经结束，改不了了。可以用它的内容重新发起一张新的。')}
          </span>
          <Button className="ms-auto" onClick={onResubmit} data-testid="wf-resubmit">
            {t('重新发起')}
          </Button>
        </footer>
      ) : (
        <ActionBar
          detail={d}
          patch={patch}
          picks={picks}
          editable={editable}
          onDone={onDone}
          onResetPatch={() => setPatch({})}
        />
      )}
    </>
  )
}

// ── 动作台 ───────────────────────────────────────────────────────────────────

/** 单被退回到发起人：他的那条待办在开始节点上 */
function isResubmit(d: InstanceDetail): boolean {
  const mine = d.tasks.find((x) => x.id === d.my_task_id)
  return !!mine && mine.node_id === d.model.root.id
}

const ACTION_TEXT: Record<Action, string> = {
  approve: '同意',
  reject: '驳回',
  withdraw: '撤回',
  transfer: '转交',
  cc: '抄送',
  remind: '催办',
  terminate: '终止',
  send_back: '退回',
  reassign: '改办理人',
  take_back: '拿回',
  add_sign: '加签',
}

const DONE_TEXT: Record<Action, string> = {
  approve: '已同意',
  reject: '已驳回',
  withdraw: '已撤回',
  transfer: '已转交',
  cc: '已抄送',
  remind: '已催办',
  terminate: '已终止',
  send_back: '已退回',
  reassign: '已改办理人',
  take_back: '已拿回',
  add_sign: '已加签',
}

const DIALOG_TEXT: Partial<Record<Action, string>> = {
  withdraw: '撤回后这张审批单作废，已经审批过的人会收到通知。',
  terminate: '终止后审批立即结束，发起人会收到通知。',
  transfer: '转交后这条待办交给对方处理，你的待办随之结束。',
  cc: '对方会收到通知，并能在「抄送我的」里看到这张单。',
  send_back: '单子回到你选的那一步重新处理，这一步的待办随之结束。退回给发起人时，由发起人改好后重新提交。',
  reassign: '把这条待办交给另一个人处理，不需要原办理人同意。适合办理人离职或长期不在。',
  add_sign: '临时请别人一起审这一步，他们都同意才算数。',
}

type DialogNeed = {
  opinion?: 'optional' | 'required'
  users?: 'one' | 'many'
  /** 退回：选退到哪一步 */
  node?: true
  /** 改办理人：选改哪一条待办 */
  task?: true
  /** 加签：在我之前 / 之后 */
  sign?: true
}

/** 要先在弹窗里选人 / 写原因的动作。同意 / 驳回的意见在底部输入框里，不弹窗 */
const DIALOG: Partial<Record<Action, DialogNeed>> = {
  transfer: { users: 'one', opinion: 'optional' },
  cc: { users: 'many' },
  withdraw: { opinion: 'required' },
  terminate: { opinion: 'required' },
  send_back: { node: true, opinion: 'required' },
  reassign: { task: true, users: 'one', opinion: 'optional' },
  add_sign: { sign: true, users: 'many', opinion: 'optional' },
}

type Extra = {
  opinion?: string
  target_user_ids?: string[]
  target_node_id?: string
  task_id?: string
  resume?: boolean
  sign_mode?: 'before' | 'after'
}

function ActionBar({
  detail: d, patch, picks, editable, onDone, onResetPatch,
}: {
  detail: InstanceDetail
  patch: FormData
  picks: Record<string, string[]>
  editable: Set<string>
  onDone: () => void
  onResetPatch: () => void
}) {
  const { t } = useTranslation()
  const act = useAct(d.instance.id)
  const [dialog, setDialog] = React.useState<Action | null>(null)
  const [opinion, setOpinion] = React.useState('')
  const [opinionError, setOpinionError] = React.useState(false)
  const cap = (a: Action) => d.capabilities.find((c) => c.action === a)
  const resubmit = isResubmit(d)

  if (d.capabilities.length === 0) return null

  async function run(action: Action, extra: Extra = {}) {
    const body: Parameters<typeof act.mutateAsync>[0] = { action, key: idempotencyKey(), ...extra }
    // 「在我之后」加签 = 我这一票是同意：和同意一样要过本节点的必填、带上我改的字段
    if (action === 'approve' || (action === 'add_sign' && extra.sign_mode === 'after')) {
      const missing = missingRequired(d.form_schema, { ...d.form_data, ...patch }, editable)
      if (Object.keys(missing).length) {
        toast.error(t('请先填写：{{f}}', { f: Object.values(missing).join('、') }))
        return false
      }
      if (Object.keys(patch).length) body.form = patch
      if (action === 'approve' && resubmit && d.select_nodes.length) body.selected = picks
    }
    try {
      await act.mutateAsync(body)
      toast.success(resubmit && action === 'approve' ? t('已重新提交') : t(DONE_TEXT[action]))
      onResetPatch()
      setOpinion('')
      // 办完自己那一步就关掉；撤回 / 催办 / 管理员改办理人之后留在详情里看结果
      if (['approve', 'reject', 'transfer', 'send_back', 'add_sign'].includes(action)) onDone()
      return true
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('操作失败，请稍后重试'))
      return false
    }
  }

  const btn = (a: Action, variant: 'default' | 'outline' | 'ghost', onClick: () => void) => {
    const c = cap(a)
    if (!c) return null
    const danger = a === 'reject' || a === 'terminate'
    return (
      <Button
        key={a}
        variant={variant}
        className={danger ? 'text-destructive hover:text-destructive' : undefined}
        disabled={!c.enabled || act.isPending}
        title={c.reason ?? undefined}
        onClick={onClick}
        data-testid={`wf-act-${a}`}
      >
        {act.isPending && act.variables?.action === a && <IconLoader2 className="size-4 animate-spin" />}
        {a === 'approve' && resubmit ? t('重新提交') : t(ACTION_TEXT[a])}
      </Button>
    )
  }

  return (
    <footer className="flex flex-col gap-3 border-t bg-background px-6 py-4" data-testid="wf-actions">
      {cap('approve') && (
        <div className="flex flex-col gap-1">
          <Textarea
            rows={2}
            maxLength={512}
            value={opinion}
            placeholder={resubmit ? t('补充说明（可选）') : t('审批意见（驳回时必填）')}
            aria-invalid={opinionError || undefined}
            onChange={(e) => {
              setOpinion(e.target.value)
              setOpinionError(false)
            }}
            data-testid="wf-action-opinion"
          />
          {opinionError && <span className="text-xs text-destructive">{t('驳回时请写明原因')}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {btn('transfer', 'ghost', () => setDialog('transfer'))}
        {btn('cc', 'ghost', () => setDialog('cc'))}
        {btn('add_sign', 'ghost', () => setDialog('add_sign'))}
        {btn('reassign', 'ghost', () => setDialog('reassign'))}
        {btn('terminate', 'ghost', () => setDialog('terminate'))}
        <span className="ms-auto flex gap-2">
          {btn('take_back', 'outline', () => run('take_back'))}
          {btn('remind', 'outline', () => run('remind'))}
          {btn('withdraw', 'outline', () => setDialog('withdraw'))}
          {btn('send_back', 'outline', () => setDialog('send_back'))}
          {btn('reject', 'outline', () => {
            if (!opinion.trim()) {
              setOpinionError(true)
              return
            }
            run('reject', { opinion: opinion.trim() })
          })}
          {btn('approve', 'default', () => run('approve', { opinion: opinion.trim() || undefined }))}
        </span>
      </div>
      <ActionDialog
        action={dialog}
        detail={d}
        pending={act.isPending}
        onClose={() => setDialog(null)}
        onSubmit={async (extra) => {
          if (dialog && (await run(dialog, extra))) setDialog(null)
        }}
      />
    </footer>
  )
}

function ActionDialog({
  action, detail: d, pending, onClose, onSubmit,
}: {
  action: Action | null
  detail: InstanceDetail
  pending: boolean
  onClose: () => void
  onSubmit: (extra: Extra) => void
}) {
  const { t } = useTranslation()
  const [opinion, setOpinion] = React.useState('')
  const [users, setUsers] = React.useState<string[]>([])
  const [node, setNode] = React.useState<string | null>(null)
  const [task, setTask] = React.useState<string | null>(null)
  const [resume, setResume] = React.useState(false)
  const [signMode, setSignMode] = React.useState<'before' | 'after'>('before')
  const pendingTasks = React.useMemo(() => d.tasks.filter((x) => x.status === 'pending'), [d.tasks])
  React.useEffect(() => {
    if (action) {
      setOpinion('')
      setUsers([])
      // 默认选最近的那一步（列表最后一个）；改办理人只有一条待办时直接选上
      setNode(d.send_back_targets.at(-1)?.node_id ?? null)
      setTask(pendingTasks.length === 1 ? pendingTasks[0].id : null)
      setResume(false)
      setSignMode('before')
    }
  }, [action, d.send_back_targets, pendingTasks])
  const need = action ? DIALOG[action] : undefined
  const okOpinion = need?.opinion !== 'required' || opinion.trim().length > 0
  const okUsers = !need?.users || users.length > 0
  const okNode = !need?.node || !!node
  const okTask = !need?.task || !!task
  const text = action ? DIALOG_TEXT[action] : undefined
  // 转交 / 改办理人不能给发起人，也不能给这一步里已经有份的人（服务端同样会拒）
  const exclude =
    action === 'transfer' || action === 'reassign' || action === 'add_sign'
      ? [d.instance.initiator_id, ...pendingTasks.map((x) => x.assignee_id)]
      : undefined

  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="wf-action-dialog">
        <DialogHeader>
          <DialogTitle>{action ? t(ACTION_TEXT[action]) : ''}</DialogTitle>
          <DialogDescription>{text ? t(text) : ''}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-4">
          {need?.node && (
            <Row label={t('退回到')} required>
              <RadioGroup value={node} onValueChange={(v) => setNode(String(v))} className="gap-2" data-testid="wf-back-targets">
                {d.send_back_targets.map((x, i) => (
                  <label
                    key={x.node_id}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-data-checked:border-primary has-data-checked:bg-primary/5"
                  >
                    <RadioGroupItem value={x.node_id} data-testid={`wf-back-${x.node_id}`} />
                    <span>{x.name}</span>
                    {i === 0 && <span className="ms-auto text-xs text-muted-foreground">{t('改好后重新提交')}</span>}
                  </label>
                ))}
              </RadioGroup>
            </Row>
          )}
          {need?.node && (
            <Row label={t('重新处理之后')}>
              <RadioGroup
                value={resume ? 'me' : 'restart'}
                onValueChange={(v) => setResume(v === 'me')}
                className="gap-2"
                data-testid="wf-back-resume"
              >
                {(
                  [
                    ['restart', t('照常往下走（后面的步骤再审一遍）')],
                    ['me', t('直接回到我这一步')],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="flex cursor-pointer items-center gap-2 text-sm">
                    <RadioGroupItem value={v} data-testid={`wf-back-resume-${v}`} />
                    {label}
                  </label>
                ))}
              </RadioGroup>
            </Row>
          )}
          {need?.sign && (
            <Row label={t('加在')} required>
              <RadioGroup
                value={signMode}
                onValueChange={(v) => setSignMode(v as 'before' | 'after')}
                className="gap-2"
                data-testid="wf-sign-mode"
              >
                {(
                  [
                    ['before', t('我之前'), t('他们都同意后，回到我这里再审')],
                    ['after', t('我之后'), t('我现在就同意，他们都同意后才往下走')],
                  ] as const
                ).map(([v, label, hint]) => (
                  <label
                    key={v}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-data-checked:border-primary has-data-checked:bg-primary/5"
                  >
                    <RadioGroupItem value={v} data-testid={`wf-sign-${v}`} />
                    <span>{label}</span>
                    <span className="ms-auto text-xs text-muted-foreground">{hint}</span>
                  </label>
                ))}
              </RadioGroup>
            </Row>
          )}
          {need?.task && pendingTasks.length > 1 && (
            <Row label={t('改哪一位的待办')} required>
              <RadioGroup value={task} onValueChange={(v) => setTask(String(v))} className="gap-2">
                {pendingTasks.map((x) => (
                  <label
                    key={x.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-data-checked:border-primary has-data-checked:bg-primary/5"
                  >
                    <RadioGroupItem value={x.id} />
                    <span>{x.assignee_name}</span>
                    <span className="ms-auto text-xs text-muted-foreground">{x.node_name}</span>
                  </label>
                ))}
              </RadioGroup>
            </Row>
          )}
          {need?.task && pendingTasks.length === 1 && (
            <p className="text-sm text-muted-foreground">
              {t('当前办理人：{{n}}（{{node}}）', { n: pendingTasks[0].assignee_name, node: pendingTasks[0].node_name })}
            </p>
          )}
          {need?.users && (
            <Row
              label={action === 'cc' ? t('抄送给') : action === 'reassign' ? t('改给') : action === 'add_sign' ? t('请谁一起审') : t('转交给')}
              required
            >
              <UserSelect
                value={users}
                onChange={setUsers}
                multiple={need.users === 'many'}
                exclude={exclude}
                testId="wf-action-users"
              />
            </Row>
          )}
          {need?.opinion && (
            <Row
              label={action === 'transfer' || action === 'reassign' || action === 'add_sign' ? t('说明') : action === 'send_back' ? t('退回原因') : t('原因')}
              required={need.opinion === 'required'}
            >
              <Textarea
                rows={3}
                value={opinion}
                maxLength={512}
                onChange={(e) => setOpinion(e.target.value)}
                data-testid="wf-dialog-opinion"
              />
            </Row>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>{t('取消')}</DialogClose>
          <Button
            variant={action === 'terminate' || action === 'withdraw' ? 'destructive' : 'default'}
            disabled={!okOpinion || !okUsers || !okNode || !okTask || pending}
            onClick={() =>
              onSubmit({
                opinion: opinion.trim() || undefined,
                target_user_ids: users.length ? users : undefined,
                target_node_id: need?.node ? (node ?? undefined) : undefined,
                task_id: need?.task ? (task ?? undefined) : undefined,
                resume: need?.node ? resume : undefined,
                sign_mode: need?.sign ? signMode : undefined,
              })
            }
            data-testid="wf-action-submit"
          >
            {pending && <IconLoader2 className="size-4 animate-spin" />}
            {action ? t(ACTION_TEXT[action]) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [
    t('同意'), t('驳回'), t('撤回'), t('转交'), t('抄送'), t('催办'), t('终止'), t('退回'), t('改办理人'),
    t('已同意'), t('已驳回'), t('已撤回'), t('已转交'), t('已抄送'), t('已催办'), t('已终止'), t('已退回'),
    t('已改办理人'),
    t('撤回后这张审批单作废，已经审批过的人会收到通知。'), t('终止后审批立即结束，发起人会收到通知。'),
    t('转交后这条待办交给对方处理，你的待办随之结束。'), t('对方会收到通知，并能在「抄送我的」里看到这张单。'),
    t('单子回到你选的那一步重新处理，这一步的待办随之结束。退回给发起人时，由发起人改好后重新提交。'),
    t('把这条待办交给另一个人处理，不需要原办理人同意。适合办理人离职或长期不在。'),
    t('拿回'), t('加签'), t('已拿回'), t('已加签'), t('临时请别人一起审这一步，他们都同意才算数。'),
  ]
}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'
import { Textarea } from '@admin/ui/components/textarea'
import { toast } from '@admin/ui/components/toast'
import { cn } from '@admin/ui/lib/utils'
import { formatDateTime } from '@admin/i18n'

import { ApiError } from '../../api-client/errors'
import { meQuery } from '../../auth/queries'
import { FormField as Row } from '../_shared/form-fields'
import {
  detailQuery, idempotencyKey, useAct, useMarkCcRead,
  type Action, type FormData, type InstanceDetail, type RecordRow,
} from './api'
import { FlowView } from './flow-view'
import { FormRenderer, missingRequired } from './form-renderer'
import { UserSelect } from './pickers'
import { InstanceStatusPill } from './status'

/**
 * 审批详情（右侧抽屉）。审批中心和实例监控共用。
 *
 * 🔴 **按钮只按能力信封渲染**（`capabilities`），不根据实例状态自己推导 ——
 * 同一个函数在服务端也用来判定执行，前端推出来的规则迟早和它漂移。
 */
export function InstanceSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-5xl" data-testid="wf-instance-sheet">
        {id ? <Body id={id} onClose={onClose} /> : <SheetTitle className="sr-only">{t('审批详情')}</SheetTitle>}
      </SheetContent>
    </Sheet>
  )
}

function Body({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation()
  const query = useQuery(detailQuery(id))
  const markCc = useMarkCcRead()
  const [tab, setTab] = React.useState('form')

  const me = useQuery(meQuery).data
  const d = query.data
  // 抄送人打开详情 = 读过了。只有自己是抄送人且还没读时才发：接口幂等，但每次打开都发是纯噪音
  const unreadCc = !!d && !!me && d.ccs.some((c) => c.user_id === me.id && !c.read_time)
  const { mutate: markCcRead } = markCc
  React.useEffect(() => {
    if (unreadCc) markCcRead(id)
  }, [unreadCc, id, markCcRead])

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <SheetTitle className="sr-only">{t('审批详情')}</SheetTitle>
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-40 w-full" />
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

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2 pe-8">
          <SheetTitle className="truncate" data-testid="wf-title">{d.instance.title}</SheetTitle>
          <InstanceStatusPill status={d.instance.status} />
        </div>
        <SheetDescription>
          {d.instance.definition_name} · {d.instance.initiator_name} · {formatDateTime(d.instance.created_time)}
        </SheetDescription>
      </SheetHeader>
      <DetailBody detail={d} tab={tab} onTab={setTab} onDone={onClose} />
    </>
  )
}

function DetailBody({
  detail: d, tab, onTab, onDone,
}: {
  detail: InstanceDetail
  tab: string
  onTab: (v: string) => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  // 审批人可编辑的字段：草稿只存「改了的那几个」，同意时一起提交
  const [patch, setPatch] = React.useState<FormData>({})
  const editable = React.useMemo(
    () => new Set(Object.entries(d.field_perms).filter(([, p]) => p === 'editable').map(([k]) => k)),
    [d.field_perms]
  )
  const merged = React.useMemo(() => ({ ...d.form_data, ...patch }), [d.form_data, patch])

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => onTab(String(v))} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b px-4">
          <TabsList variant="line">
            <TabsTrigger value="form" data-testid="wf-tab-form">{t('审批内容')}</TabsTrigger>
            <TabsTrigger value="flow" data-testid="wf-tab-flow">{t('流程图')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="form" keepMounted className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <FormRenderer
              schema={d.form_schema}
              value={merged}
              mode="view"
              perms={d.field_perms}
              onChange={(v) => {
                const next: FormData = {}
                for (const k of editable) if (k in v) next[k] = v[k]
                setPatch(next)
              }}
            />
            <Timeline detail={d} />
          </div>
        </TabsContent>
        <TabsContent value="flow" keepMounted className="min-h-0 flex-1 overflow-auto">
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
      <ActionBar detail={d} patch={patch} editable={editable} onDone={onDone} onResetPatch={() => setPatch({})} />
    </>
  )
}

// ── 审批记录 ─────────────────────────────────────────────────────────────────

const ACTION_TEXT: Record<string, string> = {
  start: '发起申请',
  approve: '同意',
  reject: '驳回',
  withdraw: '撤回',
  transfer: '转交',
  cc: '抄送',
  remind: '催办',
  terminate: '终止',
  skip: '自动跳过',
  auto_reject: '自动驳回',
}

const ACTION_TONE: Record<string, string> = {
  approve: 'bg-emerald-500',
  start: 'bg-primary',
  reject: 'bg-destructive',
  auto_reject: 'bg-destructive',
  terminate: 'bg-destructive',
  withdraw: 'bg-muted-foreground',
}

function Timeline({ detail: d }: { detail: InstanceDetail }) {
  const { t } = useTranslation()
  // 分支选择是系统内部动作，对人没有信息量（流程图上已经高亮了走的哪条）
  const rows = d.records.filter((r) => r.action !== 'branch')
  const pending = d.tasks.filter((x) => x.status === 'pending')
  const pendingNode = pending[0]?.node_name
  return (
    <section className="flex flex-col gap-3" data-testid="wf-timeline">
      <h3 className="text-sm font-medium">{t('审批记录')}</h3>
      <ol className="relative flex flex-col gap-4 border-s ps-4">
        {rows.map((r) => <TimelineItem key={r.id} r={r} />)}
        {pending.length > 0 && (
          <li className="relative" data-testid="wf-timeline-pending">
            <span className="absolute -start-[1.32rem] top-1.5 size-2.5 rounded-full bg-amber-500 ring-4 ring-background" />
            <p className="text-sm font-medium">{pendingNode} · {t('审批中')}</p>
            <p className="text-sm text-muted-foreground">{pending.map((x) => x.assignee_name).join('、')}</p>
          </li>
        )}
      </ol>
      {d.ccs.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('已抄送')}：{d.ccs.map((c) => c.user_name).join('、')}
        </p>
      )}
    </section>
  )
}

function TimelineItem({ r }: { r: RecordRow }) {
  const { t } = useTranslation()
  const who = r.actor_type === 'system' ? t('系统') : r.actor_name
  const changes = r.detail?.form_changes ? Object.keys(r.detail.form_changes).length : 0
  return (
    <li className="relative">
      <span
        className={cn(
          'absolute -start-[1.32rem] top-1.5 size-2.5 rounded-full ring-4 ring-background',
          ACTION_TONE[r.action] ?? 'bg-sky-500'
        )}
      />
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{who}</span>
        <span>{t(ACTION_TEXT[r.action] ?? r.action)}</span>
        {r.target_user_name && <span className="text-muted-foreground">→ {r.target_user_name}</span>}
      </p>
      <p className="text-xs text-muted-foreground">
        {r.node_name ? `${r.node_name} · ` : ''}{formatDateTime(r.created_time)}
      </p>
      {r.opinion && <p className="mt-1 rounded-md bg-muted/60 px-2 py-1 text-sm whitespace-pre-wrap">{r.opinion}</p>}
      {changes > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('修改了 {{n}} 个字段', { n: changes })}</p>}
    </li>
  )
}

// ── 动作台 ───────────────────────────────────────────────────────────────────

const ACTION_ORDER: Action[] = ['approve', 'reject', 'transfer', 'cc', 'remind', 'withdraw', 'terminate']

/** 需要先在弹窗里填东西的动作，以及「必填什么」 */
const NEEDS: Partial<Record<Action, { opinion?: 'optional' | 'required'; users?: 'one' | 'many' }>> = {
  approve: { opinion: 'optional' },
  reject: { opinion: 'required' },
  transfer: { users: 'one', opinion: 'optional' },
  cc: { users: 'many' },
  withdraw: { opinion: 'required' },
  terminate: { opinion: 'required' },
}

function ActionBar({
  detail: d, patch, editable, onDone, onResetPatch,
}: {
  detail: InstanceDetail
  patch: FormData
  editable: Set<string>
  onDone: () => void
  onResetPatch: () => void
}) {
  const { t } = useTranslation()
  const act = useAct(d.instance.id)
  const [dialog, setDialog] = React.useState<Action | null>(null)
  const caps = ACTION_ORDER.map((a) => d.capabilities.find((c) => c.action === a)).filter((c) => c !== undefined)

  // 按钮平铺，不收进「更多」（avc-bp `1d0ef871`：一个节点通常只剩两三个动作）
  if (caps.length === 0) return null

  async function run(action: Action, extra: { opinion?: string; target_user_ids?: string[] }) {
    const body: Parameters<typeof act.mutateAsync>[0] = { action, key: idempotencyKey(), ...extra }
    if (action === 'approve' && Object.keys(patch).length) {
      const missing = missingRequired(d.form_schema, { ...d.form_data, ...patch }, editable)
      if (Object.keys(missing).length) {
        toast.error(t('请先填写：{{f}}', { f: Object.values(missing).join('、') }))
        return false
      }
      body.form = patch
    }
    try {
      await act.mutateAsync(body)
      toast.success(t('已{{a}}', { a: t(ACTION_TEXT[action]) }))
      onResetPatch()
      // 审批人办完就关掉；发起人撤回 / 催办之后留在详情里看结果
      if (action === 'approve' || action === 'reject' || action === 'transfer') onDone()
      return true
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('操作失败，请稍后重试'))
      return false
    }
  }

  return (
    <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t" data-testid="wf-actions">
      {caps.map((c) => {
        const primary = c.action === 'approve'
        const danger = c.action === 'reject' || c.action === 'terminate'
        return (
          <Button
            key={c.action}
            variant={primary ? 'default' : danger ? 'destructive' : 'outline'}
            disabled={!c.enabled || act.isPending}
            title={c.reason ?? undefined}
            onClick={() => (NEEDS[c.action] ? setDialog(c.action) : run(c.action, {}))}
            data-testid={`wf-act-${c.action}`}
          >
            {act.isPending && act.variables?.action === c.action && <IconLoader2 className="size-4 animate-spin" />}
            {t(ACTION_TEXT[c.action])}
          </Button>
        )
      })}
      <ActionDialog
        action={dialog}
        initiatorId={d.instance.initiator_id}
        pending={act.isPending}
        onClose={() => setDialog(null)}
        onSubmit={async (extra) => {
          if (dialog && (await run(dialog, extra))) setDialog(null)
        }}
      />
    </SheetFooter>
  )
}

function ActionDialog({
  action, initiatorId, pending, onClose, onSubmit,
}: {
  action: Action | null
  initiatorId: string
  pending: boolean
  onClose: () => void
  onSubmit: (extra: { opinion?: string; target_user_ids?: string[] }) => void
}) {
  const { t } = useTranslation()
  const [opinion, setOpinion] = React.useState('')
  const [users, setUsers] = React.useState<string[]>([])
  React.useEffect(() => {
    if (action) {
      setOpinion('')
      setUsers([])
    }
  }, [action])
  const need = action ? NEEDS[action] : undefined
  const okOpinion = need?.opinion !== 'required' || opinion.trim().length > 0
  const okUsers = !need?.users || users.length > 0

  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="wf-action-dialog">
        <DialogHeader>
          <DialogTitle>{action ? t(ACTION_TEXT[action]) : ''}</DialogTitle>
          <DialogDescription>
            {action === 'withdraw'
              ? t('撤回后这张审批单作废，已经审批过的人会收到通知。')
              : action === 'terminate'
                ? t('终止后审批立即结束，发起人会收到通知。')
                : action === 'transfer'
                  ? t('转交后这条待办交给对方处理，你的待办随之结束。')
                  : t('意见会记入审批记录。')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-4">
          {need?.users && (
            <Row label={action === 'cc' ? t('抄送给') : t('转交给')} required>
              <UserSelect
                value={users}
                onChange={setUsers}
                multiple={need.users === 'many'}
                exclude={action === 'transfer' ? [initiatorId] : undefined}
                testId="wf-action-users"
              />
            </Row>
          )}
          {need?.opinion && (
            <Row
              label={action === 'withdraw' || action === 'terminate' ? t('原因') : t('审批意见')}
              required={need.opinion === 'required'}
            >
              <Textarea
                rows={3}
                value={opinion}
                maxLength={512}
                onChange={(e) => setOpinion(e.target.value)}
                data-testid="wf-action-opinion"
              />
            </Row>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>{t('取消')}</DialogClose>
          <Button
            disabled={!okOpinion || !okUsers || pending}
            onClick={() =>
              onSubmit({ opinion: opinion.trim() || undefined, target_user_ids: users.length ? users : undefined })
            }
            data-testid="wf-action-submit"
          >
            {pending && <IconLoader2 className="size-4 animate-spin" />}
            {t('确定')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [
    t('发起申请'), t('同意'), t('驳回'), t('撤回'), t('转交'), t('抄送'), t('催办'), t('终止'),
    t('自动跳过'), t('自动驳回'),
  ]
}

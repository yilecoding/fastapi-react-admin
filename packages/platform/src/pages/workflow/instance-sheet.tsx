import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'
import { Textarea } from '@admin/ui/components/textarea'
import { toast } from '@admin/ui/components/toast'
import { formatDateTime } from '@admin/i18n'

import { ApiError } from '../../api-client/errors'
import { meQuery } from '../../auth/queries'
import { FormField as Row } from '../_shared/form-fields'
import {
  detailQuery, idempotencyKey, useAct, useMarkCcRead,
  type Action, type FormData, type InstanceDetail,
} from './api'
import { FlowView } from './flow-view'
import { FormRenderer, missingRequired } from './form-renderer'
import { UserSelect } from './pickers'
import { progressItems } from './progress'
import { InstanceStatusPill } from './status'
import { ApprovalTrack, PersonAvatar } from './track'

/**
 * 审批详情（右侧抽屉）。审批中心和实例监控共用。
 *
 * 左边是申请内容，右边是审批进度（审批轨道：已办的、正在等谁、后面还有谁）。
 * 审批人的意见框直接放在底部 —— 同意 / 驳回是最高频的两个动作，不该再弹一层。
 *
 * 🔴 **按钮只按能力信封渲染**（`capabilities`），不根据实例状态自己推导 ——
 * 同一个函数在服务端也用来判定执行，前端推出来的规则迟早和它漂移。
 */
export function InstanceSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 data-[side=right]:sm:max-w-5xl" data-testid="wf-instance-sheet">
        {id ? <Body id={id} onClose={onClose} /> : <SheetTitle className="sr-only">{t('审批详情')}</SheetTitle>}
      </SheetContent>
    </Sheet>
  )
}

function Body({ id, onClose }: { id: string; onClose: () => void }) {
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
  return <Detail detail={d} onDone={onClose} />
}

function Detail({ detail: d, onDone }: { detail: InstanceDetail; onDone: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = React.useState('form')
  // 审批人可编辑的字段：草稿只存「改了的那几个」，同意时一起提交
  const [patch, setPatch] = React.useState<FormData>({})
  const editable = React.useMemo(
    () => new Set(Object.entries(d.field_perms).filter(([, p]) => p === 'editable').map(([k]) => k)),
    [d.field_perms]
  )
  const merged = React.useMemo(() => ({ ...d.form_data, ...patch }), [d.form_data, patch])
  const track = React.useMemo(() => progressItems(d, t), [d, t])

  return (
    <>
      <header className="flex items-start gap-3 border-b px-6 pt-5 pb-4 pe-14">
        <PersonAvatar name={d.instance.initiator_name ?? ''} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <SheetTitle className="truncate text-lg" data-testid="wf-title">{d.instance.title}</SheetTitle>
            <InstanceStatusPill status={d.instance.status} />
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
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{t('申请内容')}</h3>
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
              {editable.size > 0 && (
                <p className="rounded-md bg-primary/5 px-3 py-2 text-xs text-primary">
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
      <ActionBar detail={d} patch={patch} editable={editable} onDone={onDone} onResetPatch={() => setPatch({})} />
    </>
  )
}

// ── 动作台 ───────────────────────────────────────────────────────────────────

const ACTION_TEXT: Record<Action, string> = {
  approve: '同意',
  reject: '驳回',
  withdraw: '撤回',
  transfer: '转交',
  cc: '抄送',
  remind: '催办',
  terminate: '终止',
}

const DONE_TEXT: Record<Action, string> = {
  approve: '已同意',
  reject: '已驳回',
  withdraw: '已撤回',
  transfer: '已转交',
  cc: '已抄送',
  remind: '已催办',
  terminate: '已终止',
}

const DIALOG_TEXT: Partial<Record<Action, string>> = {
  withdraw: '撤回后这张审批单作废，已经审批过的人会收到通知。',
  terminate: '终止后审批立即结束，发起人会收到通知。',
  transfer: '转交后这条待办交给对方处理，你的待办随之结束。',
  cc: '对方会收到通知，并能在「抄送我的」里看到这张单。',
}

/** 要先在弹窗里选人 / 写原因的动作。同意 / 驳回的意见在底部输入框里，不弹窗 */
const DIALOG: Partial<Record<Action, { opinion?: 'optional' | 'required'; users?: 'one' | 'many' }>> = {
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
  const [opinion, setOpinion] = React.useState('')
  const [opinionError, setOpinionError] = React.useState(false)
  const cap = (a: Action) => d.capabilities.find((c) => c.action === a)

  if (d.capabilities.length === 0) return null

  async function run(action: Action, extra: { opinion?: string; target_user_ids?: string[] } = {}) {
    const body: Parameters<typeof act.mutateAsync>[0] = { action, key: idempotencyKey(), ...extra }
    if (action === 'approve') {
      const missing = missingRequired(d.form_schema, { ...d.form_data, ...patch }, editable)
      if (Object.keys(missing).length) {
        toast.error(t('请先填写：{{f}}', { f: Object.values(missing).join('、') }))
        return false
      }
      if (Object.keys(patch).length) body.form = patch
    }
    try {
      await act.mutateAsync(body)
      toast.success(t(DONE_TEXT[action]))
      onResetPatch()
      setOpinion('')
      // 审批人办完就关掉；发起人撤回 / 催办之后留在详情里看结果
      if (action === 'approve' || action === 'reject' || action === 'transfer') onDone()
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
        {t(ACTION_TEXT[a])}
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
            placeholder={t('审批意见（驳回时必填）')}
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
        {btn('terminate', 'ghost', () => setDialog('terminate'))}
        <span className="ms-auto flex gap-2">
          {btn('remind', 'outline', () => run('remind'))}
          {btn('withdraw', 'outline', () => setDialog('withdraw'))}
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
        initiatorId={d.instance.initiator_id}
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
  const need = action ? DIALOG[action] : undefined
  const okOpinion = need?.opinion !== 'required' || opinion.trim().length > 0
  const okUsers = !need?.users || users.length > 0
  const text = action ? DIALOG_TEXT[action] : undefined

  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="wf-action-dialog">
        <DialogHeader>
          <DialogTitle>{action ? t(ACTION_TEXT[action]) : ''}</DialogTitle>
          <DialogDescription>{text ? t(text) : ''}</DialogDescription>
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
            <Row label={action === 'transfer' ? t('说明') : t('原因')} required={need.opinion === 'required'}>
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
            disabled={!okOpinion || !okUsers || pending}
            onClick={() =>
              onSubmit({ opinion: opinion.trim() || undefined, target_user_ids: users.length ? users : undefined })
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
    t('同意'), t('驳回'), t('撤回'), t('转交'), t('抄送'), t('催办'), t('终止'),
    t('已同意'), t('已驳回'), t('已撤回'), t('已转交'), t('已抄送'), t('已催办'), t('已终止'),
    t('撤回后这张审批单作废，已经审批过的人会收到通知。'), t('终止后审批立即结束，发起人会收到通知。'),
    t('转交后这条待办交给对方处理，你的待办随之结束。'), t('对方会收到通知，并能在「抄送我的」里看到这张单。'),
  ]
}

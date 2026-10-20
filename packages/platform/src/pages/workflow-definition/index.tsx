import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconAlertTriangle, IconArrowLeft, IconCircleX, IconDeviceFloppy, IconDots, IconHierarchy2, IconLoader2,
  IconPencil, IconPlayerPause, IconPlayerPlay, IconPlus, IconRocket, IconSearch, IconTrash,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { Input } from '@admin/ui/components/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@admin/ui/components/input-group'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'
import { toast } from '@admin/ui/components/toast'
import { cn } from '@admin/ui/lib/utils'
import { formatDateTimeShort } from '@admin/i18n'

import { ApiError } from '../../api-client/errors'
import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { FormField as Row } from '../_shared/form-fields'
import { RefreshButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { StatusPill, type Tone } from '../_shared/status'
import {
  definitionQuery, definitionsQuery, useCreateDefinition, useDeleteDefinition, usePublishDefinition,
  useSaveDefinition, useSetDefinitionStatus,
  type Definition, type FlowModel, type FormSchema, type Issue,
} from '../workflow/api'
import { EMPTY_MODEL, usedFields } from '../workflow/flow-edit'
import { TemplateTile } from '../workflow/track'
import { FlowDesigner } from './flow-designer'
import { FormDesigner } from './form-designer'

export type WorkflowDefinitionSearch = {
  id?: string
  step?: 'basic' | 'form' | 'flow'
  sel?: string
}

/** 设计的三步本来就有先后（先有表单，流程里的条件和字段权限才有东西可选），所以带序号 */
const STEPS: { value: 'basic' | 'form' | 'flow'; label: string }[] = [
  { value: 'basic', label: '基础信息' },
  { value: 'form', label: '表单设计' },
  { value: 'flow', label: '流程设计' },
]

const STATUS: Record<Definition['status'], { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'muted' },
  published: { label: '已发布', tone: 'success' },
  disabled: { label: '已停用', tone: 'warning' },
}

/**
 * 流程定义：列表 + 设计器（表单设计 / 流程设计 / 基础信息）。
 *
 * 编辑永远在**草稿**上做，保存草稿不校验；发布时才校验，有 ERROR 就拒绝并把问题
 * 定位到节点 / 字段（#107 设计 9）。已发布的版本只读，在途审批单按自己的快照走。
 */
export function WorkflowDefinitionPage({
  search = {},
  onSearchChange,
}: {
  search?: WorkflowDefinitionSearch
  onSearchChange?: (next: WorkflowDefinitionSearch) => void
}) {
  const patch = (p: Partial<WorkflowDefinitionSearch>) => onSearchChange?.({ ...search, ...p })
  return search.id ? (
    <Designer
      key={search.id}
      id={search.id}
      step={search.step ?? 'form'}
      sel={search.sel ?? null}
      onStep={(step) => patch({ step, sel: undefined })}
      onSel={(sel) => patch({ sel: sel ?? undefined })}
      onLocate={(step, sel) => patch({ step, sel })}
      onBack={() => onSearchChange?.({})}
    />
  ) : (
    <DefinitionList onOpen={(id) => patch({ id, step: 'form', sel: undefined })} />
  )
}

// ── 列表 ─────────────────────────────────────────────────────────────────────

function DefinitionList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const query = useQuery(definitionsQuery())
  const list = listState(query)
  const [creating, setCreating] = React.useState(false)
  const [deleting, setDeleting] = React.useState<Definition | null>(null)
  const [keyword, setKeyword] = React.useState('')
  const del = useDeleteDefinition()
  const setStatus = useSetDefinitionStatus()

  const groups = React.useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const m = new Map<string, Definition[]>()
    for (const d of query.data ?? []) {
      if (kw && !`${d.name} ${d.code} ${d.category ?? ''}`.toLowerCase().includes(kw)) continue
      const k = d.category || t('未分组')
      m.set(k, [...(m.get(k) ?? []), d])
    }
    return [...m.entries()]
  }, [query.data, keyword, t])

  const toggle = (d: Definition) =>
    setStatus.mutate(
      { id: d.id, enabled: d.status !== 'published' },
      {
        onSuccess: () => toast.success(d.status === 'published' ? t('已停用') : t('已启用')),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : t('操作失败，请稍后重试')),
      }
    )

  return (
    <div className="flex flex-col gap-5 py-4 md:py-6">
      <PageHeader title={t('流程定义')} />
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="h-8 w-full sm:w-64">
          <InputGroupAddon align="inline-start">
            <IconSearch className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            value={keyword}
            placeholder={t('搜索名称、编码或分组')}
            onChange={(e) => setKeyword(e.target.value)}
            data-testid="wfd-search"
          />
        </InputGroup>
        <span className="ms-auto flex items-center gap-2">
          <RefreshButton onClick={list.onRetry} busy={list.busy} />
          <Can perm="workflow:definition:add">
            <Button size="sm" onClick={() => setCreating(true)} data-testid="wfd-create">
              <IconPlus className="size-4" />
              {t('新建流程')}
            </Button>
          </Can>
        </span>
      </div>

      {list.loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
      ) : list.error ? (
        <QueryError error={list.error} onRetry={list.onRetry} />
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
            <IconHierarchy2 className="size-6" />
          </span>
          <p className="text-sm text-muted-foreground">
            {keyword ? t('没有匹配「{{k}}」的流程', { k: keyword }) : t('还没有流程。新建一个：先搭表单，再画审批流程，最后发布')}
          </p>
          {!keyword && (
            <Can perm="workflow:definition:add">
              <Button size="sm" onClick={() => setCreating(true)}>
                <IconPlus className="size-4" />
                {t('新建流程')}
              </Button>
            </Can>
          )}
        </div>
      ) : (
        groups.map(([g, defs]) => (
          <section key={g} className="flex flex-col gap-2.5">
            <h3 className="flex items-baseline gap-2 text-sm font-medium">
              {g}
              <span className="text-xs font-normal text-muted-foreground tabular-nums">{defs.length}</span>
            </h3>
            <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', list.busy && 'opacity-60')}>
              {defs.map((d) => (
                <article
                  key={d.id}
                  className="group flex flex-col gap-3 rounded-xl border bg-card p-4 transition-shadow hover:shadow-md"
                  data-testid={`wfd-row-${d.code}`}
                >
                  <div className="flex items-start gap-3">
                    <TemplateTile name={d.name} group={d.category} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{d.name}</span>
                        <StatusPill tone={STATUS[d.status].tone}>{t(STATUS[d.status].label)}</StatusPill>
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{d.code}</span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon" className="size-7" aria-label={t('更多操作')} data-testid={`wfd-more-${d.code}`} />
                        }
                      >
                        <IconDots className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {d.status !== 'draft' && (
                          <Can perm="workflow:definition:publish">
                            <DropdownMenuItem onClick={() => toggle(d)}>
                              {d.status === 'published' ? <IconPlayerPause className="size-4" /> : <IconPlayerPlay className="size-4" />}
                              {d.status === 'published' ? t('停用') : t('启用')}
                            </DropdownMenuItem>
                          </Can>
                        )}
                        <Can perm="workflow:definition:del">
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(d)}>
                            <IconTrash className="size-4" />
                            {t('删除')}
                          </DropdownMenuItem>
                        </Can>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
                    {d.description || t('没有说明')}
                  </p>
                  <div className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
                    <span className="tabular-nums">{d.version_no ? `v${d.version_no}` : t('未发布')}</span>
                    <span>·</span>
                    <span className="tabular-nums">{t('{{at}} 更新', { at: formatDateTimeShort(d.updated_time ?? d.created_time) })}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ms-auto h-7"
                      onClick={() => onOpen(d.id)}
                      data-testid={`wfd-open-${d.code}`}
                    >
                      <IconPencil className="size-3.5" />
                      {t('设计')}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} onCreated={onOpen} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('删除流程「{{name}}」？', { name: deleting?.name ?? '' })}
        description={t('已经有审批单的流程不能删除，可以停用。')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await del.mutateAsync(deleting.id)
            setDeleting(null)
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : t('删除失败'))
          }
        }}
      />
    </div>
  )
}

function CreateDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: (id: string) => void
}) {
  const { t } = useTranslation()
  const create = useCreateDefinition()
  const [v, setV] = React.useState({ name: '', code: '', category: '' })
  const [err, setErr] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) {
      setV({ name: '', code: '', category: '' })
      setErr(null)
    }
  }, [open])
  const codeOk = /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(v.code)
  async function submit() {
    setErr(null)
    try {
      const res = await create.mutateAsync({ name: v.name.trim(), code: v.code.trim(), category: v.category.trim() || null })
      onOpenChange(false)
      onCreated(String(res.id))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('创建失败'))
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="wfd-create-dialog">
        <DialogHeader>
          <DialogTitle>{t('新建流程')}</DialogTitle>
          <DialogDescription>{t('建好之后进入设计器：先搭表单，再画流程，最后发布。')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-4">
          <Row label={t('名称')} required>
            <Input value={v.name} maxLength={64} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="wfd-name" />
          </Row>
          <Row
            label={t('编码')}
            required
            hint={t('字母开头，字母 / 数字 / 下划线。创建后不可改 —— 发起入口和外部引用都按它找流程')}
            error={v.code && !codeOk ? t('编码格式不正确') : undefined}
          >
            <Input value={v.code} maxLength={64} onChange={(e) => setV({ ...v, code: e.target.value })} data-testid="wfd-code" />
          </Row>
          <Row label={t('分组')} hint={t('发起菜单里按分组排列，比如「人事」「财务」')}>
            <Input value={v.category} maxLength={32} onChange={(e) => setV({ ...v, category: e.target.value })} />
          </Row>
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>{t('取消')}</DialogClose>
          <Button onClick={submit} disabled={!v.name.trim() || !codeOk || create.isPending} data-testid="wfd-create-submit">
            {create.isPending && <IconLoader2 className="size-4 animate-spin" />}
            {t('创建')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── 设计器 ───────────────────────────────────────────────────────────────────

type Draft = { form: FormSchema; model: FlowModel; name: string; category: string | null; description: string | null }

function Designer({
  id, step, sel, onStep, onSel, onLocate, onBack,
}: {
  id: string
  step: 'basic' | 'form' | 'flow'
  sel: string | null
  onStep: (s: 'basic' | 'form' | 'flow') => void
  onSel: (s: string | null) => void
  /**
   * 跳到某一步并选中某个节点 / 字段 —— 🔴 要一次改完。连着调 `onStep` 再 `onSel`，两次都是拿同一个旧的
   * `search` 拼新地址（`replace` 导航），第二次把第一次的 `step` 写回去：点发布问题「没反应」
   */
  onLocate: (step: 'basic' | 'form' | 'flow', sel: string) => void
  onBack: () => void
}) {
  const { t } = useTranslation()
  const query = useQuery(definitionQuery(id))
  const save = useSaveDefinition()
  const publish = usePublishDefinition()
  // 草稿写成 `draft ?? baseline` 两层：后台 refetch 回来不会冲掉手上没存的改动
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [issues, setIssues] = React.useState<Issue[]>([])
  const [leaving, setLeaving] = React.useState(false)

  if (query.isPending) return <Skeleton className="h-96 w-full" />
  if (query.error || !query.data) return <QueryError error={query.error} onRetry={() => query.refetch()} />

  const d = query.data
  const baseline: Draft = {
    form: d.form ?? { schemaVersion: 1, fields: [] },
    model: d.model ?? EMPTY_MODEL,
    name: d.name,
    category: d.category,
    description: d.description,
  }
  const cur = draft ?? baseline
  const dirty = draft !== null
  const edit = (p: Partial<Draft>) => setDraft({ ...cur, ...p })

  async function doSave(): Promise<boolean> {
    if (!draft) return true
    const saving = draft
    try {
      await save.mutateAsync({
        id,
        body: { form: cur.form, model: cur.model, name: cur.name, category: cur.category, description: cur.description },
      })
      // 存的过程中又改了的话，那部分还没存 —— 不能一起清掉
      setDraft((now) => (now === saving ? null : now))
      return true
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('保存失败'))
      return false
    }
  }

  async function doPublish() {
    if (!(await doSave())) return
    try {
      const res = await publish.mutateAsync(id)
      setIssues(res.issues)
      if (res.published && !res.new_version) toast.info(t('没有改动，当前仍是 v{{n}}', { n: res.version?.version_no }))
      else if (res.published) toast.success(t('已发布 v{{n}}', { n: res.version?.version_no }))
      else toast.error(t('有 {{n}} 个问题要先解决', { n: res.issues.filter((i) => i.level === 'ERROR').length }))
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('发布失败'))
    }
  }

  const issueNodes = new Set(issues.filter((i) => i.level === 'ERROR' && i.nodeId).map((i) => i.nodeId as string))
  const issueFields = new Set(issues.filter((i) => i.level === 'ERROR' && i.fieldId).map((i) => i.fieldId as string))
  const used = usedFields(cur.model)

  return (
    <div className="flex flex-col gap-4 py-4 md:py-6" data-testid="wfd-designer">
      <PageHeader title={t('流程设计')} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('返回列表')}
          title={t('返回列表')}
          onClick={() => (dirty ? setLeaving(true) : onBack())}
          data-testid="wfd-back"
        >
          <IconArrowLeft className="size-4" />
        </Button>
        <TemplateTile name={cur.name || '?'} group={cur.category} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium" data-testid="wfd-title">{cur.name}</span>
            <StatusPill tone={STATUS[d.status].tone}>{t(STATUS[d.status].label)}</StatusPill>
          </span>
          <span className="text-xs text-muted-foreground" data-testid={dirty ? 'wfd-dirty' : undefined}>
            {dirty ? t('有未保存的修改') : t('草稿已保存')}
          </span>
        </div>
        <ol className="mx-auto flex items-center gap-1" aria-label={t('设计步骤')}>
          {STEPS.map((s, i) => (
            <li key={s.value} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden className="h-px w-6 bg-border" />}
              <button
                type="button"
                onClick={() => onStep(s.value)}
                aria-current={step === s.value ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors',
                  step === s.value ? 'bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'
                )}
                data-testid={`wfd-step-${s.value}`}
              >
                <span
                  className={cn(
                    'grid size-5 place-items-center rounded-full text-xs tabular-nums',
                    step === s.value ? 'bg-primary text-primary-foreground' : 'bg-muted'
                  )}
                >
                  {i + 1}
                </span>
                {t(s.label)}
              </button>
            </li>
          ))}
        </ol>
        <span className="flex items-center gap-2">
          <Can perm="workflow:definition:edit">
            <Button variant="outline" size="sm" onClick={doSave} disabled={!dirty || save.isPending} data-testid="wfd-save">
              {save.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconDeviceFloppy className="size-4" />}
              {t('保存草稿')}
            </Button>
          </Can>
          <Can perm="workflow:definition:publish">
            <Button size="sm" onClick={doPublish} disabled={publish.isPending || save.isPending} data-testid="wfd-publish">
              {publish.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconRocket className="size-4" />}
              {t('发布')}
            </Button>
          </Can>
        </span>
      </div>

      {issues.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="wfd-issues">
          {issues.map((i, k) => (
            <li key={k}>
              <button
                type="button"
                className="flex items-center gap-2 text-start hover:underline"
                onClick={() => {
                  if (i.nodeId) onLocate('flow', i.nodeId)
                  else if (i.fieldId) onLocate('form', i.fieldId)
                }}
              >
                {i.level === 'ERROR' ? (
                  <IconCircleX className="size-4 shrink-0 text-destructive" />
                ) : (
                  <IconAlertTriangle className="size-4 shrink-0 text-amber-600" />
                )}
                <span>{i.message}</span>
                <code className="text-xs text-muted-foreground">{i.code}</code>
              </button>
            </li>
          ))}
        </ul>
      )}

      {step === 'basic' && (
        <div className="flex max-w-xl flex-col gap-4">
          <Row label={t('名称')} required>
            <Input value={cur.name} maxLength={64} onChange={(e) => edit({ name: e.target.value })} />
          </Row>
          <Row label={t('编码')} hint={t('创建后不可改')}>
            <Input value={d.code} disabled />
          </Row>
          <Row label={t('分组')}>
            <Input value={cur.category ?? ''} maxLength={32} onChange={(e) => edit({ category: e.target.value || null })} />
          </Row>
          <Row label={t('说明')}>
            <Textarea rows={3} maxLength={256} value={cur.description ?? ''} onChange={(e) => edit({ description: e.target.value || null })} />
          </Row>
          {/*
           * AI 预审存在流程模型里（`model.aiReview`），跟着版本发布：改了要点不影响在途的单。
           * 关掉时保留要点原文 —— 只是不用，重新打开不必再写一遍
           */}
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{t('AI 预审')}</span>
              <span className="text-xs text-muted-foreground">
                {t('提交后由模型按下面的要点先看一遍，结果显示在审批详情顶部，只给审批人参考，不会自动通过或驳回。')}
              </span>
            </div>
            <Switch
              data-testid="wfd-ai-enabled"
              checked={cur.model.aiReview?.enabled ?? false}
              onCheckedChange={(c) =>
                edit({ model: { ...cur.model, aiReview: { points: cur.model.aiReview?.points ?? '', enabled: Boolean(c) } } })
              }
            />
          </div>
          {cur.model.aiReview?.enabled && (
            <Row label={t('审核要点')} hint={t('用大白话写，一行一条。例如：事由要写清楚具体原因；病假超过 3 天要有证明')}>
              <Textarea
                rows={5}
                maxLength={2000}
                data-testid="wfd-ai-points"
                value={cur.model.aiReview.points}
                onChange={(e) =>
                  edit({ model: { ...cur.model, aiReview: { enabled: true, points: e.target.value } } })
                }
              />
            </Row>
          )}
        </div>
      )}
      {step === 'form' && (
        <FormDesigner
          form={cur.form}
          onChange={(form) => edit({ form })}
          selected={sel}
          onSelect={onSel}
          usedByFlow={used}
          issueFields={issueFields}
        />
      )}
      {step === 'flow' && (
        <FlowDesigner
          model={cur.model}
          form={cur.form}
          onChange={(model) => edit({ model })}
          selected={sel}
          onSelect={onSel}
          issueNodes={issueNodes}
        />
      )}

      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={t('放弃未保存的修改？')}
        description={t('返回列表会丢掉这次没保存的改动。')}
        confirmText={t('放弃并返回')}
        destructive
        onConfirm={() => {
          setLeaving(false)
          onBack()
        }}
      />
    </div>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [t('草稿'), t('已发布'), t('已停用'), t('基础信息'), t('表单设计'), t('流程设计')]
}

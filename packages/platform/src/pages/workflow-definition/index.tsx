import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconAlertTriangle, IconArrowLeft, IconCircleX, IconDeviceFloppy, IconLoader2, IconPlus, IconRocket,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { Input } from '@admin/ui/components/input'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@admin/ui/components/table'
import { Tabs, TabsList, TabsTrigger } from '@admin/ui/components/tabs'
import { Textarea } from '@admin/ui/components/textarea'
import { toast } from '@admin/ui/components/toast'
import { cn } from '@admin/ui/lib/utils'
import { formatDateTime } from '@admin/i18n'

import { ApiError } from '../../api-client/errors'
import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { FormField as Row } from '../_shared/form-fields'
import { listState } from '../_shared/list-query'
import { StatusPill, type Tone } from '../_shared/status'
import {
  definitionQuery, definitionsQuery, useCreateDefinition, useDeleteDefinition, usePublishDefinition,
  useSaveDefinition, useSetDefinitionStatus,
  type Definition, type FlowModel, type FormSchema, type Issue,
} from '../workflow/api'
import { EMPTY_MODEL, usedFields } from '../workflow/flow-edit'
import { FlowDesigner } from './flow-designer'
import { FormDesigner } from './form-designer'

export type WorkflowDefinitionSearch = {
  id?: string
  step?: 'basic' | 'form' | 'flow'
  sel?: string
}

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
  const rows = query.data ?? []
  const [creating, setCreating] = React.useState(false)
  const [deleting, setDeleting] = React.useState<Definition | null>(null)
  const del = useDeleteDefinition()
  const setStatus = useSetDefinitionStatus()

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('流程定义')}>
        <Can perm="workflow:definition:add">
          <Button size="sm" onClick={() => setCreating(true)} data-testid="wfd-create">
            <IconPlus className="size-4" />
            {t('新建流程')}
          </Button>
        </Can>
      </PageHeader>
      <div className={cn('overflow-hidden rounded-lg border', list.busy && 'opacity-60')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('名称')}</TableHead>
              <TableHead>{t('编码')}</TableHead>
              <TableHead>{t('分组')}</TableHead>
              <TableHead>{t('状态')}</TableHead>
              <TableHead>{t('更新时间')}</TableHead>
              <TableHead className="text-end">{t('操作')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.loading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-6" /></TableCell></TableRow>
            ) : list.error ? (
              <TableRow><TableCell colSpan={6}><QueryError error={list.error} onRetry={list.onRetry} /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">{t('还没有流程，先新建一个')}</TableCell></TableRow>
            ) : (
              rows.map((d) => (
                <TableRow key={d.id} data-testid={`wfd-row-${d.code}`}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell className="font-mono text-xs">{d.code}</TableCell>
                  <TableCell>{d.category ?? '—'}</TableCell>
                  <TableCell>
                    <StatusPill tone={STATUS[d.status].tone}>{t(STATUS[d.status].label)}</StatusPill>
                  </TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(d.updated_time ?? d.created_time)}</TableCell>
                  <TableCell className="text-end">
                    <span className="inline-flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onOpen(d.id)} data-testid={`wfd-open-${d.code}`}>
                        {t('设计')}
                      </Button>
                      {d.status !== 'draft' && (
                        <Can perm="workflow:definition:publish">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={setStatus.isPending}
                            onClick={() =>
                              setStatus.mutate(
                                { id: d.id, enabled: d.status !== 'published' },
                                { onError: (e) => toast.error(e instanceof ApiError ? e.message : t('操作失败')) }
                              )
                            }
                          >
                            {d.status === 'published' ? t('停用') : t('启用')}
                          </Button>
                        </Can>
                      )}
                      <Can perm="workflow:definition:del">
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(d)}>
                          {t('删除')}
                        </Button>
                      </Can>
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
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
  id, step, sel, onStep, onSel, onBack,
}: {
  id: string
  step: 'basic' | 'form' | 'flow'
  sel: string | null
  onStep: (s: 'basic' | 'form' | 'flow') => void
  onSel: (s: string | null) => void
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
    try {
      await save.mutateAsync({
        id,
        body: { form: cur.form, model: cur.model, name: cur.name, category: cur.category, description: cur.description },
      })
      setDraft(null)
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
      if (res.published) toast.success(t('已发布 v{{n}}', { n: res.version?.version_no }))
      else toast.error(t('有 {{n}} 个问题要先解决', { n: res.issues.filter((i) => i.level === 'ERROR').length }))
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('发布失败'))
    }
  }

  const issueNodes = new Set(issues.filter((i) => i.level === 'ERROR' && i.nodeId).map((i) => i.nodeId as string))
  const issueFields = new Set(issues.filter((i) => i.level === 'ERROR' && i.fieldId).map((i) => i.fieldId as string))
  const used = usedFields(cur.model)

  return (
    <div className="flex flex-col gap-4" data-testid="wfd-designer">
      <PageHeader title={t('流程设计')} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => (dirty ? setLeaving(true) : onBack())} data-testid="wfd-back">
          <IconArrowLeft className="size-4" />
          {t('返回列表')}
        </Button>
        <span className="font-medium" data-testid="wfd-title">{cur.name}</span>
        <StatusPill tone={STATUS[d.status].tone}>{t(STATUS[d.status].label)}</StatusPill>
        {dirty && <span className="text-xs text-amber-700" data-testid="wfd-dirty">{t('有未保存的修改')}</span>}
        <Tabs value={step} onValueChange={(v) => onStep(v as 'basic' | 'form' | 'flow')} className="mx-auto">
          <TabsList>
            <TabsTrigger value="basic" data-testid="wfd-step-basic">{t('基础信息')}</TabsTrigger>
            <TabsTrigger value="form" data-testid="wfd-step-form">{t('表单设计')}</TabsTrigger>
            <TabsTrigger value="flow" data-testid="wfd-step-flow">{t('流程设计')}</TabsTrigger>
          </TabsList>
        </Tabs>
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
      </div>

      {issues.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="wfd-issues">
          {issues.map((i, k) => (
            <li key={k}>
              <button
                type="button"
                className="flex items-center gap-2 text-start hover:underline"
                onClick={() => {
                  if (i.nodeId) {
                    onStep('flow')
                    onSel(i.nodeId)
                  } else if (i.fieldId) {
                    onStep('form')
                    onSel(i.fieldId)
                  }
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
  return [t('草稿'), t('已发布'), t('已停用')]
}

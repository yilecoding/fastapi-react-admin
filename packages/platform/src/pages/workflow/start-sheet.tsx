import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '@admin/i18n'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast } from '@admin/ui/components/toast'

import { ApiError } from '../../api-client/errors'
import { meQuery } from '../../auth/queries'
import { useTabPortalContainer } from '../../shell/tab-outlet'
import { FormField as Row } from '../_shared/form-fields'
import {
  detailQuery, draftQuery, idempotencyKey, previewQuery, removeDraft, saveDraft, startFormQuery, useDeleteDraft, useStartInstance,
  type FieldPerm, type FileMeta, type AiFill, type FormData, type StartForm,
} from './api'
import { AiFillPanel, AiMark, type AiFillOutcome } from './ai-fill-panel'
import { FormRenderer, empty, missingRequired } from './form-renderer'
import { formRules } from './form-rules'
import { UserSelect } from './pickers'
import { forecastItems } from './progress'
import { ApprovalTrack, TemplateTile, type TrackItem } from './track'

/**
 * 发起审批（右侧抽屉）。`code` 来自 URL（`?start=LEAVE`），刷新之后抽屉还在。
 *
 * 右边的「审批流程」是服务端按**当前填的内容**试算出来的（天数改成 5，就多出一个上级主管），
 * 提交之前就知道这张单会到谁手里 —— 飞书审批的那块预览。
 *
 * 草稿存服务端（一个人、一个流程一份）：边填边自动存，关掉再打开还在，提交成功服务端顺手删掉。
 */
export function StartSheet({
  code, fromId, onClose, onStarted,
}: {
  code: string | null
  /** 重新发起：从这张（已驳回 / 撤回的）单复制内容 */
  fromId?: string | null
  onClose: () => void
  onStarted: (instanceId: string) => void
}) {
  // 抽屉开在 URL 上：portal 挂进本 tab 的根节点，后台时跟着 tab 一起隐藏、状态不丢（见 `useTabPortalContainer` 的注释）
  const container = useTabPortalContainer()
  return (
    <Sheet open={!!code} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        container={container}
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:w-3/4 data-[side=right]:sm:max-w-4xl" data-testid="wf-start-sheet">
        {code && <Body key={`${code}:${fromId ?? ''}`} code={code} fromId={fromId ?? null} onStarted={onStarted} />}
      </SheetContent>
    </Sheet>
  )
}

function Body({ code, fromId, onStarted }: { code: string; fromId: string | null; onStarted: (id: string) => void }) {
  const { t } = useTranslation()
  const query = useQuery(startFormQuery(code))
  const from = useQuery({ ...detailQuery(fromId ?? ''), enabled: !!fromId })
  // 重新发起时内容来自旧单，不读草稿
  const draft = useQuery({ ...draftQuery(code), enabled: !fromId })
  if (query.isPending || (fromId && from.isPending) || (!fromId && draft.isPending)) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <SheetTitle className="sr-only">{t('发起审批')}</SheetTitle>
        <Skeleton className="h-11 w-1/3" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }
  if (query.error || !query.data) {
    return (
      <div className="p-6">
        <SheetTitle className="sr-only">{t('发起审批')}</SheetTitle>
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      </div>
    )
  }
  return (
    <Filler
      code={code}
      sf={query.data}
      initial={fromId ? from.data?.form_data : draft.data?.form}
      initialAiFilled={fromId ? undefined : draft.data?.ai_filled}
      initialFiles={from.data?.files}
      restoredAt={fromId ? undefined : draft.data?.updated_time}
      draftError={!fromId && !!draft.error}
      fromOld={!!fromId}
      onStarted={onStarted}
    />
  )
}

/** 停手 400ms 再试算 —— 每敲一个字都请求一次没有意义 */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value)
  React.useEffect(() => {
    const h = setTimeout(() => setV(value), ms)
    return () => clearTimeout(h)
  }, [value, ms])
  return v
}

function Filler({
  code, sf, initial, initialAiFilled, initialFiles, restoredAt, draftError, fromOld, onStarted,
}: {
  code: string
  sf: StartForm
  /** 重新发起时带过来的旧内容。只取当前表单里还在、发起人能填的字段 —— 流程改过版本的话旧字段可能已经没了 */
  initial?: FormData
  /** 草稿里记着的「AI 填了、还没核对」的字段 */
  initialAiFilled?: string[]
  /** 旧单上附件的文件名 / 大小 —— 不带的话复制过来的附件只剩 ID，显示成「文件已删除」 */
  initialFiles?: Record<string, FileMeta>
  /** 恢复的草稿是什么时候存的（有值 = 这次是从草稿接着填） */
  restoredAt?: string
  /** 草稿没读出来：照常能填，但要说一声（硬纪律 9） */
  draftError?: boolean
  /** 「重新发起」：内容来自旧单。🔴 不碰这个流程的草稿 —— 那是另一张没写完的单，存进去会把它覆盖、提交会把它删掉 */
  fromOld?: boolean
  onStarted: (id: string) => void
}) {
  const { t } = useTranslation()
  const start = useStartInstance()
  const me = useQuery(meQuery).data
  const [form, setForm] = React.useState<FormData>(() => {
    if (!initial) return {}
    const perms = sf.model.root.fieldPerms ?? {}
    return Object.fromEntries(
      sf.form.fields
        .filter((f) => (perms[f.id] ?? 'editable') === 'editable' && f.id in initial)
        .map((f) => [f.id, initial[f.id]])
    )
  })
  // AI 填了、还没核对的字段（#111 第 3 条）。🔴 跟着草稿存：只放在这里的话，关掉再打开值还在、标记没了
  const [aiFilled, setAiFilled] = React.useState<string[]>(() => (initialAiFilled ?? []).filter((id) => initial && id in initial))
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [urgent, setUrgent] = React.useState(false)
  const draft = useDraftAutosave(code, form, aiFilled, !fromOld)
  const deleteDraft = useDeleteDraft()
  const [restored, setRestored] = React.useState(!!restoredAt)
  // 一次填写 = 一个幂等键：网络抖动重试 / 双击提交不会建出两张单
  const key = React.useRef(idempotencyKey())

  // 发起人的字段权限（开始节点上配的）：hidden 的字段根本不出现，readonly 的只显示
  const startPerms = React.useMemo(() => sf.model.root.fieldPerms ?? {}, [sf.model])
  const schema = React.useMemo(
    () => ({ ...sf.form, fields: sf.form.fields.filter((f) => startPerms[f.id] !== 'hidden') }),
    [sf.form, startPerms]
  )
  const perms = React.useMemo(
    () => Object.fromEntries(schema.fields.map((f) => [f.id, startPerms[f.id] ?? 'editable'])) as Record<string, FieldPerm>,
    [schema, startPerms]
  )
  const editable = React.useMemo(
    () => new Set(Object.entries(perms).filter(([, p]) => p === 'editable').map(([k]) => k)),
    [perms]
  )

  const inputs = React.useMemo(() => ({ form, selected }), [form, selected])
  const debounced = useDebounced(inputs, 400)
  const preview = useQuery(previewQuery(code, debounced.form, debounced.selected))
  const track: TrackItem[] = [
    { key: 'start', kind: 'start', title: t('发起申请'), state: 'done', people: [{ name: me?.nickname ?? '' }] },
    ...forecastItems(preview.data?.steps ?? [], t),
    { key: 'end', kind: 'end', title: t('结束'), state: 'future' },
  ]

  // 自选审批人只问**会走到**的那几个节点（服务端也只校验这些）。试算还没回来时先全列出来
  const pickNodes = React.useMemo(() => {
    const steps = preview.data?.steps
    if (!steps) return sf.select_nodes
    const onPath = new Set(steps.map((s) => s.node_id))
    return sf.select_nodes.filter((n) => onPath.has(n.id))
  }, [preview.data, sf.select_nodes])

  // 🔴 下面两个回调都可能被**旧的闭包**调到：AI 填单要等十几秒（点「开始填」那一刻的 `onResult`），
  // 附件上传完才回调（选文件那一刻的 `onChange`）。拿闭包里的 `form` 比 / 合并，会把这期间打的字冲掉、
  // 把刚标上的「AI 填的」当成「人改过」去掉 —— 一律读这个 ref（每次渲染和每次改都更新）
  const formRef = React.useRef(form)
  formRef.current = form

  // 人改了 AI 填的字段 = 核对过了，标记去掉
  const changeForm = (next: FormData) => {
    const prev = formRef.current
    formRef.current = next
    setAiFilled((marks) => marks.filter((id) => JSON.stringify(next[id]) === JSON.stringify(prev[id])))
    setForm(next)
  }

  /** AI 的值只填进**还空着**的字段：人已经填了的不替他改 */
  function mergeAi(res: AiFill): AiFillOutcome {
    const latest = formRef.current
    const next = { ...latest }
    const filled: string[] = []
    let kept = 0
    for (const [id, v] of Object.entries(res.values)) {
      if (!editable.has(id)) continue
      if (!empty(latest[id])) {
        kept += 1
        continue
      }
      next[id] = v
      filled.push(id)
    }
    formRef.current = next
    setForm(next)
    setAiFilled((marks) => [...new Set([...marks, ...filled])])
    return { filled: filled.length, kept, result: res }
  }

  // 现在显示着的那几个标记（按条件隐藏的字段不算，见 submit）
  const inactive = React.useMemo(() => formRules(schema, form).inactive, [schema, form])
  const pendingMarks = aiFilled.filter((id) => !inactive.has(id))

  async function submit() {
    const errs: Record<string, string> = {}
    // 🔴 AI 填的每一项都要人点过「没问题」（或者自己改过）才能提交 —— 不然「AI 填的」只是个装饰。
    // 按条件不显示的字段除外：它的「没问题」画不出来，拦着就是一个永远交不了的单（它的值服务端也不存）
    for (const id of pendingMarks) errs[id] = t('AI 填的，核对无误后点「没问题」')
    for (const [k, label] of Object.entries(missingRequired(schema, form, editable))) {
      errs[k] = t('请填写「{{f}}」', { f: label })
    }
    for (const n of pickNodes) if (!selected[n.id]?.length) errs[`select:${n.id}`] = t('请选择审批人')
    setErrors(errs)
    if (pendingMarks.length) toast.error(t('还有 {{n}} 项 AI 填的没核对', { n: pendingMarks.length }))
    if (Object.keys(errs).length) return
    // 提交之前：停掉自动保存，并**等正在路上的那次保存落地** —— 否则它可能在服务端删完草稿之后才提交，
    // 把草稿又存回来（只拦没触发的防抖不够，已经发出去的 PUT 拦不住）
    await draft.stop()
    try {
      // 走不到的节点上选过的人不带过去
      const picked = Object.fromEntries(pickNodes.filter((n) => selected[n.id]).map((n) => [n.id, selected[n.id]]))
      const res = await start.mutateAsync({ code, form, selected: picked, key: key.current, urgent, keep_draft: fromOld })
      toast.success(t('已提交'))
      key.current = idempotencyKey()
      onStarted(String(res.instance_id))
    } catch (e) {
      // 后端的字段级错误（`detail` 是 字段 ID → 原因）直接挂到字段下面
      if (e instanceof ApiError && e.detail && typeof e.detail === 'object') {
        setErrors(e.detail as Record<string, string>)
      }
      toast.error(e instanceof ApiError ? e.message : t('提交失败，请稍后重试'))
      draft.resume()
    }
  }

  return (
    <>
      <header className="flex items-center gap-3 border-b px-6 pt-5 pb-4 pe-14">
        <TemplateTile name={sf.definition.name} group={sf.definition.category} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <SheetTitle className="text-lg" data-testid="wf-start-title">{sf.definition.name}</SheetTitle>
          <SheetDescription className="truncate text-xs">
            {sf.definition.description || t('填写后提交，审批流程见右侧')}
          </SheetDescription>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex flex-col gap-5 px-6 py-5">
          {restored && restoredAt && (
            <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="wf-draft-restored">
              <span>{t('已恢复你 {{at}} 没提交的内容', { at: formatDateTime(restoredAt) })}</span>
              <button
                type="button"
                className="ms-auto text-primary hover:underline"
                onClick={async () => {
                  // 同提交：先等路上那次保存落地再删，不然它可能在删之后才到、把草稿又存回来
                  await draft.stop()
                  try {
                    await deleteDraft.mutateAsync(code)
                    setForm({})
                    setAiFilled([])
                    setRestored(false)
                  } finally {
                    draft.resume()
                  }
                }}
                data-testid="wf-draft-clear"
              >
                {t('清空重填')}
              </button>
            </div>
          )}
          {draftError && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {t('上次的草稿没读出来，可以照常填写')}
            </p>
          )}
          <AiFillPanel code={code} onResult={mergeAi} />
          <FormRenderer
            schema={schema}
            value={form}
            onChange={changeForm}
            mode="view"
            perms={perms}
            errors={errors}
            files={initialFiles}
            marks={Object.fromEntries(
              aiFilled.map((id) => [
                id,
                <AiMark
                  key={id}
                  onOk={() => {
                    setAiFilled((marks) => marks.filter((m) => m !== id))
                    setErrors(({ [id]: _, ...rest }) => rest)
                  }}
                />,
              ])
            )}
          />
          {pickNodes.map((n) => (
            <Row key={n.id} label={t('{{node}}：选择审批人', { node: n.name })} required error={errors[`select:${n.id}`]}>
              <UserSelect
                value={selected[n.id] ?? []}
                multiple
                onChange={(v) => setSelected({ ...selected, [n.id]: v })}
                testId={`wf-select-${n.id}`}
              />
            </Row>
          ))}
        </section>
        <aside
          className="flex flex-col gap-4 border-t bg-muted/30 px-5 py-5 lg:border-t-0 lg:border-s"
          data-testid="wf-start-preview"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{t('审批流程')}</h3>
            {preview.isFetching && <IconLoader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          {preview.error ? (
            <QueryError error={preview.error} onRetry={() => preview.refetch()} />
          ) : preview.isPending ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <ApprovalTrack items={track} testId="wf-start-track" />
          )}
          <p className="text-xs text-muted-foreground">{t('按你当前填写的内容推算，改了条件相关的字段会跟着变')}</p>
        </aside>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t px-6 py-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={urgent} onCheckedChange={(v) => setUrgent(!!v)} data-testid="wf-start-urgent" />
          {t('加急')}
        </label>
        <span className="me-auto ms-3 text-xs text-muted-foreground" data-testid="wf-draft-status">
          {draft.status === 'saving' ? t('草稿保存中…') : draft.status === 'error' ? t('草稿没存上，再改一下会重试') : draft.savedAt ? t('草稿已保存 {{at}}', { at: formatDateTime(draft.savedAt) }) : ''}
        </span>
        <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
        <Button onClick={submit} disabled={start.isPending} data-testid="wf-start-submit">
          {start.isPending && <IconLoader2 className="size-4 animate-spin" />}
          {t('提交')}
        </Button>
      </footer>
    </>
  )
}

/**
 * 边填边存草稿：停手 1.5 秒存一次，内容没变不存。
 *
 * `stop()` / `resume()`：提交那一刻先停 —— 防抖里排着的那次保存要是在提交成功之后才发出去，
 * 服务端刚删掉的草稿又被存回来，下次打开「已恢复没提交的内容」，而那张单其实已经交了
 */
function useDraftAutosave(code: string, form: FormData, aiFilled: string[], enabled: boolean) {
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'error'>('idle')
  const [savedAt, setSavedAt] = React.useState<string | null>(null)
  const stopped = React.useRef(false)
  const inflight = React.useRef<Promise<unknown> | null>(null)
  const last = React.useRef(JSON.stringify([form, aiFilled]))
  React.useEffect(() => {
    if (!enabled) return
    const raw = JSON.stringify([form, aiFilled])
    if (raw === last.current) return
    const h = setTimeout(async () => {
      if (stopped.current) return
      setStatus('saving')
      let done: () => void = () => {}
      inflight.current = new Promise<void>((r) => {
        done = r
      })
      try {
        // 全清空了：删草稿而不是存一份空的（否则下次打开是「已恢复你没提交的内容」+ 一张白表）
        const blank = Object.values(form).every((v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
        await (blank ? removeDraft(code) : saveDraft(code, form, aiFilled))
        last.current = raw
        setSavedAt(new Date().toISOString())
        setStatus('idle')
      } catch {
        setStatus('error')
      } finally {
        done()
        inflight.current = null
      }
    }, 1500)
    return () => clearTimeout(h)
  }, [code, form, aiFilled, enabled])
  return {
    status,
    savedAt,
    /** 停掉之后再触发的保存都不发；返回值等正在路上的那一次落地（成败都算落地） */
    stop: async () => {
      stopped.current = true
      await inflight.current
    },
    resume: () => {
      stopped.current = false
    },
  }
}


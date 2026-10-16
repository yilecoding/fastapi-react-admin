import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast } from '@admin/ui/components/toast'

import { ApiError } from '../../api-client/errors'
import { meQuery } from '../../auth/queries'
import { useTabPortalContainer } from '../../shell/tab-outlet'
import { FormField as Row } from '../_shared/form-fields'
import {
  detailQuery, idempotencyKey, previewQuery, startFormQuery, useStartInstance,
  type FieldPerm, type FileMeta, type FormData, type StartForm,
} from './api'
import { FormRenderer, missingRequired } from './form-renderer'
import { UserSelect } from './pickers'
import { forecastItems } from './progress'
import { ApprovalTrack, TemplateTile, type TrackItem } from './track'

/**
 * 发起审批（右侧抽屉）。`code` 来自 URL（`?start=LEAVE`），刷新之后抽屉还在。
 *
 * 右边的「审批流程」是服务端按**当前填的内容**试算出来的（天数改成 5，就多出一个上级主管），
 * 提交之前就知道这张单会到谁手里 —— 飞书审批的那块预览。
 *
 * ⚠️ 表单草稿只在组件 state 里：抽屉关掉就没了。想要「草稿箱」得另做，这一版没有。
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
  if (query.isPending || (fromId && from.isPending)) {
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
      initial={from.data?.form_data}
      initialFiles={from.data?.files}
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
  code, sf, initial, initialFiles, onStarted,
}: {
  code: string
  sf: StartForm
  /** 重新发起时带过来的旧内容。只取当前表单里还在、发起人能填的字段 —— 流程改过版本的话旧字段可能已经没了 */
  initial?: FormData
  /** 旧单上附件的文件名 / 大小 —— 不带的话复制过来的附件只剩 ID，显示成「文件已删除」 */
  initialFiles?: Record<string, FileMeta>
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
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
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

  async function submit() {
    const errs: Record<string, string> = {}
    for (const [k, label] of Object.entries(missingRequired(schema, form, editable))) {
      errs[k] = t('请填写「{{f}}」', { f: label })
    }
    for (const n of pickNodes) if (!selected[n.id]?.length) errs[`select:${n.id}`] = t('请选择审批人')
    setErrors(errs)
    if (Object.keys(errs).length) return
    try {
      // 走不到的节点上选过的人不带过去
      const picked = Object.fromEntries(pickNodes.filter((n) => selected[n.id]).map((n) => [n.id, selected[n.id]]))
      const res = await start.mutateAsync({ code, form, selected: picked, key: key.current })
      toast.success(t('已提交'))
      key.current = idempotencyKey()
      onStarted(String(res.instance_id))
    } catch (e) {
      // 后端的字段级错误（`detail` 是 字段 ID → 原因）直接挂到字段下面
      if (e instanceof ApiError && e.detail && typeof e.detail === 'object') {
        setErrors(e.detail as Record<string, string>)
      }
      toast.error(e instanceof ApiError ? e.message : t('提交失败，请稍后重试'))
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
          <FormRenderer
            schema={schema}
            value={form}
            onChange={setForm}
            mode="view"
            perms={perms}
            errors={errors}
            files={initialFiles}
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
        <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
        <Button onClick={submit} disabled={start.isPending} data-testid="wf-start-submit">
          {start.isPending && <IconLoader2 className="size-4 animate-spin" />}
          {t('提交')}
        </Button>
      </footer>
    </>
  )
}

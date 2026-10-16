import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast } from '@admin/ui/components/toast'

import { ApiError } from '../../api-client/errors'
import { FormField as Row } from '../_shared/form-fields'
import { idempotencyKey, startFormQuery, useStartInstance, type FieldPerm, type FormData } from './api'
import { FlowView } from './flow-view'
import { FormRenderer, missingRequired } from './form-renderer'
import { UserSelect } from './pickers'

/**
 * 发起审批（右侧抽屉）。`code` 来自 URL（`?start=LEAVE`），刷新之后抽屉还在。
 *
 * ⚠️ 表单草稿只在组件 state 里：抽屉关掉就没了。想要「草稿箱」得另做，这一版没有。
 */
export function StartSheet({
  code, onClose, onStarted,
}: {
  code: string | null
  onClose: () => void
  onStarted: (instanceId: string) => void
}) {
  return (
    <Sheet open={!!code} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-2xl" data-testid="wf-start-sheet">
        {code && <Body code={code} onStarted={onStarted} />}
      </SheetContent>
    </Sheet>
  )
}

function Body({ code, onStarted }: { code: string; onStarted: (id: string) => void }) {
  const { t } = useTranslation()
  const query = useQuery(startFormQuery(code))
  const start = useStartInstance()
  const [form, setForm] = React.useState<FormData>({})
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [showFlow, setShowFlow] = React.useState(false)
  // 一次填写 = 一个幂等键：网络抖动重试 / 双击提交不会建出两张单
  const key = React.useRef(idempotencyKey())

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <SheetTitle className="sr-only">{t('发起审批')}</SheetTitle>
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-48 w-full" />
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
  const sf = query.data
  // 发起人的字段权限（开始节点上配的）：hidden 的字段根本不出现，readonly 的只显示
  const startPerms = sf.model.root.fieldPerms ?? {}
  const schema = { ...sf.form, fields: sf.form.fields.filter((f) => startPerms[f.id] !== 'hidden') }
  const perms = Object.fromEntries(schema.fields.map((f) => [f.id, startPerms[f.id] ?? 'editable'])) as Record<string, FieldPerm>
  const editable = new Set(Object.entries(perms).filter(([, p]) => p === 'editable').map(([k]) => k))

  async function submit() {
    const missing = missingRequired(schema, form, editable)
    const errs: Record<string, string> = {}
    for (const [k, label] of Object.entries(missing)) errs[k] = t('请填写「{{f}}」', { f: label })
    for (const n of sf.select_nodes) if (!selected[n.id]?.length) errs[`select:${n.id}`] = t('请选择审批人')
    setErrors(errs)
    if (Object.keys(errs).length) return
    try {
      const res = await start.mutateAsync({ code, form, selected, key: key.current })
      toast.success(t('已提交'))
      key.current = idempotencyKey()
      onStarted(String(res.instance_id))
    } catch (e) {
      // 后端的字段级错误（`data` 是 字段 ID → 原因）直接挂到字段下面
      if (e instanceof ApiError && e.detail && typeof e.detail === 'object') {
        setErrors(e.detail as Record<string, string>)
      }
      toast.error(e instanceof ApiError ? e.message : t('提交失败，请稍后重试'))
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle data-testid="wf-start-title">{sf.definition.name}</SheetTitle>
        {sf.definition.description && <SheetDescription>{sf.definition.description}</SheetDescription>}
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-2">
        <FormRenderer schema={schema} value={form} onChange={setForm} mode="view" perms={perms} errors={errors} />
        {sf.select_nodes.map((n) => (
          <Row key={n.id} label={t('{{node}}：选择审批人', { node: n.name })} required error={errors[`select:${n.id}`]}>
            <UserSelect
              value={selected[n.id] ?? []}
              multiple
              onChange={(v) => setSelected({ ...selected, [n.id]: v })}
              testId={`wf-select-${n.id}`}
            />
          </Row>
        ))}
        <div className="rounded-md border">
          <button
            type="button"
            className="w-full px-3 py-2 text-start text-sm text-muted-foreground hover:bg-muted/50"
            onClick={() => setShowFlow(!showFlow)}
          >
            {showFlow ? t('收起审批流程') : t('查看审批流程')}
          </button>
          {showFlow && (
            <div className="overflow-x-auto border-t">
              <FlowView
                model={sf.model}
                form={sf.form}
                editable={false}
                userName={(id) => sf.names.users[id] ?? id}
                roleName={(id) => sf.names.roles[id] ?? id}
              />
            </div>
          )}
        </div>
      </div>
      <SheetFooter className="flex-row justify-end gap-2 border-t">
        <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
        <Button onClick={submit} disabled={start.isPending} data-testid="wf-start-submit">
          {start.isPending && <IconLoader2 className="size-4 animate-spin" />}
          {t('提交')}
        </Button>
      </SheetFooter>
    </>
  )
}

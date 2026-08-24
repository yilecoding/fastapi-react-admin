import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { IconInfoCircle, IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Label } from '@admin/ui/components/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import {
  EXPRESSION_ITEMS, OPERATOR_ITEMS,
  rlColumnsQuery, rlModelsQuery, templateVarsQuery,
  useCreateDataRule, useUpdateDataRule, type DataRule,
} from './api'

/**
 * 规则表单。
 *
 * `onCreated` 是合并页的关键：新建成功后把规则本体回调出去，由调用方立刻挂到
 * 当前数据范围上。少了这一步就会留下「建了但没挂」的孤儿规则 —— 库里已经有一条。
 */

const schema = z.object({
  name: z.string().min(1, '请输入规则名称').max(50),
  model: z.string().min(1, '请选择作用模型'),
  column: z.string().min(1, '请选择或填写字段'),
  operator: z.coerce.number().int(),
  expression: z.coerce.number().int(),
  value: z.string().min(1, '请输入规则值'),
})
type Values = z.infer<typeof schema>

export function DataRuleSheet({ open, onOpenChange, editing, onCreated }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: DataRule | null
  onCreated?: (rule: DataRule) => Promise<void> | void
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateDataRule()
  const update = useUpdateDataRule()
  const [err, setErr] = React.useState<string | null>(null)

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: '', model: '', column: '', operator: 0, expression: 0, value: '' },
  })

  const model = form.watch('model')
  const { data: models = [] } = useQuery(rlModelsQuery)
  const { data: columns = [] } = useQuery(rlColumnsQuery(model))
  const { data: tvars = [] } = useQuery(templateVarsQuery)

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    form.reset(editing
      ? { name: editing.name, model: editing.model, column: editing.column,
          operator: editing.operator, expression: editing.expression, value: editing.value }
      : { name: '', model: '', column: '', operator: 0, expression: 0, value: '' })
  }, [open, editing, form])

  // ⚠️ deps 里必须有 `t`，否则切语言这两个映射不重算（关闭态的标签会留在旧语言）
  const modelItems = React.useMemo(
    () => Object.fromEntries(models.map((m) => [m, m === '__ALL__' ? t('全部模型（__ALL__）') : m])),
    [models, t]
  )
  /** 字段注释来自后端模型的 `comment=`（仓库里写的中文），过一次 t() —— 查不到回落原文 */
  const columnLabel = React.useCallback(
    (key: string, comment: string | null) => (comment ? `${key} · ${t(comment)}` : key),
    [t]
  )
  const columnItems = React.useMemo(
    () => Object.fromEntries(columns.map((c) => [c.key, columnLabel(c.key, c.comment)])),
    [columns, columnLabel]
  )

  const pending = create.isPending || update.isPending
  const errs = form.formState.errors

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑数据规则') : t('新增数据规则')}</SheetTitle>
          <SheetDescription>
            <Trans
              t={t}
              i18nKey="规则最终会被翻译成一个 WHERE 条件，由后端 <c>filter_data_permission</c> 拼进查询。"
              components={{ c: <code /> }}
            />
            {!isEdit && t('保存后自动挂到当前数据范围。')}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={form.handleSubmit(async (v) => {
            setErr(null)
            const body = {
              name: v.name.trim(), model: v.model, column: v.column.trim(),
              operator: v.operator, expression: v.expression, value: v.value.trim(),
            }
            try {
              if (isEdit && editing) {
                await update.mutateAsync({ id: editing.id, body })
              } else {
                const rule = await create.mutateAsync(body)
                await onCreated?.(rule)
              }
              onOpenChange(false)
            } catch (e) { setErr(e instanceof ApiError ? e.message : t('保存失败')) }
          })}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-2">
            <Fld label={t("规则名称")} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} data-testid="dr-name" autoComplete="off"
                     placeholder={t("如：只看本部门订单")} />
            </Fld>

            <Fld label={t("作用模型")} error={fe(errs.model?.message)} required>
              <Select value={model} items={modelItems}
                      onValueChange={(v) => { form.setValue('model', v ?? '', { shouldValidate: true }); form.setValue('column', '') }}>
                <SelectTrigger className="w-full" data-testid="dr-model"><SelectValue placeholder={t("选择模型")} /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>{m === '__ALL__' ? t('全部模型（__ALL__）') : m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Fld>

            <Fld label={t("字段")} error={fe(errs.column?.message)} required>
              {model && model !== '__ALL__' && columns.length > 0 ? (
                <Select value={form.watch('column')} items={columnItems}
                        onValueChange={(v) => form.setValue('column', v ?? '', { shouldValidate: true })}>
                  <SelectTrigger className="w-full" data-testid="dr-column"><SelectValue placeholder={t("选择字段")} /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {columns.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {columnLabel(c.key, c.comment)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input {...form.register('column')} data-testid="dr-column"
                       placeholder={model === '__ALL__' ? t('如 __dept_id__（模板字段）') : t('先选模型')} />
              )}
            </Fld>

            <div className="grid grid-cols-2 gap-4">
              <Fld label={t("连接方式")} error={fe(errs.operator?.message)} required>
                <Select value={String(form.watch('operator'))} items={Object.fromEntries(Object.entries(OPERATOR_ITEMS).map(([k, v]) => [k, t(v)]))}
                        onValueChange={(v) => form.setValue('operator', Number(v), { shouldValidate: true })}>
                  <SelectTrigger className="w-full" data-testid="dr-operator"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(OPERATOR_ITEMS).map(([v, l]) => <SelectItem key={v} value={v}>{t(l)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Fld>
              <Fld label={t("比较运算")} error={fe(errs.expression?.message)} required>
                <Select value={String(form.watch('expression'))} items={Object.fromEntries(Object.entries(EXPRESSION_ITEMS).map(([k, v]) => [k, t(v)]))}
                        onValueChange={(v) => form.setValue('expression', Number(v), { shouldValidate: true })}>
                  <SelectTrigger className="w-full" data-testid="dr-expression"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(EXPRESSION_ITEMS).map(([v, l]) => <SelectItem key={v} value={v}>{t(l)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Fld>
            </div>

            <Fld label={t("规则值")} error={fe(errs.value?.message)} required>
              <Input {...form.register('value')} data-testid="dr-value" autoComplete="off"
                     placeholder={t("字面量，或使用下方模板变量")} />
            </Fld>

            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <IconInfoCircle className="size-3.5" />{t('可用模板变量（点击插入）')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {/* ⚠️ 回调参数**不能叫 `t`** —— 会遮蔽翻译函数，`title` 就永远是中文 */}
                {tvars.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    data-testid={`dr-var-${v.key.replace(/[${}]/g, '')}`}
                    onClick={() => form.setValue('value', v.key, { shouldValidate: true })}
                    className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs hover:bg-muted"
                    title={t(v.comment)}
                  >
                    {v.key}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                <Trans
                  t={t}
                  i18nKey="按组织隔离的典型写法：模型选业务表、字段选 <c>dept_id</c>、运算选「等于」、值用 <d>{{tpl}}</d>。"
                  values={{ tpl: '${dept_id}' }}
                  components={{ c: <code />, d: <code /> }}
                />
              </p>
            </div>

            {err && <p className="text-sm text-destructive" data-testid="form-error">{err}</p>}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="dr-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建规则')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function Fld({ label, error, required, children }: {
  label: string; error?: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}{required && <span className="ms-0.5 text-destructive">*</span>}</Label>
      {children}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

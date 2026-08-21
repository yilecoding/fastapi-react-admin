"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { IconCopy, IconFolderPlus, IconPlus, IconX } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Combobox } from "@admin/ui/components/combobox"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@admin/ui/components/select"
import { cn } from "@admin/ui/lib/utils"

import { FieldControl } from "./field-control"
import {
  OPERATOR_LABEL, emptyGroup, isGroup, newCondition, nextId, operatorsOf,
  type Condition, type ConditionGroup, type FilterField, type Operator,
} from "./types"
import type { QueryErrors } from "./validate"
import { withField, withOperator } from "./value"

/**
 * 高级筛选：可嵌套的条件树。
 *
 * 每一层是一个「全部满足 / 任一满足」的分组，里面可以放条件，也可以再放分组。
 * 和基础模式的区别不只是能选运算符 —— 是能表达 `(A 且 B) 或 C` 这种，
 * 基础模式的平铺 AND 永远表达不了。
 *
 * 树的增删改用**不可变递归重写**：每次操作从根重建一份新树。条件量级在几十条，
 * 不值得为了省几次对象分配去搞可变操作 + 手动触发重渲染。
 *
 * ⚠️ 高级模式的出参是**条件树**（`toFilterTree`），后端得先有过滤语法才接得住。
 * 没有的话别把 `advanced` 打开 —— 界面上配得出 `或`、发出去只剩平铺 AND，
 * 是最难解释的那种「查出来的不是我要的」。
 */

/** 下拉超过这个项数就换成可搜索的 */
const SEARCHABLE_FROM = 8

export function AdvancedFilter({
  fields,
  group,
  onChange,
  onSubmit,
  errors,
}: {
  fields: readonly FilterField[]
  group: ConditionGroup
  onChange: (next: ConditionGroup) => void
  onSubmit?: () => void
  errors?: QueryErrors
}) {
  return (
    <GroupNode
      fields={fields} node={group} depth={0}
      onChange={onChange} onSubmit={onSubmit} errors={errors}
    />
  )
}

function GroupNode({
  fields, node, depth, onChange, onRemove, onSubmit, errors,
}: {
  fields: readonly FilterField[]
  node: ConditionGroup
  depth: number
  onChange: (next: ConditionGroup) => void
  onRemove?: () => void
  onSubmit?: () => void
  errors?: QueryErrors
}) {
  const { t } = useTranslation()

  const patchChild = (id: string, next: Condition | ConditionGroup | null) =>
    onChange({
      ...node,
      children: next
        ? node.children.map((c) => (c.id === id ? next : c))
        : node.children.filter((c) => c.id !== id),
    })

  const addCondition = () => {
    const f = fields[0]
    if (!f) return
    onChange({ ...node, children: [...node.children, newCondition(f)] })
  }

  /** 复制一条：改一个值再来一遍是最常见的动作，重新挑字段 + 挑运算符纯属重复劳动 */
  const duplicate = (c: Condition) =>
    onChange({ ...node, children: [...node.children, { ...c, id: nextId() }] })

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md",
        depth > 0 && "border border-dashed bg-muted/20 p-2"
      )}
      data-testid={`qb-group-${node.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* 它标的是紧邻的那个 Select，字号得和它一样（基础模式的字段名同理）——
            差一号的话每一层分组头上都是 12/14 交替 */}
        <span className="text-sm text-muted-foreground">{t("筛选条件")}</span>
        <LogicSelect
          value={node.logic}
          onChange={(logic) => onChange({ ...node, logic })}
          testId={`qb-logic-${node.id}`}
        />

        <Button variant="outline" size="sm" className="h-8" onClick={addCondition}
                data-testid={`qb-add-cond-${node.id}`}>
          <IconPlus className="size-4" />{t("添加条件")}
        </Button>
        {/* 嵌套三层以上没人读得懂，也没人配得对 */}
        {depth < 2 && (
          <Button
            variant="outline" size="sm" className="h-8"
            data-testid={`qb-add-group-${node.id}`}
            onClick={() => onChange({ ...node, children: [...node.children, emptyGroup()] })}
          >
            <IconFolderPlus className="size-4" />{t("添加分组")}
          </Button>
        )}
        {onRemove && (
          <Button variant="ghost" size="icon"
                  className="ms-auto size-7 text-muted-foreground hover:text-destructive"
                  aria-label={t("删除分组")}
                  onClick={onRemove} data-testid={`qb-del-group-${node.id}`}>
            <IconX className="size-4" />
          </Button>
        )}
      </div>

      {node.children.length === 0 ? (
        <button
          type="button"
          onClick={addCondition}
          data-testid={`qb-empty-${node.id}`}
          className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground hover:bg-muted/40"
        >
          {t("暂无条件，点击此处添加")}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          {node.children.map((child, i) => (
            <div key={child.id} className="flex items-start gap-2">
              <span className="w-14 shrink-0 pt-1.5 text-end text-sm text-muted-foreground">
                {i === 0 ? "" : node.logic === "and" ? t("并且") : t("或者")}
              </span>
              {isGroup(child) ? (
                <div className="min-w-0 flex-1">
                  <GroupNode
                    fields={fields} node={child} depth={depth + 1}
                    onChange={(n) => patchChild(child.id, n)}
                    onRemove={() => patchChild(child.id, null)}
                    onSubmit={onSubmit}
                    errors={errors}
                  />
                </div>
              ) : (
                <ConditionRow
                  fields={fields} cond={child}
                  error={errors?.[child.id]}
                  onChange={(n) => patchChild(child.id, n)}
                  onRemove={() => patchChild(child.id, null)}
                  onDuplicate={() => duplicate(child)}
                  onSubmit={onSubmit}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LogicSelect({
  value, onChange, testId,
}: {
  value: "and" | "or"
  onChange: (v: "and" | "or") => void
  testId?: string
}) {
  const { t } = useTranslation()
  // items 是**关闭态**的标签源，必须在渲染处翻 —— 传中文常量进去等于关闭态永不翻译
  const items = React.useMemo(
    () => ({ and: t("全部满足"), or: t("任一满足") }),
    [t]
  )
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(v: string | null) => onChange(v === "or" ? "or" : "and")}
    >
      <SelectTrigger size="sm" className="w-28" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="and">{items.and}</SelectItem>
        <SelectItem value="or">{items.or}</SelectItem>
      </SelectContent>
    </Select>
  )
}

function ConditionRow({
  fields, cond, error, onChange, onRemove, onDuplicate, onSubmit,
}: {
  fields: readonly FilterField[]
  cond: Condition
  error?: QueryErrors[string]
  onChange: (n: Condition) => void
  onRemove: () => void
  onDuplicate: () => void
  onSubmit?: () => void
}) {
  const { t } = useTranslation()
  const field = fields.find((f) => f.key === cond.field) ?? fields[0]!
  const ops = operatorsOf(field)

  const fieldOptions = React.useMemo(
    () => fields.map((f) => ({ value: f.key, label: t(f.label), hint: f.group ? t(f.group) : undefined })),
    [fields, t]
  )
  const opOptions = React.useMemo(
    () => ops.map((o) => ({ value: o, label: t(OPERATOR_LABEL[o]) })),
    [ops, t]
  )

  const pickField = (key: string | null) => {
    const nf = fields.find((f) => f.key === key)
    if (nf) onChange(withField(cond, nf))
  }

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2" data-testid={`qb-row-${cond.id}`}>
      {fields.length > SEARCHABLE_FROM ? (
        <Combobox
          value={cond.field}
          onValueChange={pickField}
          options={fieldOptions}
          size="sm"
          className="w-36"
          searchPlaceholder={t("搜索字段")}
          emptyText={t("没有匹配项")}
          data-testid={`qb-field-sel-${cond.id}`}
        />
      ) : (
        <Select
          value={cond.field}
          items={Object.fromEntries(fieldOptions.map((o) => [o.value, o.label]))}
          onValueChange={pickField}
        >
          <SelectTrigger size="sm" className="w-36" data-testid={`qb-field-sel-${cond.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fieldOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      <Select
        value={cond.op}
        items={Object.fromEntries(opOptions.map((o) => [o.value, o.label]))}
        onValueChange={(v: string | null) => onChange(withOperator(cond, field, (v as Operator) ?? cond.op))}
      >
        <SelectTrigger size="sm" className="w-28" data-testid={`qb-op-${cond.id}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {opOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <FieldControl
        field={field} op={cond.op} value={cond.value}
        onChange={(v) => onChange({ ...cond, value: v })}
        onSubmit={onSubmit}
        invalid={Boolean(error)}
        size="sm"
        testId={`qb-val-${cond.id}`}
      />

      {/* 高级模式一行有横向空间，错误直接写出来 —— 比 tooltip 少一次悬停 */}
      {error && (
        <span className="text-xs text-destructive" data-testid={`qb-err-${cond.id}`}>
          {t(error.key, error.vars)}
        </span>
      )}

      {/* 行尾这两个是次要动作，要和基础模式里的 × 同一档灰 ——
          用默认前景色的话它们是整行最黑的两个东西，比字段名还抢眼 */}
      <Button variant="ghost" size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t("复制条件")}
              onClick={onDuplicate} data-testid={`qb-dup-${cond.id}`}>
        <IconCopy className="size-4" />
      </Button>
      <Button variant="ghost" size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={t("删除条件")}
              onClick={onRemove} data-testid={`qb-del-${cond.id}`}>
        <IconX className="size-4" />
      </Button>
    </div>
  )
}

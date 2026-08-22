"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { IconPlus, IconSearch, IconSelector, IconX } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Checkbox } from "@admin/ui/components/checkbox"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger,
} from "@admin/ui/components/dropdown-menu"
import { InputGroup, InputGroupAddon } from "@admin/ui/components/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@admin/ui/components/popover"
import { Separator } from "@admin/ui/components/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@admin/ui/components/tooltip"
import { cn } from "@admin/ui/lib/utils"

import { FieldControl } from "./field-control"
import {
  OPERATOR_LABEL, newCondition, operatorsOf,
  type Condition, type FilterField, type Operator,
} from "./types"
import type { QueryErrors } from "./validate"
import { indexFields, withOperator } from "./value"

/**
 * 基础筛选：一片 `[字段名 | 值]` 的**等宽网格**，隐含 AND。
 *
 * 两条设计取舍：
 *
 * 1. **默认不摆字段。** 传统查询表单一上来铺 8 个空输入框，视觉噪音大、
 *    还占掉小半屏，而实际每次只用一两个。这里默认只显示 `defaultVisible` 的，
 *    其余按需从「添加条件」里挑 —— 挑过的记在条件列表里，而条件列表由页面写进
 *    URL（`packQuery`），所以刷新之后那几格还在。
 *
 * 2. 🔴 **必须是网格，不能是 `flex-wrap`。**
 *    第一版是 flex 换行 + 每个控件自带固定宽度（`w-44` / `w-56` / `w-72`），
 *    于是每格宽度 = 标签宽 + 控件宽 + 移除按钮位，三项都随字段变 ——
 *    十四个条件铺出来**没有两格是一样宽的**，也没有一条对齐的竖边
 *    （用户截图指出过：「样式设计需要优化」那张）。
 *    网格让右边界天然对齐，列数跟着容器走，长内容用 `span: 2` 跨两格。
 *
 * 「添加条件」和折叠按钮**不在这个网格里** —— 它们由 `index.tsx` 放进动作行。
 * 放网格里的话，条件数恰好等于列数时（用户管理页 5 个条件撞上 5 列）
 * 它会独占第二行的一格，白搭 40px；而且行数会随条件数忽多忽少。
 */

/** 一行几列：跟着**容器**宽度走，不是视口 —— 查询区可能在页面主区，也可能在抽屉里 */
const GRID = "grid grid-cols-1 gap-2 @lg/qb:grid-cols-2 @3xl/qb:grid-cols-3 @5xl/qb:grid-cols-4 @7xl/qb:grid-cols-5"

export function BasicFilter({
  fields,
  conditions,
  visibleCount,
  onChange,
  onSubmit,
  errors,
}: {
  fields: readonly FilterField[]
  conditions: readonly Condition[]
  /**
   * 渲染前几格（折叠用）。**收到的仍是完整的 `conditions`** ——
   * 只传裁剪过的数组会让「移除」把折叠掉的那几条一起丢掉，
   * 因为增删改都是在传进来的这个数组上做的。
   */
  visibleCount?: number
  onChange: (next: Condition[]) => void
  onSubmit?: () => void
  errors?: QueryErrors
}) {
  const { t } = useTranslation()
  const byKey = React.useMemo(() => indexFields(fields), [fields])

  const patch = (id: string, next: Condition) =>
    onChange(conditions.map((c) => (c.id === id ? next : c)))

  const remove = (id: string) => onChange(conditions.filter((c) => c.id !== id))

  const shown = visibleCount === undefined ? conditions : conditions.slice(0, visibleCount)

  return (
    <div className={GRID}>
      {shown.map((c) => {
        const f = byKey.get(c.field)
        // 字段已被删（老 URL / 老视图）——静默跳过，页面恢复时 pruneUnknown 会清掉
        if (!f) return null
        const err = errors?.[c.id]
        const ops = operatorsOf(f)

        return (
          <InputGroup
            key={c.id}
            className={cn(
              "group/cond h-8 w-full",
              // 焦点反馈**统一由外框接**：里面的控件已经被 `inline` 去掉了自己的
              // 边框和 ring，不接的话聚焦时完全没有反馈。用 `has-[:focus-visible]`
              // 而不是 InputGroup 自带的 `has-[[data-slot=input-group-control]…]`
              // —— 后者只认原生 input，Select / 日期按钮这些触发器都漏在外面
              "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
              // 跨两格只在真的有两列时才生效，否则单列布局下会溢出
              f.span === 2 && "@lg/qb:col-span-2",
              err && "border-destructive"
            )}
            data-testid={`qb-cond-${c.field}`}
          >
            {/*
              三件事：
              - `shrink-0 whitespace-nowrap` —— 容器一窄，「创建时间」会被压成一列
                竖排的字（实测 320px 宽的查询区就是这样）。该收缩的是值控件
              - 右侧那条淡竖线是**标签和值的分界** —— 少了它读起来是一句话
                （「姓名包含模糊匹配」），分不清哪半是字段名
              - 🔴 字号是 `text-sm`（14px），**和值一样大**。原来给了 `text-xs`
                （12px），于是同一个 32px 的框里字段名比它标注的值小一号，
                一整片网格上 12/14 交替（用户截图指出过）。层级靠**颜色**分：
                字段名 muted、值 foreground —— 不靠字号
            */}
            <InputGroupAddon
              align="inline-start"
              className="shrink-0 border-e border-border/60 pe-2 text-sm whitespace-nowrap text-muted-foreground"
            >
              {f.showOperator && ops.length > 1 ? (
                <OperatorPicker
                  label={t(f.label)}
                  op={c.op}
                  ops={ops}
                  testId={`qb-op-${c.field}`}
                  onChange={(op) => patch(c.id, withOperator(c, f, op))}
                />
              ) : (
                <span>{t(f.label)}</span>
              )}
            </InputGroupAddon>

            <FieldControl
              field={f}
              op={c.op}
              value={c.value}
              onChange={(v) => patch(c.id, { ...c, value: v })}
              onSubmit={onSubmit}
              inline
              size="sm"
              testId={`qb-input-${c.field}`}
            />

            <InputGroupAddon align="inline-end" className="gap-1 ps-0">
              {err && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="grid size-4 place-content-center rounded-full bg-destructive text-[10px] font-bold text-white"
                        data-testid={`qb-err-${c.field}`}
                      />
                    }
                  >
                    !
                  </TooltipTrigger>
                  <TooltipContent>{t(err.key, err.vars)}</TooltipContent>
                </Tooltip>
              )}
              {/*
                移除按钮和控件之间要有**一条竖线 + 间距**。
                挨着 Select 的上下箭头放（两个 16px 灰图标间距 6px、没有分隔）
                的时候，「换个值」和「删掉这一条」看起来是同一组控件 ——
                用户截图特写过这一处。
                locked 的条件不给这个入口：藏起来比给个点了没反应的 × 好。

                ⚠️ `inline-flex items-center py-1.5 ps-2` 这一串是为了**和左边那条
                分隔线长得一样**：左边的 border 长在 addon 上（`py-1.5` 撑到 26px），
                这里的 border 长在按钮上，不给同样的垂直内边距的话只有图标那 14px 高
                —— 一长一短，看着像 × 没对齐（3× 放大才看得出来，用户截图指出过）。
                水平也对称：两侧各 8px（`ps-2` + addon 自带的 `pe-2`）。
              */}
              {!f.locked && (
                <button
                  type="button"
                  aria-label={t("移除筛选条件 {{name}}", { name: t(f.label) })}
                  data-testid={`qb-remove-${c.field}`}
                  onClick={() => remove(c.id)}
                  className="inline-flex items-center border-s border-border/60 py-1.5 ps-2 text-muted-foreground opacity-0 transition-opacity group-hover/cond:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                >
                  <IconX className="size-3.5" />
                </button>
              )}
            </InputGroupAddon>
          </InputGroup>
        )
      })}

    </div>
  )
}

/**
 * 字段名兼运算符入口。
 *
 * 运算符**长在字段名上**而不是另起一个下拉：一格里三个控件
 * （字段名、运算符、值）就是高级模式，基础模式的价值恰恰是「一眼一行」。
 * 挂在名字上之后，不开这个功能的字段看起来完全不变。
 */
function OperatorPicker({
  label, op, ops, onChange, testId,
}: {
  label: string
  op: Operator
  ops: readonly Operator[]
  onChange: (op: Operator) => void
  testId?: string
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("{{name}} 的匹配方式", { name: label })}
            data-testid={testId}
            className="flex items-center gap-1 rounded-sm text-sm hover:text-foreground"
          />
        }
      >
        <span>{label}</span>
        {/*
          运算符夹在「字段名」和「值」之间，颜色也夹在中间：
          它是用户**选过的**（比静态字段名重要），但仍是修饰语（不该抢过值）。
          字号不动 —— 一格里只有一种字号。
        */}
        <span className="text-foreground/70">{t(OPERATOR_LABEL[op])}</span>
        <IconSelector className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-32">
        <DropdownMenuGroup>
          {ops.map((o) => (
            <DropdownMenuItem
              key={o}
              data-testid={testId && `${testId}-${o}`}
              className={cn(o === op && "bg-muted font-medium")}
              onClick={() => onChange(o)}
            >
              {t(OPERATOR_LABEL[o])}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 「添加条件」：勾选要参与筛选的字段。
 *
 * 三件事是字段一多就必须有的（用户页 + 日志页合起来已经十几个字段）：
 * 搜索框、按 `group` 分组、以及「清空全部」。少了搜索框就是在一长条里瞎滚，
 * 少了分组就分不出「基本信息」和「时间」。
 */
export function FieldPicker({
  fields, conditions, onChange,
}: {
  fields: readonly FilterField[]
  conditions: readonly Condition[]
  onChange: (next: Condition[]) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = React.useState("")
  const used = React.useMemo(() => new Set(conditions.map((c) => c.field)), [conditions])

  /**
   * 新加的条件**按字段声明顺序插入**，不是追加到末尾。
   *
   * 理由是 URL 那边：`fromUrlParams` 一律按声明顺序还原（不记「我加在哪个位置」，
   * 那会让每个筛选项的位置随手速变化）。这里不同步的话，加完条件是一个位置、
   * 刷新之后跳到另一个位置。顺带的好处是每个筛选项在页面上位置固定，扫得更快。
   */
  const order = React.useMemo(() => new Map(fields.map((f, i) => [f.key, i])), [fields])
  const insert = (next: Condition[]) =>
    [...next].sort((a, b) => (order.get(a.field) ?? 0) - (order.get(b.field) ?? 0))

  const toggle = (f: FilterField) => {
    if (used.has(f.key)) {
      if (f.locked) return
      onChange(conditions.filter((c) => c.field !== f.key))
    } else {
      onChange(insert([...conditions, newCondition(f)]))
    }
  }

  const matcher = React.useMemo(() => {
    const kw = q.trim().toLowerCase()
    return (f: FilterField) =>
      !kw || t(f.label).toLowerCase().includes(kw) || f.key.toLowerCase().includes(kw)
  }, [q, t])

  /** 按 group 分桶。没给 group 的落在最前面的「未分组」桶，不另起标题 */
  const groups = React.useMemo(() => {
    const out = new Map<string, FilterField[]>()
    for (const f of fields) {
      if (!matcher(f)) continue
      const g = f.group ?? ""
      if (!out.has(g)) out.set(g, [])
      out.get(g)!.push(f)
    }
    return [...out.entries()]
  }, [fields, matcher])

  const removable = conditions.filter((c) => !fields.find((f) => f.key === c.field)?.locked)
  const searchable = fields.length > 8

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline" size="sm"
            className="h-8 border-dashed text-muted-foreground"
          />
        }
        data-testid="qb-add-condition"
      >
        <IconPlus className="size-4" />
        {t("添加条件")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {searchable ? (
          <div className="flex items-center gap-2 border-b px-2">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("搜索字段")}
              data-testid="qb-field-search"
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("勾选要参与筛选的字段")}</p>
        )}

        <div className="max-h-72 overflow-y-auto">
          {groups.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("没有匹配项")}</p>
          )}
          {groups.map(([group, list]) => (
            <div key={group}>
              {group && (
                <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {t(group)}
                </p>
              )}
              {list.map((f) => {
                const on = used.has(f.key)
                return (
                  <button
                    key={f.key}
                    type="button"
                    data-testid={`qb-field-${f.key}`}
                    disabled={f.locked && on}
                    onClick={() => toggle(f)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm hover:bg-muted disabled:opacity-60"
                  >
                    {/* render={<span />} 不能省：Base UI 的 Checkbox 默认是 <button>，
                        套在这个 button 里就是嵌套可交互元素 */}
                    <Checkbox
                      render={<span />}
                      checked={on}
                      className="pointer-events-none"
                      tabIndex={-1}
                    />
                    <span className="min-w-0 flex-1 truncate">{t(f.label)}</span>
                    {f.hint && (
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                        {t(f.hint)}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {removable.length > 0 && (
          <>
            <Separator className="my-1" />
            <Button
              variant="ghost" size="sm"
              className="h-8 w-full justify-start text-muted-foreground"
              data-testid="qb-clear-fields"
              onClick={() => onChange(conditions.filter((c) => fields.find((f) => f.key === c.field)?.locked))}
            >
              <IconX className="size-3.5" />
              {t("移除全部条件")}
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { IconX } from "@tabler/icons-react"

import { Combobox } from "@admin/ui/components/combobox"
import { DateTimeRangePicker, DateTimeValuePicker } from "@admin/ui/components/datetime-picker"
import { Input } from "@admin/ui/components/input"
import { MultiSelect } from "@admin/ui/components/multi-select"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@admin/ui/components/select"
import { cn } from "@admin/ui/lib/utils"

import { valueShape, type FieldControlContext, type FilterField } from "./types"

/**
 * 按「字段类型 + 运算符」渲染值控件。
 *
 * 只管「值长什么样」，不管条件怎么组织 —— 基础模式和高级模式共用同一套，
 * 所以两边的输入体验天然一致，不会出现「同一个字段在两个地方控件不一样」。
 *
 * 形态由 `valueShape()` 决定（不吃值 / 单值 / 两端 / 多个），**不是**由类型
 * 单独决定。原来只看类型的后果是实打实的：`select` 的默认运算符里有「属于」，
 * 而控件只有单选下拉 —— 勾了「属于」还是只能选一个，出参也只有一个值。
 *
 * ---
 *
 * 🔴 **「嵌在框里」是一个 `inline` 布尔量，不是一串 className。**
 *
 * 基础模式把控件塞进 `InputGroup`（外面已经有一圈边框），控件必须去掉自己的
 * 边框和阴影。第一版靠调用方传一串 `border-0 shadow-none …` 下来 ——
 * 于是**漏一个分支就静默双框**：`dateTimeRange` 走的是
 * `cn(field.width, invalid)`，把那串类丢了；数字区间更糟，类给了外层
 * 包裹用的 `<span>`（对它没用），里面两个 `Input` 各自带边框，
 * 表现成「一个框里套着两个框」。两处都是用户截图指出来的。
 *
 * 现在语义化成 `inline`：控件自己决定去掉什么。加新控件时忘了它会**长得不对**
 * （一眼看见），而不是**恰好对**（要靠人眼在某个字段上撞见）。
 */

/** 超过这个数量的下拉换成可搜索的（和 `_shared/filters.tsx` 同一条线） */
const SEARCHABLE_FROM = 8

/** 清空当前选择的哨兵值。Select 的 value 不能是 undefined，只能给个不会撞的串 */
const ALL = "__qb_all__"

const heights = { sm: "h-8", default: "h-9" } as const

/** 校验没过的那一格要**看得出来**，不能只在顶上写一句「条件有误」 */
const INVALID = "border-destructive ring-3 ring-destructive/20"

/**
 * `type=number` 的原生微调箭头在筛选栏里是纯噪音：悬停才出现，一出现就把
 * 「介于」那一格挤成「最小 ⇅ – 最大」，两侧间距还不对称（2× 截图下很明显）。
 * 筛选场景是打字，不是点箭头。
 */
const NO_SPIN =
  "[&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"

/**
 * 嵌进 `InputGroup` 时去掉自己的一圈边框 —— 外框已经有了。
 *
 * ⚠️ `focus-within:ring-0` 不能省。`TagsInput` 的高亮是
 * `focus-within:ring-3`（它自己也能独立使用），少了这一条，聚焦的瞬间
 * 外框里会浮出一个**内圈**，双框在焦点态复活。
 * 焦点反馈统一由外框接（见 `basic.tsx` 的 `has-[:focus-visible]:*`）。
 */
const INLINE =
  "border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 focus-within:border-0 focus-within:ring-0 hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"

export function FieldControl({
  field,
  op,
  value,
  onChange,
  onSubmit,
  invalid,
  inline,
  size = "sm",
  className,
  testId,
}: FieldControlContext & { size?: "sm" | "default" }) {
  const { t } = useTranslation()
  const shape = valueShape(field, op)

  // 「为空 / 不为空」不吃值，渲染出来只会让人以为要填
  if (shape === "none") return null

  if (field.render) {
    return (
      <>
        {field.render({
          field, op, value, onChange, onSubmit, invalid, inline, size, className, testId,
        })}
      </>
    )
  }

  /**
   * 控件自己的外观。
   *
   * - inline（基础模式，嵌在 `InputGroup` 里）：不要边框、撑满外框的剩余宽度、
   *   错误态交给外框（外框已经整圈变红，里面再红一次是重复）
   * - 非 inline（高级模式，条件行里的独立控件）：`flex-1 basis-48` ——
   *   🔴 **不能给 `w-full`**。条件行是 flex，`w-full` = 100% 行宽 → 值控件把
   *   `[字段][运算符]` 挤到上一行、`[复制][删除]` 挤到下一行，**一条条件占三行**
   *   （实测 2× 截图）。`flex-1` 是「吃掉剩余宽度」，`basis-48` 给它一个
   *   收缩下限，窄行才换行。
   */
  const box = inline
    ? cn(INLINE, "min-w-0 flex-1")
    : cn(heights[size], "min-w-0 flex-1 basis-48", invalid && INVALID)

  const common = { field, value, onChange, onSubmit, size, invalid, inline, testId, box, className }

  if (shape === "range") return <RangeControl {...common} />
  if (shape === "multi") return <MultiControl {...common} />

  switch (field.type) {
    case "select":
      return <SelectControl {...common} />

    case "boolean":
      return (
        <PlainSelect
          {...common}
          value={value === undefined || value === null ? null : String(value)}
          items={[
            { value: ALL, label: t("不限") },
            { value: "true", label: t("是") },
            { value: "false", label: t("否") },
          ]}
          placeholder={field.placeholder ?? t("请选择")}
          onChange={(v) => onChange(v === ALL || v == null ? undefined : v === "true")}
        />
      )

    case "date":
    case "dateTime":
      return (
        <DateTimeValuePicker
          value={value as string | undefined}
          onChange={onChange}
          withTime={field.type === "dateTime" || field.withTime}
          placeholder={field.placeholder}
          size={size}
          disabled={field.disabled}
          className={cn(box, className)}
          aria-label={t(field.label)}
          data-testid={testId}
        />
      )

    case "time":
      return (
        <Input
          type="time" step={1}
          className={cn(box, className)}
          value={(value as string) ?? ""}
          disabled={field.disabled}
          aria-label={t(field.label)}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value || undefined)}
          onKeyDown={submitOnEnter(onSubmit)}
        />
      )

    case "number":
      return (
        <Input
          type="number"
          className={cn(box, NO_SPIN, className)}
          value={(value as string) ?? ""}
          min={field.min} max={field.max} step={field.step}
          placeholder={field.placeholder ?? t("请输入")}
          disabled={field.disabled}
          aria-label={t(field.label)}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          onKeyDown={submitOnEnter(onSubmit)}
        />
      )

    default:
      return (
        <Input
          className={cn(box, className)}
          value={(value as string) ?? ""}
          placeholder={field.placeholder ?? t("请输入")}
          disabled={field.disabled}
          aria-label={t(field.label)}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value || undefined)}
          onKeyDown={submitOnEnter(onSubmit)}
        />
      )
  }
}

/**
 * 回车 = 搜索。
 *
 * 查询区最自然的动作是「敲完按回车」，而它原来什么都不做 —— 得把手从键盘挪到
 * 鼠标去点「搜索」。**必须 `preventDefault`**：查询区可能落在一个 `<form>` 里，
 * 不拦的话回车会触发表单默认提交，整页刷新。
 */
const submitOnEnter = (onSubmit?: () => void) => (e: React.KeyboardEvent) => {
  if (e.key !== "Enter" || !onSubmit) return
  e.preventDefault()
  onSubmit()
}

/** 各分控件共用的一份入参 —— 加一个控件时不用再抄一遍十个 prop */
type SubProps = {
  field: FilterField
  value: unknown
  onChange: (v: unknown) => void
  onSubmit?: () => void
  size: "sm" | "default"
  invalid?: boolean
  inline?: boolean
  testId?: string
  /** 已经算好的外观类（含 inline 去边框 / 非 inline 的高度与错误态） */
  box: string
  className?: string
}

/* ------------------------------------------------------------ 两端（介于 / 区间） */

function RangeControl({
  field, value, onChange, onSubmit, size, invalid, inline, testId, box, className,
}: SubProps) {
  const { t } = useTranslation()
  const [a, b] = (Array.isArray(value) ? value : []) as [unknown, unknown]

  const isDate = field.type === "date" || field.type === "dateRange"
  const isDateTime = field.type === "dateTime" || field.type === "dateTimeRange"

  if (isDate || isDateTime) {
    return (
      <DateTimeRangePicker
        value={[a as string | undefined, b as string | undefined]}
        onChange={(r) => onChange(r === undefined ? undefined : [r[0], r[1]])}
        withTime={isDateTime || field.withTime}
        presets={field.presets ?? true}
        placeholder={field.placeholder}
        size={size}
        disabled={field.disabled}
        className={cn(box, className)}
        aria-label={t(field.label)}
        data-testid={testId}
      />
    )
  }

  const numeric = field.type === "number"
  const type = field.type === "time" ? "time" : numeric ? "number" : "text"
  const parse = (raw: string): unknown => (raw === "" ? undefined : numeric ? Number(raw) : raw)

  /**
   * 两个框各占一半。inline 时它们**都要去边框** —— 这里就是原来那个
   * 「一个框里套两个框」的现场：外层 `<span>` 拿着去边框的类，
   * 而边框长在里面两个 `Input` 上。
   */
  const half = cn(
    numeric && NO_SPIN,
    inline
      ? cn(INLINE, "min-w-0 flex-1 px-0")
      : cn(heights[size], "min-w-0 flex-1", invalid && INVALID)
  )

  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        // 同上：非 inline 时不能 `w-full`，否则整条条件被挤成三行
        inline ? "flex-1" : "flex-1 basis-56",
        className
      )}
      data-testid={testId && `${testId}-range`}
    >
      <Input
        type={type} step={field.type === "time" ? 1 : field.step}
        className={half}
        value={(a as string) ?? ""}
        min={field.min} max={field.max}
        placeholder={t("最小")} disabled={field.disabled}
        aria-label={`${t(field.label)} ${t("最小")}`}
        data-testid={testId && `${testId}-min`}
        onChange={(e) => onChange([parse(e.target.value), b])}
        onKeyDown={submitOnEnter(onSubmit)}
      />
      {/* 分隔号要弱化：它是连接符不是内容，和数字同色会被读成「80-90」一个值。
          弱化只做颜色，字号仍跟着两侧的输入框 */}
      <span className="shrink-0 text-sm text-muted-foreground/60">–</span>
      <Input
        type={type} step={field.type === "time" ? 1 : field.step}
        className={half}
        value={(b as string) ?? ""}
        min={field.min} max={field.max}
        placeholder={t("最大")} disabled={field.disabled}
        aria-label={`${t(field.label)} ${t("最大")}`}
        data-testid={testId && `${testId}-max`}
        onChange={(e) => onChange([a, parse(e.target.value)])}
        onKeyDown={submitOnEnter(onSubmit)}
      />
    </span>
  )
}

/* ------------------------------------------------------------ 多个（属于 / 标签） */

function MultiControl({
  field, value, onChange, onSubmit, size, inline, testId, box, className,
}: SubProps) {
  const { t } = useTranslation()
  const arr = React.useMemo(
    () => (Array.isArray(value) ? value.map((v) => String(v)) : []),
    [value]
  )

  // ⚠️ 这个 useMemo 必须在分支**外面**：写进 if 里就是条件调用 hook，
  // React 会抛 "Should have a queue. You are likely calling Hooks conditionally" 直接白屏
  // （`buildColumns()` 踩过同一条）。
  const options = React.useMemo(
    () => (field.options ?? []).map((o) => ({
      value: String(o.value), label: t(o.label), hint: o.hint, disabled: o.disabled,
    })),
    [field.options, t]
  )

  // 有选项 → 多选下拉；没选项（订单号、手机号这种自由输入）→ 标签输入
  if (field.options || field.type === "multiSelect") {
    return (
      <MultiSelect
        value={arr}
        onValueChange={(v) => onChange(v.length ? v : undefined)}
        options={options}
        placeholder={field.optionsLoading ? t("加载中…") : (field.placeholder ?? t("请选择"))}
        size={size}
        searchable={field.searchable}
        disabled={field.disabled || field.optionsLoading}
        className={cn(box, className)}
        aria-label={t(field.label)}
        data-testid={testId}
      />
    )
  }

  return (
    <TagsInput
      value={arr}
      onChange={(v) => onChange(v.length ? v : undefined)}
      onSubmit={onSubmit}
      placeholder={field.placeholder}
      size={size}
      disabled={field.disabled}
      compact={inline}
      className={cn(box, className)}
      label={t(field.label)}
      testId={testId}
    />
  )
}

/**
 * 标签输入：一串自由值，回车 / 逗号 / 粘贴分隔。
 *
 * 用途是「一次查这几个」—— 订单号、工号、IP。原来只能一个一个查，
 * 或者把逗号串塞进文本框赌后端会 split（用户页的 `username` 就不会）。
 *
 * 粘贴要**自己 split**：从 Excel 复制一列过来是换行分隔的，
 * 不拦的话整列会变成一个巨长的标签。
 *
 * 🔴 **`compact` 不是外观开关，是布局约束。** 在筛选栏的等宽网格里，
 * 标签一多就换行 → 这一格变高 → 那一行的其它格（固定 32px）和它对不齐，
 * 整片网格看起来是坏的。所以 compact 时**不换行**：只铺前两个，其余收成
 * `+n`（悬停能看到全部）。真要逐个删就先 Backspace 弹掉尾部的。
 */
const COMPACT_CHIPS = 2

export function TagsInput({
  value, onChange, onSubmit, placeholder, size = "sm", disabled, compact, className, label, testId,
}: {
  value: readonly string[]
  onChange: (v: string[]) => void
  onSubmit?: () => void
  placeholder?: string
  size?: "sm" | "default"
  disabled?: boolean
  /** 嵌在筛选栏一格里：不换行，多出来的收成 `+n` */
  compact?: boolean
  className?: string
  label?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState("")
  const visible = compact ? value.slice(0, COMPACT_CHIPS) : value
  const rest = value.length - visible.length

  const push = (raw: string) => {
    const parts = raw.split(/[,，\s\n\r\t;；]+/).map((s) => s.trim()).filter(Boolean)
    if (!parts.length) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setDraft("")
  }

  return (
    <div
      data-testid={testId}
      className={cn(
        // 自己那圈边框只在**非 inline** 时需要 —— inline 时 className 里的
        // `border-0` 会把它覆盖掉（同一变体作用域，twMerge 认这个冲突）
        "flex items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-1 text-sm shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        compact ? "flex-nowrap overflow-hidden" : "flex-wrap",
        size === "default" ? "min-h-9" : "min-h-8",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      {visible.map((tag) => (
        <span
          key={tag}
          title={tag}
          className="flex max-w-32 shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs"
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            aria-label={t("移除 {{name}}", { name: tag })}
            disabled={disabled}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onChange(value.filter((v) => v !== tag))}
          >
            <IconX className="size-3" />
          </button>
        </span>
      ))}
      {rest > 0 && (
        <span
          title={value.join(", ")}
          data-testid={testId && `${testId}-rest`}
          className="shrink-0 text-xs text-muted-foreground"
        >
          +{rest}
        </span>
      )}
      <input
        className="min-w-8 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        value={draft}
        disabled={disabled}
        aria-label={label}
        data-testid={testId && `${testId}-input`}
        placeholder={value.length ? "" : (placeholder ?? t("回车分隔多个"))}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text")
          if (!/[,，\s\n;；]/.test(text)) return
          e.preventDefault()
          push(text)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault()
            // 输入框空着时回车 = 搜索（和别的控件一致），有草稿时回车 = 落一个标签
            if (draft.trim()) push(draft)
            else onSubmit?.()
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        // 失焦时把没落地的草稿收进去 —— 打完字直接点「搜索」不该丢掉最后一个
        onBlur={() => draft.trim() && push(draft)}
      />
    </div>
  )
}

/* ------------------------------------------------------------ 单值下拉 */

function SelectControl(props: SubProps) {
  const { field, value, onChange, size, testId, box, className } = props
  const { t } = useTranslation()
  const items = React.useMemo(
    () => [
      { value: ALL, label: t("不限") },
      ...(field.options ?? []).map((o) => ({
        value: String(o.value), label: t(o.label), hint: o.hint, disabled: o.disabled,
      })),
    ],
    [field.options, t]
  )

  // 空值给 null（显示 placeholder），而不是给 ALL —— 否则关闭态永远写着「不限」，
  // placeholder 一次都不会露脸，「请选择」和「不限」看着像两种不同的状态
  const current = value === undefined || value === null || value === "" ? null : String(value)
  const commit = (v: string | null) => onChange(v === ALL || v == null ? undefined : v)
  const placeholder = field.optionsLoading ? t("加载中…") : (field.placeholder ?? t("请选择"))

  const searchable = field.searchable ?? (field.options ?? []).length > SEARCHABLE_FROM

  if (searchable) {
    return (
      <Combobox
        value={current}
        onValueChange={commit}
        options={items}
        size={size}
        disabled={field.disabled || field.optionsLoading}
        className={cn(box, className)}
        placeholder={placeholder}
        searchPlaceholder={t("搜索")}
        emptyText={t("没有匹配项")}
        data-testid={testId}
      />
    )
  }

  return (
    <PlainSelect
      {...props}
      value={current}
      items={items}
      placeholder={placeholder}
      onChange={commit}
    />
  )
}

/**
 * 裸 Select 的薄包装。
 *
 * ⚠️ 高度走 `size` prop，**不能**在 className 里写 `h-8` ——
 * SelectTrigger 的基础类是 `data-[size=default]:h-9`，属性选择器 (0,2,0)
 * 压过纯 `h-8` (0,1,0)，写了也还是 36px（组件约定表里那条，已经踩过三次）。
 */
function PlainSelect({
  value, items, placeholder, onChange, size, testId, field, box, className,
}: Omit<SubProps, "value" | "onChange"> & {
  value: string | null
  items: readonly { value: string; label: string; hint?: string; disabled?: boolean }[]
  placeholder?: string
  onChange: (v: string | null) => void
}) {
  const labels = React.useMemo(
    () => Object.fromEntries(items.map((i) => [i.value, i.label])),
    [items]
  )
  return (
    <Select
      value={value}
      items={labels}
      onValueChange={onChange}
      disabled={field.disabled || field.optionsLoading}
    >
      <SelectTrigger size={size} className={cn(box, className)} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value} disabled={i.disabled}>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className={cn("truncate", i.value === ALL && "text-muted-foreground")}>{i.label}</span>
              {i.hint && (
                <span className="ms-auto shrink-0 font-mono text-[11px] text-muted-foreground">{i.hint}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

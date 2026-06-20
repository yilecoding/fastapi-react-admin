import type * as React from "react"

/**
 * 顶部查询区的类型与运算符。
 *
 * 设计前提：**字段是声明出来的，不是写死在页面里的**。
 * 页面给一份 `FilterField[]`，查询区自己决定「添加条件」能挑什么、
 * 每个字段配哪些运算符、值该用什么控件渲染。加一个筛选字段 = 数组里加一项。
 *
 * ---
 *
 * 🔴 **条件值必须是 JSON 原样往返的（string / number / boolean / 数组）。**
 *
 * 这不是洁癖，是三条路都要求的：
 *
 * | 走哪 | 放 `Date` 会怎样 |
 * |---|---|
 * | URL search params（硬纪律 2） | 只能序列化成 ISO 串，读回来是字符串，schema 一验就炸 |
 * | localStorage（筛选视图） | `JSON.stringify` 出去是串、`JSON.parse` 回来还是串 —— **存进去能用、读回来裂** |
 * | 接口 | `toISOString()` 是 UTC，而后端收的是本地时间串，差 8 小时且没人往时区上想 |
 *
 * 所以时间类字段的值一律是 `'YYYY-MM-DD'` / `'YYYY-MM-DD HH:mm:ss'` **本地时间串**，
 * 区间是 `[起, 止]`，多选是 `string[]`。`select` 的值也一律存**字符串**
 * （选项原本是 number 时，出参阶段再按 `options` 查回去），
 * 这样 `?status=1` 和 `?status="1"` 不会变成两种东西。
 */

export type FieldType =
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "boolean"
  | "date"
  | "dateRange"
  | "dateTime"
  | "dateTimeRange"
  | "time"
  | "tags"
  | "custom"

/** 运算符。名字对齐后端 `sqlalchemy-crud-plus` 的过滤后缀（eq/ne/gt/ge/lt/le/like/in） */
export type Operator =
  | "eq" | "ne"
  | "like" | "notLike"
  | "startsWith" | "endsWith"
  | "gt" | "ge" | "lt" | "le"
  | "in" | "notIn"
  | "between"
  | "isNull" | "notNull"

/** 中文原文即 i18n 的 key，所以渲染处 `t(OPERATOR_LABEL[op])` 就够，常量本身不用动 */
export const OPERATOR_LABEL: Record<Operator, string> = {
  eq: "等于", ne: "不等于",
  like: "包含", notLike: "不包含",
  startsWith: "开头是", endsWith: "结尾是",
  gt: "大于", ge: "大于等于", lt: "小于", le: "小于等于",
  in: "属于", notIn: "不属于",
  between: "介于",
  isNull: "为空", notNull: "不为空",
}

/** 每种字段类型默认能用哪些运算符 —— 页面不指定时按这个给 */
export const TYPE_OPERATORS: Record<FieldType, Operator[]> = {
  text: ["like", "eq", "ne", "notLike", "startsWith", "endsWith", "isNull", "notNull"],
  number: ["eq", "ne", "gt", "ge", "lt", "le", "between", "isNull", "notNull"],
  select: ["eq", "ne", "isNull", "notNull"],
  multiSelect: ["in", "notIn", "isNull", "notNull"],
  boolean: ["eq"],
  date: ["eq", "gt", "ge", "lt", "le", "isNull", "notNull"],
  dateRange: ["between"],
  dateTime: ["ge", "le", "gt", "lt", "eq", "isNull", "notNull"],
  dateTimeRange: ["between"],
  time: ["eq", "ge", "le", "gt", "lt"],
  tags: ["in", "notIn"],
  custom: ["eq"],
}

/** 不需要值的运算符 —— 选了它就不渲染值控件 */
export const VALUELESS: Operator[] = ["isNull", "notNull"]

/** 值是「两端」形态的运算符 */
export const RANGE_OPS: Operator[] = ["between"]

/** 值是「多个」形态的运算符 */
export const MULTI_OPS: Operator[] = ["in", "notIn"]

/** 天然就是区间的字段类型 —— 它们的控件本身管两端，不受运算符影响 */
export const RANGE_TYPES: FieldType[] = ["dateRange", "dateTimeRange"]

export type FilterOption = {
  value: string | number
  label: string
  /** 右侧的弱化补充说明（编号、权限码之类） */
  hint?: string
  disabled?: boolean
}

/** 值控件收到的上下文 —— `field.render` 自定义控件时也是这一份 */
export type FieldControlContext = {
  field: FilterField
  op: Operator
  value: unknown
  onChange: (v: unknown) => void
  /** 回车 = 搜索。自定义控件想接这条就往输入框上挂 */
  onSubmit?: () => void
  invalid?: boolean
  /**
   * 控件被嵌在一个**已经有边框的框里**（基础模式的 `InputGroup`）——
   * 自己那圈边框、阴影、focus ring 都要去掉，否则是「框里套框」。
   *
   * 语义化成布尔量而不是让调用方传一串 `border-0 shadow-none …`：
   * 传字符串的版本漏了两个分支（`dateTimeRange` 的按钮、数字区间里那两个
   * 输入框），而漏掉的表现是「多一圈框」—— 得靠人眼在某个字段上撞见。
   */
  inline?: boolean
  size: "sm" | "default"
  className?: string
  testId?: string
}

export type FilterField = {
  key: string
  label: string
  type: FieldType

  /** 覆盖默认运算符集合 */
  operators?: Operator[]
  defaultOperator?: Operator
  /**
   * 基础模式里也让人挑运算符。**默认关**：
   * 基础模式的价值就是「一排字段一排值」，每格再多一个下拉就退化成高级模式了。
   * 只给真需要的字段开（比如「金额」要能切 > / < / 介于）。
   */
  showOperator?: boolean

  options?: readonly FilterOption[]
  /** 选项还在取（远端字典）—— 控件显示占位而不是「空下拉」 */
  optionsLoading?: boolean
  /** 强制 / 禁用下拉里的搜索框。不给就按选项数量自动（> 8 项才有） */
  searchable?: boolean

  placeholder?: string
  /** 字段名下方 / 下拉里的一句说明 */
  hint?: string
  /** 「添加条件」下拉里的分组名。字段多了必须分组，否则是一长条 */
  group?: string

  /** 基础模式下一进页面就摆出来（不用先「添加条件」） */
  defaultVisible?: boolean
  /** 不允许移除 —— 业务上必须带的那一个（如「所属租户」） */
  locked?: boolean
  disabled?: boolean

  /**
   * 在基础模式的网格里**跨几格**（默认 1）。
   *
   * 不是像素宽度：条件铺在等宽网格上，一格一格来。原来的 `width: 'w-56'`
   * 那种写法让每格宽度 = 标签宽 + 控件固定宽 + 移除按钮位 —— 三个都不一样，
   * 于是十几个条件铺出来**没有两格是一样宽的**（用户截图指出过）。
   * 时间区间那类内容长的给 2。
   */
  span?: 1 | 2

  /* -------- 时间类 -------- */
  /** `date` / `dateRange` 也带上时分秒 */
  withTime?: boolean
  /** 区间控件左侧的快捷区间（今天 / 近 7 天 …），默认开 */
  presets?: boolean

  /* -------- 数字类：校验用 -------- */
  min?: number
  max?: number
  step?: number

  /* -------- 出参映射 -------- */
  /** 出参名，默认用 `key` */
  param?: string
  /** 区间两端的出参名，默认 `${param}_start` / `${param}_end` */
  rangeParams?: readonly [string, string]
  /** 多值出参形态：`csv`（默认，`a,b,c`，URL 里好看）或 `array` */
  multiFormat?: "csv" | "array"
  /**
   * 完全自定义出参 —— 覆盖上面三条。
   * 返回 `undefined` 表示「这一条不出参」。
   */
  toParam?: (value: unknown, op: Operator, field: FilterField) => Record<string, unknown> | undefined

  /** 自定义值控件（`type: 'custom'` 用，也能覆盖内置类型） */
  render?: (ctx: FieldControlContext) => React.ReactNode
}

export type Condition = {
  id: string
  field: string
  op: Operator
  value: unknown
}

export type ConditionGroup = {
  id: string
  logic: "and" | "or"
  children: Array<Condition | ConditionGroup>
}

export type QueryMode = "basic" | "advanced"

export type QueryValue = {
  mode: QueryMode
  /** 基础模式：一串平铺条件，隐含 AND */
  basic: Condition[]
  /** 高级模式：可嵌套的条件树 */
  advanced: ConditionGroup
}

export const isGroup = (n: Condition | ConditionGroup): n is ConditionGroup =>
  Object.prototype.hasOwnProperty.call(n, "children")

let seq = 0
/** 条件 id 只用于 React key 和树里定位，不参与业务 —— 递增就够，不用 uuid */
export const nextId = () => `c${++seq}`

export const emptyGroup = (): ConditionGroup => ({ id: nextId(), logic: "and", children: [] })

/** 这个字段实际可用的运算符 */
export function operatorsOf(field: FilterField): Operator[] {
  const ops = field.operators ?? TYPE_OPERATORS[field.type]
  return ops.length ? ops : ["eq"]
}

export const defaultOperatorOf = (field: FilterField): Operator =>
  field.defaultOperator ?? operatorsOf(field)[0]!

export const newCondition = (field: FilterField): Condition => ({
  id: nextId(),
  field: field.key,
  op: defaultOperatorOf(field),
  value: undefined,
})

export const emptyQuery = (fields: readonly FilterField[]): QueryValue => ({
  mode: "basic",
  basic: fields.filter((f) => f.defaultVisible || f.locked).map(newCondition),
  advanced: emptyGroup(),
})

/**
 * 值的形态由「字段类型 + 运算符」共同决定，三种：
 *
 * - `none` 不吃值（为空 / 不为空）
 * - `range` 两端（介于、天然区间类型）
 * - `multi` 多个（属于 / 不属于、标签）
 * - `single` 单值
 *
 * 控件、校验、出参三处都问这一个函数 —— 不然「界面渲染成多选、
 * 出参当单值发」这种错会各自跑偏（原来 `select` 的默认运算符里就有 `in`，
 * 而控件只有单选下拉，勾「属于」拿到的仍是一个值）。
 */
export type ValueShape = "none" | "single" | "range" | "multi"

export function valueShape(field: FilterField, op: Operator): ValueShape {
  if (VALUELESS.includes(op)) return "none"
  if (RANGE_TYPES.includes(field.type) || RANGE_OPS.includes(op)) return "range"
  if (field.type === "tags" || field.type === "multiSelect" || MULTI_OPS.includes(op)) return "multi"
  return "single"
}

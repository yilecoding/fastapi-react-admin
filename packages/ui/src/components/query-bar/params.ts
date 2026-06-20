/**
 * 出参：查询区的值 → 后端入参 / URL search params / 条件树。
 *
 * 这一层的存在理由：**后端各列表接口收的是平铺入参，不是过滤 DSL。**
 * `GET /sys/users?username=x&status=1&dept=220…`、
 * `GET /log/logins?start_time=…&end_time=…` —— 名字和结构由接口定，
 * 和查询区里的字段 key 不一定一样，一个字段还可能对应两个入参（区间）。
 *
 * 所以映射规则写在字段声明里（`param` / `rangeParams` / `toParam`），
 * 出参函数只负责按规则铺开。页面里手写 `{ start_time: v[0], end_time: v[1] }`
 * 的活儿会在 20 个列表页里各写一遍，然后漂移。
 */

import {
  defaultOperatorOf, isGroup, valueShape,
  type Condition, type ConditionGroup, type FilterField, type Operator, type QueryValue,
} from "./types"
import { hasValue, indexFields } from "./value"

/** 区间两端的默认出参名 */
export const rangeParamNames = (field: FilterField): readonly [string, string] =>
  field.rangeParams ?? [`${field.param ?? field.key}_start`, `${field.param ?? field.key}_end`]

/**
 * 选项值的**原始类型**。
 *
 * 条件里存的一律是字符串（见 types.ts 顶部那段），但后端要的可能是数字
 * （`status=1`，而 `status="1"` 在 pydantic 那边是能过的，在自己写的
 * 前端假数据过滤那边就不一定了）。出参时按 `options` 查回原值 ——
 * 声明里写的是什么类型，发出去就是什么类型。
 */
function rawOption(field: FilterField, v: unknown): unknown {
  if (v === undefined || v === null || v === "") return undefined
  const hit = field.options?.find((o) => String(o.value) === String(v))
  return hit ? hit.value : v
}

const compact = (arr: readonly unknown[]) =>
  arr.filter((v) => v !== undefined && v !== null && v !== "")

/** 多值的出参形态。默认 csv —— `?role=1,2` 比 `?role=["1","2"]` 好读也好写 schema */
function multiOut(field: FilterField, values: readonly unknown[]): unknown {
  const raw = compact(values).map((v) => rawOption(field, v))
  if (raw.length === 0) return undefined
  return (field.multiFormat ?? "csv") === "csv" ? raw.join(",") : raw
}

/**
 * 一条条件 → 出参片段。返回 `{}` 表示这一条不出参。
 *
 * 运算符**默认不带出去** —— 带了后端也不认。要按运算符查得先给后端加过滤语法，
 * 那时用 `toParam` 自己拼（`{ [`${key}__${op}`]: v }`）或者走 `toFilterTree`。
 */
export function conditionParams(cond: Condition, field: FilterField): Record<string, unknown> {
  if (field.toParam) return field.toParam(cond.value, cond.op, field) ?? {}

  const name = field.param ?? field.key
  const shape = valueShape(field, cond.op)

  if (shape === "none") {
    // 「为空 / 不为空」在平铺入参里没有表达方式。想支持就自己给 toParam
    return {}
  }

  if (shape === "range") {
    const [a, b] = Array.isArray(cond.value) ? cond.value : []
    const [ns, ne] = rangeParamNames(field)
    const out: Record<string, unknown> = {}
    if (a !== undefined && a !== null && a !== "") out[ns] = coerce(field, a)
    if (b !== undefined && b !== null && b !== "") out[ne] = coerce(field, b)
    return out
  }

  if (shape === "multi") {
    const v = multiOut(field, Array.isArray(cond.value) ? cond.value : [])
    return v === undefined ? {} : { [name]: v }
  }

  const v = coerce(field, cond.value)
  return v === undefined ? {} : { [name]: v }
}

/** 值 → 出参该有的类型 */
function coerce(field: FilterField, v: unknown): unknown {
  if (v === undefined || v === null || v === "") return undefined
  if (field.type === "number") {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  if (field.type === "select") return rawOption(field, v)
  return v
}

/**
 * 基础模式 → 扁平查询参数（发给后端的那一份）。
 *
 * 高级模式不走这里：`(A 且 B) 或 C` 铺不进平铺入参，硬铺出来会静默变成
 * 「全部 AND」—— 界面上写着「任一满足」，查出来是「全部满足」。
 * 高级模式用 `toFilterTree`，且需要后端支持。
 */
export function toQueryParams(
  value: QueryValue,
  fields: readonly FilterField[]
): Record<string, unknown> {
  const byKey = indexFields(fields)
  const out: Record<string, unknown> = {}
  for (const c of value.basic) {
    const f = byKey.get(c.field)
    if (!f || !hasValue(c, f)) continue
    Object.assign(out, conditionParams(c, f))
  }
  return out
}

/* -------------------------------------------------- URL 侧的编解码 */

/**
 * 🔴 **URL 参数 ≠ 接口入参。** 这两件事必须分开。
 *
 * 一开始它们是同一份（页面把接口参数名直接当 URL 参数名写），代价是地址栏
 * 被接口签名绑死，实测长这样：
 *
 * ```
 * /log/login?start_time=2026-08-16+00%3A00%3A00&end_time=2026-08-22+23%3A59%3A59&page=1
 * ```
 *
 * 74 个字符里没几个是用户选的东西：
 *
 * | 段 | 问题 |
 * |---|---|
 * | `00:00:00` / `23:59:59` | **派生值** —— 用户选的是两个日期，整天边界是必然结果 |
 * | `+` `%3A` | 编码噪音（值里有空格和冒号才会有） |
 * | 两个参数 | 一个「时间范围」被拆成两个 |
 * | `page=1` | 默认值（见 `_shared/pagination.ts`） |
 *
 * 所以 URL 侧另走一套：**一个字段一个参数、按字段 `key` 命名、值压到最短**。
 * 接口那一份仍由 `toQueryParams` 出，名字和精度都不变 ——
 *
 * ```
 * URL     /log/login?time=2026-08-16~2026-08-22
 * 请求    ?start_time=2026-08-16 00:00:00&end_time=2026-08-22 23:59:59
 * ```
 *
 * ⚠️ **补时分秒这一步不能省。** 后端是 `login_time <= end_time`，
 * `end_time=2026-08-22` 会被 pydantic 解析成当天 00:00:00，
 * **静默丢掉 22 号一整天**。所以压缩只发生在 URL 上，
 * 解码时立刻补回规范形式，条件值本身永远是完整的。
 */

/** 整天边界 —— 压缩时去掉、解码时补回 */
const DAY_START = "00:00:00"
const DAY_END = "23:59:59"

const isDateType = (f: FilterField) =>
  f.type === "date" || f.type === "dateRange" || f.type === "dateTime" || f.type === "dateTimeRange"

/** `2026-08-16 00:00:00` → `2026-08-16`；`… 09:30:00` → `2026-08-16T09:30:00` */
function shortenTime(v: string, end: boolean): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(v)
  if (!m) return v
  return m[2] === (end ? DAY_END : DAY_START) ? m[1]! : `${m[1]}T${m[2]}`
}

/** 反过来：`2026-08-16` → `2026-08-16 00:00:00`（或 `23:59:59`） */
function expandTime(v: string, end: boolean, withTime: boolean): string {
  if (!withTime) return v
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} ${end ? DAY_END : DAY_START}`
  return v.replace("T", " ")
}

/** 这个字段的值带不带时分秒 */
const hasTimePart = (f: FilterField) =>
  f.type === "dateTime" || f.type === "dateTimeRange" || Boolean(f.withTime)

/** 区间用 `~` 连接：`a~b` / `a~`（只有下限）/ `~b`（只有上限） */
const RANGE_SEP = "~"
/** 多值用 `,` —— 所以选项 value 里不能有逗号（都是 id / 枚举，实际不会有） */
const MULTI_SEP = ","

function encodeValue(cond: Condition, field: FilterField): string | undefined {
  const shape = valueShape(field, cond.op)
  if (shape === "none") return undefined

  if (shape === "range") {
    const [a, b] = Array.isArray(cond.value) ? cond.value : []
    const one = (v: unknown, end: boolean) => {
      if (v === undefined || v === null || v === "") return ""
      return isDateType(field) ? shortenTime(String(v), end) : String(v)
    }
    const [x, y] = [one(a, false), one(b, true)]
    return x || y ? `${x}${RANGE_SEP}${y}` : undefined
  }

  if (shape === "multi") {
    const arr = (Array.isArray(cond.value) ? cond.value : []).filter(
      (v) => v !== undefined && v !== null && v !== ""
    )
    return arr.length ? arr.map(String).join(MULTI_SEP) : undefined
  }

  const v = cond.value
  return v === undefined || v === null || v === "" ? undefined : String(v)
}

function decodeValue(raw: string, field: FilterField, op: Operator): unknown {
  const shape = valueShape(field, op)
  if (shape === "none") return undefined

  if (shape === "range") {
    const i = raw.indexOf(RANGE_SEP)
    const [x, y] = i < 0 ? [raw, ""] : [raw.slice(0, i), raw.slice(i + 1)]
    const one = (v: string, end: boolean) => {
      if (!v) return undefined
      if (isDateType(field)) return expandTime(v, end, hasTimePart(field))
      return field.type === "number" ? Number(v) : v
    }
    const a = one(x, false)
    const b = one(y, true)
    return a === undefined && b === undefined ? undefined : [a, b]
  }

  if (shape === "multi") {
    const arr = raw.split(MULTI_SEP).map((v) => v.trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }

  if (field.type === "number") {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  if (field.type === "boolean") return raw === "true"
  if (isDateType(field)) return expandTime(raw, false, hasTimePart(field))
  return raw
}

/**
 * 布局记录参数 `f` 里的一项：`key` 或 `key:op`。
 *
 * 它只记**光看值参数还原不出来的那部分**：
 * 摆开了但还没填值的格子（不记就会在刷新后消失），
 * 以及运算符和字段默认值不一样的（`amount:gt`）。
 * 有值又用默认运算符的字段不进 `f` —— 它自己的参数已经说明了一切。
 *
 * 顺序不记：基础模式的条件**一律按字段声明顺序**渲染（见 `sortByFields`），
 * 所以「我把某一格加在了哪个位置」这件事不需要持久化，
 * 而且每个筛选项的位置在页面上是固定的，扫起来更快。
 */
export const LAYOUT_PARAM = "f"

/** 整份查询（高级模式的条件树）—— 平铺参数表达不了嵌套的 AND/OR */
export const TREE_PARAM = "q"

/**
 * 查询值 → URL search params。
 *
 * 出来的全是标量字符串，键是**字段 key**（不是接口入参名）。
 */
export function toUrlParams(
  value: QueryValue,
  fields: readonly FilterField[]
): Record<string, string | undefined> {
  const byKey = indexFields(fields)
  const out: Record<string, string | undefined> = {}

  if (value.mode === "advanced") {
    out[TREE_PARAM] = packQuery(value)
    return out
  }

  const layout: string[] = []
  for (const c of value.basic) {
    const f = byKey.get(c.field)
    if (!f) continue
    const encoded = encodeValue(c, f)
    if (encoded !== undefined) out[f.key] = encoded
    // 默认运算符 + 有值 → 不用记；否则得留个痕
    if (encoded === undefined || c.op !== defaultOperatorOf(f)) {
      layout.push(c.op === defaultOperatorOf(f) ? f.key : `${f.key}:${c.op}`)
    }
  }
  out[LAYOUT_PARAM] = layout.length ? layout.join(MULTI_SEP) : undefined
  return out
}

/**
 * URL search params → 查询值。
 *
 * 未知字段一律忽略（字段声明改过、老链接还带着旧 key），
 * 所以**不用**再单独跑一次 `pruneUnknown`。
 */
export function fromUrlParams(
  search: Record<string, unknown>,
  fields: readonly FilterField[],
  nextId: () => string
): QueryValue {
  const tree = search[TREE_PARAM]
  if (typeof tree === "string" && tree) {
    return unpackQuery(tree, fields, nextId) ?? { mode: "advanced", basic: [], advanced: { id: nextId(), logic: "and", children: [] } }
  }

  /** `f` 里记的运算符覆盖 */
  const ops = new Map<string, Operator>()
  const listed = new Set<string>()
  const rawLayout = search[LAYOUT_PARAM]
  if (typeof rawLayout === "string") {
    for (const item of rawLayout.split(MULTI_SEP)) {
      const [key, op] = item.split(":")
      if (!key) continue
      listed.add(key)
      if (op) ops.set(key, op as Operator)
    }
  }

  const basic: Condition[] = []
  // 按**声明顺序**遍历，不按 URL 里出现的顺序 —— 位置固定，刷新前后一致
  for (const f of fields) {
    const raw = search[f.key]
    const present = raw !== undefined && raw !== null && raw !== ""
    if (!present && !listed.has(f.key)) continue
    const op = ops.get(f.key) ?? defaultOperatorOf(f)
    basic.push({
      id: nextId(),
      field: f.key,
      op,
      value: present ? decodeValue(String(raw), f, op) : undefined,
    })
  }

  return { mode: "basic", basic, advanced: { id: nextId(), logic: "and", children: [] } }
}

/** URL 里由查询区管的那些键 —— 页面写回时要先把它们全清掉，否则去掉的条件会留在地址栏 */
export function urlParamKeys(fields: readonly FilterField[]): string[] {
  return [...fields.map((f) => f.key), LAYOUT_PARAM, TREE_PARAM]
}

/** 高级模式 → 条件树（原样给后端／自己翻译成 SQL 的场合用），已剪掉空条件与空分组 */
export function toFilterTree(value: QueryValue, fields?: readonly FilterField[]): ConditionGroup {
  const byKey = fields ? indexFields(fields) : undefined
  const prune = (g: ConditionGroup): ConditionGroup => ({
    ...g,
    children: g.children
      .map((n) => (isGroup(n) ? prune(n) : n))
      .filter((n) => (isGroup(n) ? n.children.length > 0 : hasValue(n, byKey?.get(n.field)))),
  })
  return prune(value.advanced)
}

/* -------------------------------------------------- URL 里放整份查询 */

/**
 * 整份查询 ↔ 一个字符串。
 *
 * 平铺出参（`toSearchParams`）够用的是**基础模式**：一个字段一个入参，
 * 地址栏可读、也能手改。但两种情况它表达不了，必须整份存：
 *
 * - **高级模式的条件树**（嵌套 + AND/OR）
 * - **基础模式里「摆了哪几格」** —— 用户从「添加条件」挑出来的字段，
 *   值为空时不出参，刷新后那一格就消失了（挑过的东西自己跑掉，很惹人烦）
 *
 * 形态刻意压得很短（`m` / `b` / `a`、条件是三元组），因为它要进地址栏。
 * 恢复时**一定要过 `pruneUnknown`**：字段声明是代码里的，老链接会带着已删的 key。
 */
type PackedCondition = [field: string, op: Operator, value?: unknown]
type PackedGroup = { l: "and" | "or"; c: Array<PackedCondition | PackedGroup> }
type Packed = { m?: "a"; b?: PackedCondition[]; a?: PackedGroup }

const packCond = (c: Condition): PackedCondition =>
  c.value === undefined ? [c.field, c.op] : [c.field, c.op, c.value]

const packGroup = (g: ConditionGroup): PackedGroup => ({
  l: g.logic,
  c: g.children.map((n) => (isGroup(n) ? packGroup(n) : packCond(n))),
})

export function packQuery(value: QueryValue): string | undefined {
  const out: Packed = {}
  if (value.mode === "advanced") out.m = "a"
  if (value.basic.length) out.b = value.basic.map(packCond)
  if (value.advanced.children.length) out.a = packGroup(value.advanced)
  // 空查询不该往 URL 里留一个 `q={}`
  return Object.keys(out).length ? JSON.stringify(out) : undefined
}

export function unpackQuery(
  raw: string | undefined | null,
  fields: readonly FilterField[],
  nextId: () => string
): QueryValue | undefined {
  if (!raw) return undefined
  let p: Packed
  try {
    p = JSON.parse(raw) as Packed
  } catch {
    // 脏 URL（手改坏了、老格式）不该白屏，当没传处理
    return undefined
  }
  if (!p || typeof p !== "object") return undefined

  const known = new Set(fields.map((f) => f.key))
  const cond = (c: PackedCondition): Condition | undefined =>
    Array.isArray(c) && known.has(c[0])
      ? { id: nextId(), field: c[0], op: c[1], value: c[2] }
      : undefined

  const group = (g: PackedGroup): ConditionGroup => ({
    id: nextId(),
    logic: g?.l === "or" ? "or" : "and",
    children: (Array.isArray(g?.c) ? g.c : [])
      .map((n) => (Array.isArray(n) ? cond(n) : group(n as PackedGroup)))
      .filter((n): n is Condition | ConditionGroup => n !== undefined),
  })

  return {
    mode: p.m === "a" ? "advanced" : "basic",
    basic: (p.b ?? []).map(cond).filter((c): c is Condition => c !== undefined),
    advanced: p.a ? group(p.a) : { id: nextId(), logic: "and", children: [] },
  }
}

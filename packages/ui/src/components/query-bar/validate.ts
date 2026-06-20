/**
 * 条件校验。
 *
 * 🔴 **校验不是锦上添花。** 查询区最常见的两种废操作：
 *
 * - 「介于 100 和 10」—— 后端老实照办，返回 0 行，用户以为「没数据」
 * - 「起 2026-08-22 止 2026-08-01」—— 同上，而且日历上看不出来反了
 *
 * 两种都不会报错，只会给一个**看起来正常的空列表**。所以查得出来的错要在
 * 点搜索之前拦住，并且**指到具体那一格**（红边框 + 一句话），
 * 而不是只在顶上写一句「条件有误」让人自己找。
 *
 * 校验只覆盖「能纯前端判定」的：两端反了、超出声明的 min/max、
 * 多选一个都没勾却又不是空条件。业务规则（比如「时间跨度不能超过 90 天」）
 * 由调用方通过 `extraValidate` 补。
 */

import {
  valueShape,
  type Condition, type ConditionGroup, type FilterField, type QueryValue,
} from "./types"
import { isGroup } from "./types"
import { indexFields } from "./value"

/**
 * 一条错误。**存结构化数据而不是拼好的字符串** —— 在这里 `t()` 出来的句子会
 * 停在当时的语言上，会话内切语言之后那一格的红字还是旧语言的
 * （富文本上传提示踩过同一个坑）。key 是中文原文，插值留给渲染处。
 */
export type QueryError = { key: string; vars?: Record<string, unknown> }

/** key 是条件 id */
export type QueryErrors = Record<string, QueryError>

export type ValidateContext = {
  cond: Condition
  field: FilterField
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** 时间串按字典序比大小是对的 —— `'YYYY-MM-DD HH:mm:ss'` 定长且高位在前 */
const bothFilled = (a: unknown, b: unknown) =>
  a !== undefined && a !== null && a !== "" && b !== undefined && b !== null && b !== ""

export function validateCondition(
  cond: Condition,
  field: FilterField,
  extra?: (ctx: ValidateContext) => QueryError | undefined
): QueryError | undefined {
  const shape = valueShape(field, cond.op)

  if (shape === "range") {
    const [a, b] = Array.isArray(cond.value) ? cond.value : []
    if (bothFilled(a, b)) {
      if (field.type === "number") {
        const [x, y] = [num(a), num(b)]
        if (x !== undefined && y !== undefined && x > y) return { key: "最小值不能大于最大值" }
      } else if (String(a) > String(b)) {
        return { key: "开始不能晚于结束" }
      }
    }
    if (field.type === "number") {
      for (const v of [a, b]) {
        const msg = rangeBound(num(v), field)
        if (msg) return msg
      }
    }
  }

  if (shape === "single" && field.type === "number") {
    const msg = rangeBound(num(cond.value), field)
    if (msg) return msg
  }

  return extra?.({ cond, field })
}

function rangeBound(v: number | undefined, field: FilterField): QueryError | undefined {
  if (v === undefined) return undefined
  if (field.min !== undefined && v < field.min) return { key: "不能小于 {{n}}", vars: { n: field.min } }
  if (field.max !== undefined && v > field.max) return { key: "不能大于 {{n}}", vars: { n: field.max } }
  return undefined
}

/**
 * 整份查询的校验结果。
 *
 * 只校验**当前模式**那一支：高级模式下基础模式的条件还留着（切回去要在），
 * 但它们不参与本次查询，报错会变成「顶上说有错、界面上找不到红框」。
 */
export function validateQuery(
  value: QueryValue,
  fields: readonly FilterField[],
  extra?: (ctx: ValidateContext) => QueryError | undefined
): QueryErrors {
  const byKey = indexFields(fields)
  const out: QueryErrors = {}

  const one = (c: Condition) => {
    const f = byKey.get(c.field)
    if (!f) return
    const msg = validateCondition(c, f, extra)
    if (msg) out[c.id] = msg
  }

  if (value.mode === "basic") {
    value.basic.forEach(one)
  } else {
    const walk = (g: ConditionGroup) => {
      for (const c of g.children) {
        if (isGroup(c)) walk(c)
        else one(c)
      }
    }
    walk(value.advanced)
  }
  return out
}

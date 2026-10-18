/**
 * 表单联动（显示条件 / 自动计算）—— 后端 `engine/form.py: form_rules` 的副本。纯函数，不 import React。
 *
 * 🔴 **只为「填的时候当场看到」**：天数跟着日期区间变、选了病假才出现「病假证明」。
 * 存什么、校验什么、走哪条分支，全按服务端那一份算（提交的天数服务端不收，自己重算）。
 * 改规则时两边一起改；对不上的表现是「界面上显示 5 天，提交后变成 4 天」。
 */
import type { Calc, Cond, FormData, FormField, FormSchema } from './api'

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/**
 * 数字按**十进制字符串**精确比，和后端 `Decimal` 同口径。
 *
 * 🔴 不能 `Number()`：人员 / 部门字段的值是雪花 ID 字符串（约 2^61），转成 double 会被舍入 ——
 * `4000000000000000005` 和 `…006` 变成同一个数，「部门不属于 X」在前端成立、在后端不成立：
 * 前端把字段藏了，后端说它必填，提交被一个看不见的字段挡住（硬纪律 6）
 */
type Dec = { neg: boolean; int: string; frac: string }

const DEC_RE = /^\s*([+-]?)(\d+)(?:\.(\d+))?\s*$/

export function toDec(v: unknown): Dec | null {
  if (typeof v === 'boolean' || v === null || v === undefined) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    // 表单里的数字字段是 JSON 数字，量级不大；toString 出科学计数法（1e21+）的当不是数字
    return toDec(String(v))
  }
  if (typeof v !== 'string') return null
  const m = DEC_RE.exec(v)
  if (!m) return null
  const int = m[2].replace(/^0+(?=\d)/, '')
  const frac = (m[3] ?? '').replace(/0+$/, '')
  return { neg: m[1] === '-' && (int !== '0' || frac !== ''), int, frac }
}

function cmpDec(a: Dec, b: Dec): number {
  if (a.neg !== b.neg) return a.neg ? -1 : 1
  const sign = a.neg ? -1 : 1
  if (a.int.length !== b.int.length) return (a.int.length < b.int.length ? -1 : 1) * sign
  if (a.int !== b.int) return (a.int < b.int ? -1 : 1) * sign
  const len = Math.max(a.frac.length, b.frac.length)
  const fa = a.frac.padEnd(len, '0')
  const fb = b.frac.padEnd(len, '0')
  return fa === fb ? 0 : (fa < fb ? -1 : 1) * sign
}

/** 等值：两边都是数字就按数值比（'1.0' == 1），否则原样比；一边数字一边不是 → 不等（同后端） */
function same(x: unknown, y: unknown): boolean {
  const a = toDec(x)
  const b = toDec(y)
  if (a && b) return cmpDec(a, b) === 0
  if (a || b) return false
  return x === y
}

/** 条件求值（`engine/flow.py: evaluate`）。取不到的变量当 None：除了 empty 之外都不成立 */
export function evaluate(cond: Cond | null | undefined, vars: FormData): boolean {
  if (!cond) return true
  if ('all' in cond && cond.all) return cond.all.every((c) => evaluate(c, vars))
  if ('any' in cond && cond.any) return cond.any.some((c) => evaluate(c, vars))
  if (!('var' in cond)) return true
  const left = vars[cond.var]
  const right = cond.value
  if (cond.op === 'empty') return isEmpty(left)
  if (cond.op === 'not_empty') return !isEmpty(left)
  if (left === undefined || left === null || left === '') return false
  switch (cond.op) {
    case 'eq':
      return same(left, right)
    case 'ne':
      return !same(left, right)
    case 'in':
    case 'not_in': {
      const pool = Array.isArray(right) ? right : [right]
      const lefts = Array.isArray(left) ? left : [left]
      const hit = lefts.some((x) => pool.some((y) => same(x, y)))
      return cond.op === 'in' ? hit : !hit
    }
    case 'contains':
      return Array.isArray(left) && left.map(String).includes(String(right))
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // 都是数字按数值；都不是数字（日期串 YYYY-MM-DD）按字典序；一边一种 → 不成立（同后端）
      const a = toDec(left)
      const b = toDec(right)
      let c: number
      if (a && b) c = cmpDec(a, b)
      else if (!a && !b && typeof left === 'string' && typeof right === 'string') c = left < right ? -1 : left > right ? 1 : 0
      else return false
      return cond.op === 'gt' ? c > 0 : cond.op === 'gte' ? c >= 0 : cond.op === 'lt' ? c < 0 : c <= 0
    }
    default:
      return false
  }
}

const DAY_MS = 86_400_000

function days(range: unknown): number | null {
  if (!Array.isArray(range) || range.length !== 2) return null
  const [a, b] = range.map((s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN))
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return Math.round((b - a) / DAY_MS) + 1
}

/** 金额按 10^6 放大成 BigInt 求和 —— 浮点加法会把 0.1 + 0.2 加成 0.30000000000000004 */
const SCALE = 6

function toScaled(v: unknown): bigint | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[2] === '' && !m[3])) return null
  const frac = (m[3] ?? '').slice(0, SCALE).padEnd(SCALE, '0')
  const n = BigInt(`${m[2] || '0'}${frac}`)
  return m[1] ? -n : n
}

function fromScaled(n: bigint, precision: number): string {
  // 四舍六入五成双（和 Python Decimal.quantize 的默认 ROUND_HALF_EVEN 一致）
  const div = 10n ** BigInt(SCALE - precision)
  const neg = n < 0n
  const abs = neg ? -n : n
  let q = abs / div
  const r = abs % div
  if (r * 2n > div || (r * 2n === div && q % 2n === 1n)) q += 1n
  const str = q.toString().padStart(precision + 1, '0')
  const int = precision ? str.slice(0, -precision) : str
  const out = precision ? `${int}.${str.slice(-precision)}` : int
  return neg && q !== 0n ? `-${out}` : out
}

function compute(f: FormField, calc: Calc, data: FormData): unknown {
  const src = data[calc.field]
  if (calc.kind === 'days') return days(src)
  if (!Array.isArray(src) || src.length === 0) return null
  let total = 0n
  for (const row of src) {
    const v = row && typeof row === 'object' ? (row as Record<string, unknown>)[calc.column] : undefined
    if (isEmpty(v) || typeof v === 'boolean') continue
    const n = toScaled(v)
    if (n === null) return null
    total += n
  }
  if (f.type === 'amount') return fromScaled(total, f.precision ?? 2)
  return Number(fromScaled(total, SCALE))
}

/** 按字段顺序算一遍：返回算过之后的数据，和不显示的字段 */
export function formRules(schema: FormSchema, data: FormData): { data: FormData; inactive: Set<string> } {
  const out: FormData = { ...data }
  const inactive = new Set<string>()
  for (const f of schema.fields) {
    if (f.visibleWhen && !evaluate(f.visibleWhen, out)) {
      delete out[f.id]
      inactive.add(f.id)
      continue
    }
    if (f.calc) {
      const v = compute(f, f.calc, out)
      if (v === null || v === undefined) delete out[f.id]
      else out[f.id] = v
    }
  }
  return { data: out, inactive }
}

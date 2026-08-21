/**
 * 条件值的判定与迁移。
 *
 * 三个函数都只依赖 `valueShape`（字段类型 + 运算符 → 值形态），
 * 所以「控件长什么样」「算不算填了」「换运算符时留不留值」永远是一致的答案。
 */

import {
  defaultOperatorOf, isGroup, valueShape,
  type Condition, type ConditionGroup, type FilterField, type Operator,
  type QueryValue, type ValueShape,
} from "./types"

/** 单个标量算不算「填了」。空串 / undefined / null 都算没填；`false` 和 `0` 算填了 */
const filled = (v: unknown): boolean => v !== undefined && v !== null && v !== ""

/**
 * 条件是否算「填了东西」—— 空条件不该参与查询，也不该让重置按钮亮起来。
 *
 * 区间刻意**只要一端就算**：「≥ 100」是个正当的筛选，逼人把上限也填上才生效
 * 是把控件形态（两个框）当成了业务约束。
 */
export function hasValue(cond: Condition, field?: FilterField): boolean {
  const shape: ValueShape = field ? valueShape(field, cond.op) : guessShape(cond)
  if (shape === "none") return true
  const v = cond.value
  if (shape === "range" || shape === "multi") {
    return Array.isArray(v) && v.some(filled)
  }
  return filled(v)
}

/** 拿不到字段声明时（脏 URL、字段已被删）按值的形状猜一下，只用于计数 */
function guessShape(cond: Condition): ValueShape {
  if (cond.op === "isNull" || cond.op === "notNull") return "none"
  return Array.isArray(cond.value) ? "multi" : "single"
}

export type FieldMap = ReadonlyMap<string, FilterField>

export const indexFields = (fields: readonly FilterField[]): FieldMap =>
  new Map(fields.map((f) => [f.key, f]))

/** 当前这套查询里有几条真正生效的条件 */
export function countActive(value: QueryValue, fields?: readonly FilterField[]): number {
  const byKey = fields ? indexFields(fields) : undefined
  const one = (c: Condition) => (hasValue(c, byKey?.get(c.field)) ? 1 : 0)
  if (value.mode === "basic") return value.basic.reduce((n, c) => n + one(c), 0)
  const walk = (g: ConditionGroup): number =>
    g.children.reduce((n, c) => n + (isGroup(c) ? walk(c) : one(c)), 0)
  return walk(value.advanced)
}

/**
 * 换运算符 / 换字段时把值迁过去，**能留就留**。
 *
 * 「包含 张」切成「等于」应该还是「张」—— 把值清掉是最惹人烦的那种贴心：
 * 用户只是想换个匹配方式，不是想重新输一遍。只有**形态真的变了**才动值：
 *
 * | 变化 | 处理 |
 * |---|---|
 * | 单值 → 两端 | `x` → `[x, undefined]`（下限就是它） |
 * | 两端 → 单值 | `[a, b]` → `a` |
 * | 单值 → 多个 | `x` → `[x]` |
 * | 多个 → 单值 | `[a, b]` → `a`（多余的丢掉，不能既是单值又是数组） |
 * | → 不吃值 | 清掉（`为空` 带着旧值会在切回来时诈尸） |
 */
export function migrateValue(
  value: unknown,
  from: ValueShape,
  to: ValueShape
): unknown {
  if (to === "none") return undefined
  if (from === to) return value
  const arr = Array.isArray(value) ? value : undefined

  if (to === "range") {
    if (arr) return [arr[0], arr[1]]
    return filled(value) ? [value, undefined] : undefined
  }
  if (to === "multi") {
    if (arr) return arr.filter(filled)
    return filled(value) ? [value] : undefined
  }
  // to === 'single'
  if (arr) return arr.find(filled)
  return value
}

/** 换运算符 */
export function withOperator(cond: Condition, field: FilterField, op: Operator): Condition {
  return {
    ...cond,
    op,
    value: migrateValue(cond.value, valueShape(field, cond.op), valueShape(field, op)),
  }
}

/**
 * 换字段。
 *
 * 和换运算符不同，这里**一律清值**：上一个字段的「介于 3 和 5」搬到
 * 「姓名」上是废的，而「张三」搬到「状态」上会变成一个不在选项里的值 ——
 * 下拉显示空白、出参却带着它，是最难查的那种。
 */
export function withField(cond: Condition, next: FilterField): Condition {
  return { ...cond, field: next.key, op: defaultOperatorOf(next), value: undefined }
}

/**
 * 把一份查询里「字段已经不存在」的条件剔掉。
 *
 * 从 URL / localStorage 恢复时必跑一次：字段声明是代码里的，改了名或删了字段之后
 * 老链接还带着旧 key —— 留着的表现是「界面上少一格、出参里多一个后端不认的参数」。
 */
export function pruneUnknown(value: QueryValue, fields: readonly FilterField[]): QueryValue {
  const known = new Set(fields.map((f) => f.key))
  const walk = (g: ConditionGroup): ConditionGroup => ({
    ...g,
    children: g.children
      .map((c) => (isGroup(c) ? walk(c) : c))
      .filter((c) => (isGroup(c) ? true : known.has(c.field))),
  })
  return {
    ...value,
    basic: value.basic.filter((c) => known.has(c.field)),
    advanced: walk(value.advanced),
  }
}

import { ApiError } from '@admin/api'

/**
 * 把一次 **422** 拆成「哪个字段错了」+「一句通用的」。
 *
 * 表单只有一条通用错误的时候，用户得自己猜是哪一格填坏了 —— 三个输入框以上
 * 就基本靠试。这份是移动端表单的那一半。
 *
 * ## 🔴 **字段级信息只在后端 `ENVIRONMENT == 'dev'` 时才有**
 *
 * 这不是客户端能补的。读 `common/exception/exception_handler.py` 的
 * `_validation_exception_handler`：
 *
 * | | dev | 非 dev（生产） |
 * |---|---|---|
 * | 信封 `data` | `{'errors': [...]}`（pydantic 原始错误，**带 `loc`**） | **`None`** |
 * | 信封 `msg` | `f'{field} {error_msg}…'`（**带字段名**） | 只有 `error_msg` |
 *
 * 所以这个函数在生产环境下**必然只返回 `general`**，`fields` 是空的。
 * ⚠️ **不要因此把界面写成「只显示字段错误」** —— 那样生产上会变成
 * 「保存失败了，但屏上什么都没说」。调用方必须两个都渲染：
 * 有字段错就贴到那一格，`general` 始终显示。
 *
 * 真正的修法在后端（生产也下发 `loc`，或至少把字段名留在 `msg` 里），
 * 那是另一件事 —— 但**在它修好之前这个函数就已经是对的**，因为它的降级路径
 * 就是生产路径。
 *
 * ## `loc` 的形状
 *
 * pydantic 给的是路径数组：`['body', 'avatar']`、`['query', 'page']`、
 * 嵌套的还有 `['body', 'items', 0, 'name']`。取**最后一个字符串段**当字段名 ——
 * 数组下标（number）要跳过，否则字段名会变成 `0`。
 */
export type FieldErrors = Record<string, string>

export type ParsedError = {
  /** 字段名 → 该字段的第一条错误。生产环境下必然是空对象，见上 */
  fields: FieldErrors
  /** 总是有值（除非传进来的不是错误）。屏上必须显示它 */
  general: string | null
}

type PydanticError = { loc?: unknown; msg?: unknown }

export function parseFieldErrors(err: unknown): ParsedError {
  const general = err instanceof Error ? err.message : err === null || err === undefined ? null : String(err)
  const fields: FieldErrors = {}

  // 只有 422 才谈字段；其它错误（403 / 500 / 网络）没有字段这回事
  if (!(err instanceof ApiError) || !err.isValidation) return { fields, general }

  const detail = err.detail
  if (typeof detail !== 'object' || detail === null || !('errors' in detail)) return { fields, general }
  const list = (detail as { errors: unknown }).errors
  if (!Array.isArray(list)) return { fields, general }

  for (const raw of list as PydanticError[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const loc = Array.isArray(raw.loc) ? raw.loc : []
    // 从后往前找第一个字符串段：跳过数组下标
    const name = [...loc].reverse().find((seg): seg is string => typeof seg === 'string')
    // ⚠️ `body` / `query` 本身不是字段名（一层结构的错误 loc 就是 `['body']`），
    // 那种只能靠 general 表达
    if (!name || name === 'body' || name === 'query' || name === 'path') continue
    const msg = typeof raw.msg === 'string' ? raw.msg : ''
    // 一格只留第一条 —— 同一个字段的第二条通常是同一个问题的另一种说法
    if (msg && !(name in fields)) fields[name] = msg
  }

  return { fields, general }
}

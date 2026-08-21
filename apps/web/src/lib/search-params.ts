import { parseSearchWith } from "@tanstack/react-router"

/**
 * URL search 参数的解析 / 序列化。
 *
 * TanStack Router 默认对**每个值**跑 `JSON.parse` / `JSON.stringify`。
 * 对雪花 ID 这是致命的：
 *
 * ```
 * JSON.parse("2202097973238829056") === 2202097973238829000   // ← 少了 56
 * ```
 *
 * 结果是 `?role=2202097973238829056` 静默指向**另一条记录**（实测：详情面板
 * 显示的是列表第一个角色，而权限保存会写到那一个上）。这与 CLAUDE.md 硬纪律 6
 * 「所有 ID 都是 string，永远不要 Number() 它」是同一件事，只是发生在路由层
 * —— 业务代码再小心也挡不住。
 *
 * 默认行为还有个副作用：字符串值一律被 JSON.stringify 加引号，
 * 地址栏里出现 `?role="2202..."`、`?username="admin"`，复制粘贴很难看。
 *
 * 这里的策略：
 *
 * - **解析**：纯整数且超出 `Number.MAX_SAFE_INTEGER` 时**保持字符串**，
 *   绝不交给 JSON.parse；其余照旧。
 * - **序列化**：字符串默认**不加引号**，只有「不加引号会被解析成别的类型」时
 *   才加（`"123"` → `"123"` 否则回来变成 number 123，`z.string()` 会炸；
 *   `"true"` / `"null"` 同理）。判据就是拿 `parseValue` 跑一遍看能不能原样回来，
 *   所以两个方向天然自洽，不会出现「写出去的读不回来」。
 */

const UNSAFE_INT = /^-?\d+$/

function parseValue(raw: string): unknown {
  // 雪花 ID 走这里：超出安全整数范围的纯整数一律当字符串
  if (UNSAFE_INT.test(raw) && !Number.isSafeInteger(Number(raw))) return raw
  try {
    return JSON.parse(raw)
  } catch {
    // 不是合法 JSON（普通文本、'YYYY-MM-DD HH:mm:ss' 之类）→ 原样返回
    return raw
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value)
  // 能原样解析回来就裸写，否则加引号保类型
  return parseValue(value) === value ? value : JSON.stringify(value)
}

export const parseSearch = parseSearchWith(parseValue)

/**
 * 地址栏里**不必编码的字符就别编码**。
 *
 * TanStack 内部走的是 `URLSearchParams.toString()`（`qss.js` 里写死的），
 * 它按 `application/x-www-form-urlencoded` 序列化 —— 冒号变 `%3A`、逗号变
 * `%2C`、波浪号变 `%7E`。而 RFC 3986 里这几个在 query 段**本来就是合法的**，
 * 编码只是让人读不懂：
 *
 * ```
 * ?t=2026-08-16T09%3A00%3A00~2026-08-22T18%3A30%3A00   ← 编码后
 * ?t=2026-08-16T09:00:00~2026-08-22T18:30:00           ← 同一个东西
 * ```
 *
 * 所以自己拼一遍：`encodeURIComponent` 之后把这几个还原。`&` `=` `#` `%` `+`
 * 仍然编码（它们是真的分隔符），空格也仍然编码 —— 值里不该有空格，
 * 有的话让它显形成 `%20` 反而是提醒。
 *
 * 解析方向不用改：`URLSearchParams` 认得裸的 `:` `,` `~` `/`。
 */
const KEEP_RAW: Array<[RegExp, string]> = [
  [/%3A/gi, ":"],
  [/%2C/gi, ","],
  [/%7E/gi, "~"],
  [/%2F/gi, "/"],
]

const pretty = (raw: string) => KEEP_RAW.reduce((acc, [re, ch]) => acc.replace(re, ch), raw)

export const stringifySearch = (search: Record<string, unknown>): string => {
  const parts: string[] = []
  for (const key of Object.keys(search)) {
    const value = search[key]
    if (value === undefined) continue
    parts.push(`${pretty(encodeURIComponent(key))}=${pretty(encodeURIComponent(stringifyValue(value)))}`)
  }
  return parts.length ? `?${parts.join("&")}` : ""
}

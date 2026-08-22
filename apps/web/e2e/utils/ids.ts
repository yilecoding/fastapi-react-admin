/**
 * 生成测试用的唯一编码，避免并行/重复跑的测试互相踩数据。
 *
 * 符合 `CustomCode` 的规则（`^[A-Z][A-Z0-9_]*$`，2~32 位）——36 进制时间戳里的字母
 * 会被 `.toUpperCase()`，数字不受影响，拼出来的整串仍然只含大写字母/数字/下划线。
 */
export function uniqueCode(prefix: string): string {
  const time = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}_${time}${rand}`
}

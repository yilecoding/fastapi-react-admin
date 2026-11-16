/** 菜单和系统浏览器只接受完整的 HTTP(S) 地址。 */
export function httpUrl(raw: string): string | null {
  const value = raw.trim()
  const lower = value.toLowerCase()
  const prefix = lower.startsWith("https://")
    ? 8
    : lower.startsWith("http://")
      ? 7
      : 0
  if (!prefix || !value[prefix] || value[prefix] === "/") return null
  if (
    [...value].some(
      (char) =>
        char.charCodeAt(0) <= 32 ||
        char.charCodeAt(0) === 127 ||
        char.charCodeAt(0) === 92
    )
  )
    return null
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname
      ? url.href
      : null
  } catch {
    return null
  }
}

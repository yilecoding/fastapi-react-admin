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

/** 桌面外开只额外允许邮件链接；tel: 和其它系统协议仍交给白名单拒绝。 */
export function externalUrl(raw: string): string | null {
  const url = httpUrl(raw)
  if (url) return url

  const value = raw.trim()
  if (!value.toLowerCase().startsWith("mailto:") || value.length === 7)
    return null
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
    const parsed = new URL(value)
    return parsed.protocol === "mailto:" && parsed.pathname ? parsed.href : null
  } catch {
    return null
  }
}

/** 内嵌菜单可用同源根相对路径；拒绝协议相对地址和路径分隔符混淆。 */
export function embeddedUrl(raw: string): string | null {
  const value = raw.trim()
  if (httpUrl(value)) return value
  if (!value.startsWith("/") || value.startsWith("//")) return null
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
    const url = new URL(value, "https://embedded.invalid")
    return url.origin === "https://embedded.invalid" ? value : null
  } catch {
    return null
  }
}

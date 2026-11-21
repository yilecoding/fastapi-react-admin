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

/**
 * 桌面端的服务器地址（`config.serverUrl`，#392）：规范化成**末尾不带斜杠**的基址，不合格返回 null。
 *
 * 比 `httpUrl` 多挡三样：查询串、片段、账号密码。渲染层按 `${API_BASE}${path}` 拼请求，
 * `https://h/?env=prod` 会拼成 `https://h/?env=prod/api/v1/...`（打到站点根、拿回 HTML）；
 * 带 `user:pass@` 的地址 Chromium 的 fetch 直接拒绝构造请求。路径前缀（反代子路径）保留。
 */
export function serverBaseUrl(raw: string): string | null {
  const href = httpUrl(raw)
  if (!href) return null
  const url = new URL(href)
  if (url.search || url.hash || url.username || url.password) return null
  // `new URL('https://h/?').search` 是空串，但 href 里留着 `?`：按原文再挡一次
  if (/[?#]/.test(raw)) return null
  return href.replace(/\/+$/, "")
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
    if (
      parsed.protocol !== "mailto:" ||
      !parsed.pathname ||
      parsed.host ||
      parsed.hash
    )
      return null
    const recipient = decodeURIComponent(parsed.pathname)
    if (
      recipient.startsWith("/") ||
      [...recipient].some(
        (char) =>
          char.charCodeAt(0) <= 32 ||
          char.charCodeAt(0) === 127 ||
          char === "\\"
      )
    )
      return null
    // 系统邮件客户端可能将 attach 等扩展字段解释为本地/网络附件。
    // 按解码后的字段名检查；正文允许换行，邮件头禁止 CR/LF 注入。
    for (const [name, content] of parsed.searchParams) {
      const field = name.toLowerCase()
      if (!["subject", "body", "cc", "bcc"].includes(field)) return null
      if (
        [...content].some((char) => {
          const code = char.charCodeAt(0)
          return code === 127 || (code < 32 && ![9, 10, 13].includes(code))
        })
      )
        return null
      if (field !== "body" && /[\r\n]/.test(content)) return null
    }
    return parsed.href
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

/** 根相对地址只属于 Web 站点；桌面 app: 静态资源不代表所连接的服务器。 */
export function embeddedSrc(
  raw: string,
  origin: string,
  desktop = false
): string | null {
  const safe = embeddedUrl(raw)
  if (!safe) return null
  const absolute = httpUrl(safe)
  if (absolute) return absolute
  if (desktop) return null
  try {
    return httpUrl(new URL(safe, origin).href)
  } catch {
    return null
  }
}

/**
 * 链接框里填的地址 → 真正写进 `<a href>` 的地址。
 *
 * 🔴 **不补协议的话，`www.example.com` 是一个相对地址**（#405）。读者点开公告里的链接，
 * 浏览器按当前页解析，打开的是 `https://<本站>/…/www.example.com`，落在本系统的 404 上。
 * Tiptap 3.32.1 的 `isAllowedUri` 接受无协议串（只拒 `javascript:` 这类），
 * `defaultProtocol` 也只作用于自动识别和粘贴，`setLink({ href })` 原样写进去。
 *
 * 规则（只补「看起来是个域名」的那种，别的原样交给 Tiptap 校验）：
 * - 站内地址原样留着：`/`、`#`、`?`、`.` 开头（含 `//cdn…` 这种协议相对地址）
 * - 已经带协议的原样留着：`https://…`、`mailto:`、`tel:`；`javascript:` 也原样，让 Tiptap 拒掉
 * - `localhost:8080/x`、`10.0.0.1:443` 这种「主机:端口」不是协议，补 `https://`
 * - 像邮箱的补 `mailto:`
 * - 其余补 `https://`
 */
export function normalizeLinkHref(raw: string): string {
  const href = raw.trim()
  if (!href) return ""
  if (/^[/#?.]/.test(href)) return href
  // 主机要么是 localhost、要么带点（域名 / IPv4）—— 不然 `tel:10086` 也长得像「主机:端口」
  const hostPort = /^(?:localhost|[^\s/:?#@]*\.[^\s/:?#@]*):\d+(?:[/?#]|$)/i.test(href)
  if (!hostPort && /^[a-z][a-z\d+.-]*:/i.test(href)) return href
  if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(href)) return `mailto:${href}`
  return `https://${href}`
}

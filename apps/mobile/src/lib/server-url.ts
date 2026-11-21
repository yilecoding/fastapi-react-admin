/**
 * 服务器地址的校验 + 规范化（#406）：合格返回**末尾不带斜杠**的基址，不合格返回 null。
 *
 * 判据和桌面端 `packages/platform/src/desktop/http-url.ts` 的 `serverBaseUrl` 一致（#392）——
 * 移动端不依赖 `platform`（根 CLAUDE.md「结构」），所以这里另写一份，改一处要对一下另一处：
 *
 * - 只收 http / https，主机不能空
 * - 拒绝查询串、片段、账号密码：请求按 `${base}/api/v1/...` 拼，`https://h/?env=prod` 会拼成
 *   `https://h/?env=prod/api/v1/...`，打到站点根、拿回 HTML；`user:pw@` 也拼不出一个能用的请求
 * - 拒绝空白、控制字符、反斜杠
 * - 路径前缀（反代子路径）保留，scheme 和主机转小写
 *
 * ⚠️ 刻意不用 `new URL()`：RN 自带的 URL 实现历史上 `hostname` / `search` 这些 getter 直接抛「not implemented」，
 * 换 Hermes / Expo 版本时行为会变，而这一步决定的是「能不能存」，不押在 polyfill 上
 */
export function serverBaseUrl(raw: string): string | null {
  const value = raw.trim()
  if ([...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === '\\')) return null
  if (/[?#@]/.test(value)) return null
  const m = /^(https?):\/\/([^/]*)(\/.*)?$/i.exec(value)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  const authority = m[2].toLowerCase()
  const path = (m[3] ?? '').replace(/\/+$/, '')
  // 主机 + 可选端口；IPv6 字面量要带方括号
  const hp =
    /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:(\d{1,5}))?$/.exec(authority)
  if (!hp) return null
  if (hp[6] !== undefined && (Number(hp[6]) < 1 || Number(hp[6]) > 65535)) return null
  if (path.startsWith('//')) return null
  return `${scheme}://${authority}${path}`
}

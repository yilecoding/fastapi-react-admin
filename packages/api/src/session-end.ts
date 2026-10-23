/**
 * 会话为什么结束 → 给用户看的那句话（#138）。
 *
 * 原因码是后端契约（`common/security/session.py: EndReason`，随 401 的 `data.reason` 下发、
 * 也随 socket 的 `session:ended` 推过来），所以放在这个包里，两端共用一份 —— 新增一个原因只改这一处。
 *
 * 值是**中文原文 = i18n key**：本包不依赖 `@admin/i18n`，两端在渲染处 `t()`。
 * ⚠️ 因此 `packages/i18n/src/scripts/check.mjs` 的 `SRC_ROOTS` 要扫到这个目录，
 * 否则这些 key 在校验器眼里是孤儿，`pnpm i18n:fix` 会把它们从语言包里删掉
 */
export const SESSION_END_MESSAGE = {
  kicked: '你已被管理员强制下线，请重新登录',
  replaced: '账号已在其他设备登录，本设备已下线',
  idle: '长时间未操作，已自动退出，请重新登录',
  expired: '登录已过期，请重新登录',
  reuse: '检测到登录凭据被重复使用，已强制下线；如果不是你本人操作，请尽快修改密码',
  password_changed: '密码已修改，请用新密码登录',
  disabled: '账号已被停用，请联系管理员',
  logout: '已在其他标签页退出登录',
  invalid: '登录凭据无效，请重新登录',
} as const

export type SessionEndReason = keyof typeof SESSION_END_MESSAGE

/** 认不认识这个原因码。不认识的不出提示 —— 宁可不说，也不要说一句错的 */
export function isSessionEndReason(value: unknown): value is SessionEndReason {
  return typeof value === 'string' && Object.hasOwn(SESSION_END_MESSAGE, value)
}

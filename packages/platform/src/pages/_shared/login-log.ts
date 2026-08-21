import { t as tr } from '@admin/i18n'

/**
 * 登录日志的形状与共用格式化。
 *
 * 抽到 `_shared` 是因为有两个调用方：日志页（`log-login/`，全量审计视图）
 * 和个人中心的「最近登录」（`profile/recent-logins.tsx`，只看自己那几条）。
 */
export type LoginLog = {
  id: string
  user_uuid: string
  username: string
  /** 1 = 成功，0 = 失败 */
  status: number
  ip: string
  country: string | null
  region: string | null
  city: string | null
  user_agent: string | null
  os: string | null
  browser: string | null
  device: string | null
  msg: string
  login_time: string
}

/** 内网 IP 后端返 "Reserved"，直接显示会很奇怪 */
export function formatLocation(l: Pick<LoginLog, 'country' | 'region' | 'city'>): string {
  const parts = [l.country, l.region, l.city].filter((x) => x && x !== 'Reserved')
  return parts.length ? parts.join(' ') : tr('内网')
}

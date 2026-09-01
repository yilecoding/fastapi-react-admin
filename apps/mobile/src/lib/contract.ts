/**
 * 后端契约的手抄本。
 *
 * ⚠️ web 端是 `pnpm gen:api` 从 OpenAPI 生成 `schema.d.ts` 的；移动端暂时手抄，
 * 因为那份生成物住在 `packages/platform` 里，而 `apps/mobile` 不在那条依赖箭头上。
 * **改后端契约时这份要跟着改** —— 它不会自己报错，字段对不上只会在运行时
 * 变成 `undefined`（表现为界面上某一项空着，不报错）。
 * 等移动端要用的接口多起来，再考虑把 `gen:api` 的产物拆成一个独立包。
 */

/** `GET /api/v1/sys/users/me` —— 注意 dept / roles 在这个 DTO 里被**摊平成名字**了 */
export type CurrentUser = {
  id: string
  uuid: string
  dept_id: string | null
  username: string
  nickname: string
  avatar: string | null
  email: string | null
  phone: string | null
  status: number
  is_superuser: boolean
  is_staff: boolean
  is_multi_login: boolean
  join_time: string
  last_login_time: string | null
  timezone: string
  /** 部门**名称**（`GetCurrentUserInfoWithRelationDetail` 把对象换成了名字） */
  dept: string | null
  /** 角色**名称**列表，同上 */
  roles: string[]
}

/** `POST /api/v1/auth/login` —— 响应体里**没有 refresh token**，它在 httpOnly cookie 里 */
export type LoginResult = {
  access_token: string
  access_token_expire_time: string
  password_expire_days_remaining: number | null
  user: Omit<CurrentUser, 'dept' | 'roles'> & { dept_id: string | null }
}

/** `GET /api/v1/auth/captcha` —— `image` 是裸 base64，**不带 `data:` 前缀** */
export type Captcha = {
  is_enabled: boolean
  expire_seconds: number
  uuid: string
  image: string
}

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, API_BASE, uploadFile } from '../../api-client/client'
import type { LoginLog } from '../_shared/login-log'
import { t } from '@admin/i18n'
import { authKeys } from '../../auth/queries'

/**
 * 个人中心的四个写接口。
 *
 * ⚠️ 后端这几个 handler 统一是 `count > 0 ? success() : fail()` —— `count` 是
 * **受影响行数**，不是成败。
 *
 * 🔴 **「提交同值会 rowcount = 0 从而假失败」在三个方言上都不成立。**
 * SQL Server（aioodbc）、PostgreSQL（asyncpg）、MySQL（asyncmy —— SQLAlchemy
 * 默认开着 `CLIENT.FOUND_ROWS`）报的都是**匹配**行，设同值照样是 1 行、照样成功。
 * 实测见 `backend/app/admin/tests/api_v1/test_me_envelope.py`（MySQL 那一支是 2026-10-22 实跑改对的）。
 *
 * 页面侧「值没变就禁用提交」照样保留：省一次无意义的请求。
 */

/** 昵称：`PUT /sys/users/me/nickname`，body 是 embed 的 `{nickname}` */
export function useUpdateNickname() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (nickname: string) =>
      api.PUT<null>('/api/v1/sys/users/me/nickname', { body: { nickname } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/**
 * 头像：`PUT /sys/users/me/avatar`。后端只收完整的 http(s) 地址。
 *
 * 🔴 **清空必须发 `null`，不能发空字符串。** 库里存下 `''` 之后，读取侧
 * （`GetUserInfoDetail.avatar` 是 `HttpUrl | None`）序列化就炸 ——
 * **登录和 `/users/me` 全部 422**（`url_parsing: input is empty`），
 * 连改坏它的人自己都登不回来。实测踩过：清一次头像，全站登不进去，
 * 只能去库里 `UPDATE sys_user SET avatar = NULL` 才能救。
 * 后端入参也已经从裸 `str` 收紧成 `HttpUrl | None`，两头都堵上了。
 */
export function useUpdateAvatar() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (avatar: string) =>
      api.PUT<null>('/api/v1/sys/users/me/avatar', {
        body: { avatar: avatar.trim() ? avatar.trim() : null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/**
 * 显示时区：`PUT /sys/users/me/timezone`。
 *
 * 存服务端而不是 localStorage —— 「我在哪个时区」是跟人走的，换台机器不该重选。
 *
 * ⚠️ `invalidateQueries(authKeys.me())` 这一步是**必须**的，而且它做的不只是
 * 刷新界面上那两个时间：`meQuery` 的 queryFn 里会调 `setDisplayTimeZone()`
 * （见 `auth/queries.ts` 的注释），所以「让新时区在全站生效」这件事是靠重取
 * `me` 触发的。不 invalidate 的话数据库里已经改了，但界面还按旧时区显示。
 *
 * 已知限制：`formatDateTime` 读模块级变量、不是响应式的，所以**其他已经渲染好的
 * 标签页**（多页签用 `<Activity>` 保活，不会重新取数）里的时间要等那个页面
 * 自己下次取数才更新。换时区是个一年一次的动作，没为它加一套订阅式重渲染。
 */
export function useSaveTimeZone() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (timezone: string) =>
      api.PUT<null>('/api/v1/sys/users/me/timezone', { body: { timezone } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/**
 * 发邮箱验证码：`POST /emails/captcha`（email 插件，`extend = "admin"` 之外的独立前缀）。
 *
 * ⚠️ 这个接口会**真的发一封邮件**，SMTP 没配就会失败。失败必须显示出来 ——
 * 吞掉的话用户会对着一个永远填不对的验证码框发呆。
 *
 * 验证码按当前用户和目标邮箱隔离，只能使用一次，连续输错五次后作废。
 */
export function useSendEmailCaptcha() {
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (recipients: string) =>
      api.POST<null>('/api/v1/emails/captcha', { body: { recipients } }),
  })
}

/**
 * 给要绑定的手机号发短信验证码：`POST /sys/users/me/phone/captcha`（issue #168）。
 *
 * 真发一条短信（扣费）；按操作人 5 分钟 3 次限流，`captcha` 业务模板自己还有 60 秒冷却。
 * 已经是别人的号直接 409，不发。失败要显示出来 —— 没配短信通道时这里就是报错的地方（硬纪律 9）。
 */
export function useSendPhoneCaptcha() {
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (phone: string) => api.POST<null>('/api/v1/sys/users/me/phone/captcha', { body: { phone } }),
  })
}

/** 绑定手机号：`PUT /sys/users/me/phone`，号码 + 发到它上面的验证码。成功后 `phone_verified_time` 有值 */
export function useUpdatePhone() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (v: { phone: string; captcha: string }) => api.PUT<null>('/api/v1/sys/users/me/phone', { body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/** 解绑手机号：`DELETE /sys/users/me/phone`，号码和验证时间一起清 */
export function useUnbindPhone() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: () => api.DELETE<null>('/api/v1/sys/users/me/phone'),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/** 换邮箱：`PUT /sys/users/me/email`，要带上面发到新邮箱的验证码 */
export function useUpdateEmail() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (v: { email: string; captcha: string }) =>
      api.PUT<null>('/api/v1/sys/users/me/email', { body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/**
 * 改密码：`PUT /sys/users/me/password`。
 *
 * 三个字段都要传，后端自己比对 `new != confirm`；另外还会过
 * `validate_new_password`（长度/复杂度/历史密码复用，策略读的是 `sys_config`）。
 * 所以客户端只做最基本的校验，真正的规则以服务端返回的 msg 为准。
 *
 * 没有密码的账号（第三方登录建的）第一次设密码时**不传** `old_password`，
 * 前提是先完成了 {@link useReauthUrl} 那一趟第三方重新授权（#402），否则后端拒绝。
 */
export function useUpdatePassword() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (v: { old_password?: string; new_password: string; confirm_password: string }) =>
      api.PUT<null>('/api/v1/sys/users/me/password', { body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: passwordStatusKey }),
  })
}

export type PasswordStatus = {
  /** 第三方登录建的账号没有密码 */
  has_password: boolean
  /** 第一次设密码前的第三方重新授权完成了、还在有效期内（10 分钟，只能用一次） */
  reauth_verified: boolean
}

const passwordStatusKey = ['profile', 'password-status'] as const

/** `GET /sys/users/me/password-status`：决定密码块显示「修改密码」还是「设置密码」（#402） */
export const passwordStatusQuery = queryOptions({
  queryKey: passwordStatusKey,
  queryFn: () => api.GET<PasswordStatus>('/api/v1/sys/users/me/password-status'),
  retry: false,
})

/**
 * 无密码账号第一次设密码前，取「用已绑定的第三方账号重新验证身份」的授权链接（#402）。
 *
 * 🔴 为什么要这一步：没有旧密码可验，只凭一个会话就让设密码的话，拿到这个人一枚 access token
 * 的人就能给他设一个长期有效的密码。后端只认「授权回来的第三方账号正是绑在你名下的那一个」。
 *
 * 跳转方式同绑定（顶层跳转，cookie 在后端 authorize 那一跳上下发），但走**当前页**：
 * 回调完成后后端把人送回 `个人中心?section=security`，页面重新加载、状态里 `reauth_verified` 变 true，
 * 设置密码的表单直接出现。新开一页的话，原来那页还停在「先验证身份」上。
 */
export function useReauthUrl() {
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (source: SocialSource) => api.GET<string>(`/api/v1/oauth2/me/reauth?source=${source}`),
  })
}

// ─── 社交账号绑定（oauth2 插件）────────────────────────────────────────────────

/**
 * `backend/plugin/oauth2/enums.py: UserSocialType` —— 注意值是**首字母大写**的
 * `'Github'` / `'Google'`，接口按这个全等匹配，写成小写会 422。
 */
export const SOCIAL_SOURCES = [
  { source: 'Github', label: 'GitHub' },
  { source: 'Google', label: 'Google' },
] as const

export type SocialSource = (typeof SOCIAL_SOURCES)[number]['source']

export const socialKeys = {
  bindings: () => ['auth', 'oauth2', 'bindings'] as const,
}

/** 当前用户已绑定的社交账号，返回的是 source 字符串数组 */
export const socialBindingsQuery = queryOptions({
  queryKey: socialKeys.bindings(),
  queryFn: () => api.GET<string[]>('/api/v1/oauth2/me/bindings'),
  retry: false,
})

/**
 * 取绑定授权链接。
 *
 * 后端只负责生成 URL，**跳转要前端自己做**。URL 指向后端的 `/oauth2/{provider}/authorize`
 * （带一次性 ticket），由它下发 state cookie 再 302 到第三方（#227）—— 所以必须是**顶层跳转**
 * （新窗口 / `location.href`），不能改成 fetch：cookie 只在顶层导航的响应上才会被浏览器收下。
 * 授权完成后 provider 回调后端，后端再重定向到
 * `OAUTH2_FRONTEND_BINDING_REDIRECT_URI`。
 *
 * ⚠️ 一个已知的环境问题，界面上要讲清楚，否则用户会以为是功能坏了：
 * `OAUTH2_*_CLIENT_ID` 目前是占位值 `test` —— 跳过去会被 GitHub/Google 拒绝。
 * 在「参数配置」或 `.env` 里改，不是前端能修的。
 *
 * 回跳端口的坑已经修了：`OAUTH2_FRONTEND_*_REDIRECT_URI` 原先指向 5173 而前端在
 * 5174，现在两边统一到 8888（`plugin/oauth2/plugin.toml` + `vite.config.ts`）。
 * **改前端端口时这两处要一起改**，只改一边的表现是「授权成功、回跳到空端口」。
 */
export function useSocialBindingUrl() {
  return useMutation({
    mutationFn: (source: SocialSource) =>
      api.GET<string>(`/api/v1/oauth2/me/binding?source=${source}`),
  })
}

export function useUnbindSocial() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (source: SocialSource) =>
      api.DELETE(`/api/v1/oauth2/me/unbinding?source=${source}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: socialKeys.bindings() }),
  })
}

/* ────────────────────────── 我的最近登录 ────────────────────────── */

/**
 * 自己的最近登录记录。数据源 `GET /api/v1/sys/users/me/login-logs`（#405）。
 *
 * 🔴 **不要换回 `GET /logs/login`。** 那是审计视图，#30 起要 `log:login:list` ——
 * 这里原来借它，注释还写着「只挂了 `DependsJwtAuth`、普通用户能读」，权限码补上之后
 * 没这个码的人打开「安全」恒显示「登录记录读取失败」，而这块本来就是给**每个人**自查用的。
 * 那条的 `username` 还是 `LIKE`（`admin` 会捞回 `admin2` 的），原来要多取 50 条再在前端全等筛；
 * 现在后端按本人登录名全等取，前端不再筛。
 *
 * `username` 只用来分缓存（换了账号别读到上一个人的），不进请求 —— 「看谁的」由 token 决定。
 */
export const RECENT_LOGIN_LIMIT = 8

export const loginHistoryKeys = {
  mine: (username?: string) => ['profile', 'login-history', username ?? ''] as const,
}

export const myLoginHistoryQuery = (username?: string) =>
  queryOptions({
    queryKey: loginHistoryKeys.mine(username),
    queryFn: () => api.GET<LoginLog[]>(`/api/v1/sys/users/me/login-logs?limit=${RECENT_LOGIN_LIMIT}`),
    enabled: Boolean(username),
    retry: false,
  })

/* ────────────────────────── 头像上传 ────────────────────────── */

/** 头像上传的体积上限。服务端才是权威（`UPLOAD_IMAGE_SIZE_MAX`，默认 5MB，
 *  而且会被 `sys_config` 在运行时覆盖），这里压到 2MB 只为别把注定被拒的字节先传一遍 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** 上传结果里我们只用到这三个字段，不从 `pages/file/api` import 整个 `FileItem` —— 少一条页面间耦合 */
type UploadedImage = { id: string; public_url: string | null; original_name: string }

/**
 * 上传头像并写回 `PUT /sys/users/me/avatar`。
 *
 * 🔴 **必须 `?public=true`**：`avatar` 最终会进 `<img src>`，而私有文件的
 * `download_url` 要 Authorization 头 —— 塞进 `<img>` 只会拿到 401 和一张裂图。
 * 公开子树落在后端 `/uploads` 那个无鉴权挂载上，直链不需要凭据。
 *
 * 🔴 **和 `pages/file` 的 `useFileUploader` 分开写是刻意的**（同 `uploadInlineImage`
 * 那条注释）：把 `public` 做成通用上传的一个可选参数，就只剩「谁记得别传 true」
 * 一道纪律在守着。拆成独立命名的函数之后，通用上传路径在类型上就产生不了公开文件。
 *
 * ⚠️ **存的是绝对地址，里面带着 API 主机名。** 后端 `avatar` 字段是 `HttpUrl`，
 * 只收完整地址，而 `public_url` 是相对路径（`/uploads/2026/08/22/xxx.png`）——
 * 相对路径交给浏览器会按**前端** origin 解析（:8888），拿到 404。所以这里必须拼
 * `API_BASE`，代价是库里存下 `http://127.0.0.1:8000/uploads/…`：**换 API 主机名
 * 时这些行会全部失效**。要根治得把后端字段从 `HttpUrl` 改成 `str`、存相对路径、
 * 渲染处再拼 —— 那要动接口契约和所有渲染头像的地方，没做。
 */
export function useUploadAvatar() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async (file: File) => {
      const saved = await uploadFile<UploadedImage>('/api/v1/sys/files/upload?public=true', file)
      if (!saved.public_url) {
        // 后端收下了文件却没给直链 —— 多半 `is_public` 没落上，或 `/uploads` 挂载没生效。
        // **不能**回落到 download_url（要鉴权头），那会变成一张裂图 + 一行 401，
        // 而症状看起来像「上传坏了」
        throw new Error(t('上传成功但没有拿到直链，请检查后端 /uploads 挂载'))
      }
      const url = `${API_BASE}${saved.public_url}`
      await api.PUT<null>('/api/v1/sys/users/me/avatar', { body: { avatar: url } })
      return url
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/* ── 二次验证（#181）── 动态码字段叫 `otp`：后端按这个键名把它从操作日志里脱掉 */

export type MfaStatus = {
  enabled: boolean
  enabled_time: string | null
  recovery_remaining: number
  /** 按策略这个人必须开（开了就不能自己关） */
  enforced: boolean
  /** 服务端配了 MFA_SECRET_KEY（没配时开不了） */
  available: boolean
}

export const mfaKeys = { status: ['profile', 'mfa'] as const }

export const mfaStatusQuery = queryOptions({
  queryKey: mfaKeys.status,
  queryFn: () => api.GET<MfaStatus>('/api/v1/sys/users/me/mfa'),
})

export function useMfaSetup() {
  return useMutation({
    mutationFn: () => api.POST<{ totp_secret: string; otpauth_uri: string }>('/api/v1/sys/users/me/mfa/setup'),
  })
}

function useMfaAction<T>(path: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (otp: string) => api.POST<T>(path, { body: { otp } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mfaKeys.status }),
  })
}

export const useMfaEnable = () => useMfaAction<{ recovery_codes: string[] }>('/api/v1/sys/users/me/mfa/enable')
export const useMfaDisable = () => useMfaAction<null>('/api/v1/sys/users/me/mfa/disable')
export const useMfaRegenerate = () =>
  useMfaAction<{ recovery_codes: string[] }>('/api/v1/sys/users/me/mfa/recovery-codes')

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, API_BASE, uploadFile, type PageData } from '../../api-client/client'
import type { LoginLog } from '../_shared/login-log'
import { t } from '@admin/i18n'
import { authKeys } from '../../auth/queries'

/**
 * 个人中心的四个写接口。
 *
 * ⚠️ 后端这几个 handler 统一是 `count > 0 ? success() : fail()` —— `count` 是
 * **受影响行数**，不是成败。提交一个跟库里一模一样的值，rowcount = 0，
 * 接口会返回「失败」但其实什么都没错。所以页面侧必须在「值没变」时禁用提交，
 * 别把这个假失败甩给用户看。
 */

/** 昵称：`PUT /sys/users/me/nickname`，body 是 embed 的 `{nickname}` */
export function useUpdateNickname() {
  const qc = useQueryClient()
  return useMutation({
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
    mutationFn: (avatar: string) =>
      api.PUT<null>('/api/v1/sys/users/me/avatar', {
        body: { avatar: avatar.trim() ? avatar.trim() : null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

/**
 * 发邮箱验证码：`POST /emails/captcha`（email 插件，`extend = "admin"` 之外的独立前缀）。
 *
 * ⚠️ 这个接口会**真的发一封邮件**，SMTP 没配就会失败。失败必须显示出来 ——
 * 吞掉的话用户会对着一个永远填不对的验证码框发呆。
 *
 * ⚠️ 验证码存的 key 是 `fba:email:captcha:{IP}`，**按 IP 不按邮箱**：
 * 同一出口 IP 下后发的会覆盖先发的。
 */
export function useSendEmailCaptcha() {
  return useMutation({
    mutationFn: (recipients: string) =>
      api.POST<null>('/api/v1/emails/captcha', { body: { recipients } }),
  })
}

/** 换邮箱：`PUT /sys/users/me/email`，要带上面发到新邮箱的验证码 */
export function useUpdateEmail() {
  const qc = useQueryClient()
  return useMutation({
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
 */
export function useUpdatePassword() {
  return useMutation({
    mutationFn: (v: { old_password: string; new_password: string; confirm_password: string }) =>
      api.PUT<null>('/api/v1/sys/users/me/password', { body: v }),
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
 * 后端只负责生成 URL（带 state，存 Redis），**跳转要前端自己做**。
 * 授权完成后 provider 回调后端，后端再重定向到
 * `OAUTH2_FRONTEND_BINDING_REDIRECT_URI`。
 *
 * ⚠️ 一个已知的环境问题，界面上要讲清楚，否则用户会以为是功能坏了：
 * `OAUTH2_*_CLIENT_ID` 目前是占位值 `test` —— 跳过去会被 GitHub/Google 拒绝。
 * 在「参数配置」或 `.env` 里改，不是前端能修的。
 *
 * 回跳端口的坑已经修了：`OAUTH2_FRONTEND_*_REDIRECT_URI` 原先指向 5173 而前端在
 * 5174，现在两边统一到 1125（`plugin/oauth2/plugin.toml` + `vite.config.ts`）。
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
    mutationFn: (source: SocialSource) =>
      api.DELETE(`/api/v1/oauth2/me/unbinding?source=${source}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: socialKeys.bindings() }),
  })
}

/* ────────────────────────── 我的最近登录 ────────────────────────── */

/**
 * 自己的最近登录记录。数据源 `GET /api/v1/logs/login`。
 *
 * 这个接口只挂了 `DependsJwtAuth`（列表没有权限码，只有删除/清空有），
 * 所以普通用户能读 —— 「安全设置」里最实用的一块，不需要动后端就能做。
 *
 * ⚠️ **`username` 入参是 `LIKE '%xxx%'` 而不是全等**
 * （`crud_login_log.get_select`: `filters['username__like'] = f'%{username}%'`）。
 * 直接拿它当「我的记录」会串进别人的：登录名 `admin` 会把 `admin2`、`superadmin`
 * 的登录记录一起捞回来，而这一页的语义是「**你的**账号在这些地方登录过」——
 * 串一条进来就是安全信息的误报。
 *
 * 所以这里多取一些（`size=50`）再在前端按 `username` **全等**筛一遍，取前 N 条。
 * 代价：如果同名前缀的用户在这 50 条里占了绝大多数，自己的记录可能不足 N 条 ——
 * 属于可接受的降级（少显示几条，不会显示错的）。
 * 真正的修法是后端加一个全等参数或 `/logs/login/me`，那要改后端，留给以后。
 */
export const RECENT_LOGIN_LIMIT = 8

export const loginHistoryKeys = {
  mine: (username?: string) => ['profile', 'login-history', username ?? ''] as const,
}

export const myLoginHistoryQuery = (username?: string) =>
  queryOptions({
    queryKey: loginHistoryKeys.mine(username),
    queryFn: async () => {
      const q = new URLSearchParams({ page: '1', size: '50', username: username! })
      const res = await api.GET<PageData<LoginLog>>(`/api/v1/logs/login?${q}`)
      return res.items.filter((r) => r.username === username).slice(0, RECENT_LOGIN_LIMIT)
    },
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
 * 🔴 **和 `pages/file` 的 `useUploadFile` 分开写是刻意的**（同 `uploadInlineImage`
 * 那条注释）：把 `public` 做成通用上传的一个可选参数，就只剩「谁记得别传 true」
 * 一道纪律在守着。拆成独立命名的函数之后，通用上传路径在类型上就产生不了公开文件。
 *
 * ⚠️ **存的是绝对地址，里面带着 API 主机名。** 后端 `avatar` 字段是 `HttpUrl`，
 * 只收完整地址，而 `public_url` 是相对路径（`/uploads/2026/08/22/xxx.png`）——
 * 相对路径交给浏览器会按**前端** origin 解析（:1125），拿到 404。所以这里必须拼
 * `API_BASE`，代价是库里存下 `http://127.0.0.1:8000/uploads/…`：**换 API 主机名
 * 时这些行会全部失效**。要根治得把后端字段从 `HttpUrl` 改成 `str`、存相对路径、
 * 渲染处再拼 —— 那要动接口契约和所有渲染头像的地方，没做。
 */
export function useUploadAvatar() {
  const qc = useQueryClient()
  return useMutation({
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

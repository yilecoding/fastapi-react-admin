import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'
import { t } from '@admin/i18n'
import { devConfigKeys } from '../dev-sandbox/api'

/**
 * 参数配置（`plugin/config`）。
 *
 * ⚠️ 这不是「随便存点键值对」的表 —— 里面有一部分是**活的系统策略**：
 * 后端 `utils/dynamic_config.py` 会在登录、验证码、改密码这些路径上
 * 把 `sys_config` 的值 `setattr` 到 `settings` 上，覆盖 `.env` 的默认值。
 * 改 `LOGIN_CAPTCHA_ENABLED` 就是真的开关掉登录验证码，
 * 改 `USER_LOCK_THRESHOLD` 就是真的改暴力破解锁定阈值。所以页面上要给足警示。
 *
 * 接口前缀是 `/api/v1/sys/configs`（插件 `extend = "admin"`，落在 admin 的 sys 下），
 * **不是** plugin.toml 里写的 `/configs`。
 */
export type ConfigItem = {
  /** 雪花 ID，字符串。不要 Number() 它 */
  id: string
  name: string
  /** 分组：EMAIL / USER_SECURITY / LOGIN / AI，也可能为 null（未分组） */
  type: string | null
  key: string
  value: string
  /** 是否是给前端工程读的配置 */
  is_frontend: boolean
  remark: string | null
  created_time: string
  updated_time: string | null
}

export type ConfigBody = {
  name: string
  type: string | null
  key: string
  value: string
  is_frontend: boolean
  remark: string | null
}

export const configKeys = { all: ['sys', 'config', 'all'] as const }

/**
 * 用 `/all` 而不是分页接口。
 *
 * 理由和「在线用户」页一样但更强：这个页面的主要用法是**按组批量改**
 * （一屏看完 USER_SECURITY 的 9 项再一起存），分页会把一组切断。
 * 数据量也小 —— 种子 17 条，实际长到几百条也就是一次请求。
 * 筛选/分页照旧在前端做，但游标仍然进 URL（硬纪律 2）。
 *
 * 注意后端 `get_all` 带 `@cached`（Redis），增删改都有 `@cache_invalidate`，
 * 所以改完立刻读回是新值 —— 实测确认过。
 */
export const configsQuery = queryOptions({
  queryKey: configKeys.all,
  queryFn: () => api.GET<ConfigItem[]>('/api/v1/sys/configs/all'),
  staleTime: 30_000,
})

/**
 * 🔴 光失效 `configKeys.all` 是不够的。`dev-sandbox/api.ts` 的 `devConfigQuery`
 * 是另一条完全独立的 query key（打的是专门开的 `dev-sandbox-gate` 端点，见那边的
 * 注释），react-query 的前缀匹配救不了它——存了 `DEV_SANDBOX_ENABLED` 之后，
 * 侧边栏「开发工具」那颗合成节点要等 `devConfigQuery` 的 `staleTime`（60s）
 * 自然过期才会跟着变，实测确认过。这两条 key 不共享任何前缀，只能两个都手动失效。
 */
function invalidateConfigCaches(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: configKeys.all })
  qc.invalidateQueries({ queryKey: devConfigKeys.all })
}

export function useCreateConfig() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (body: ConfigBody) => api.POST('/api/v1/sys/configs', { body }),
    onSuccess: () => invalidateConfigCaches(qc),
  })
}

export function useUpdateConfig() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, body }: { id: string; body: ConfigBody }) =>
      api.PUT(`/api/v1/sys/configs/${id}`, { body }),
    onSuccess: () => invalidateConfigCaches(qc),
  })
}

/**
 * 批量保存 —— 逐条 `PUT /{pk}` 并发，**不用**后端的批量接口。
 *
 * `PUT /sys/configs`（批量）的权限码曾经写成 `sys.config.edits`（点号+复数，
 * 菜单种子里没这一条，对所有非超管角色恒 403）——**这个 bug 已经修好**
 * （改成复用 `sys:config:edit`，见 `config.py:69`），但仍然刻意走单条接口：
 * 批量接口是整批一次校验（`config_service.bulk_update`，任一行冲突就整批
 * 回滚），而这里要的是**逐行独立的失败反馈**（`allSettled` 而不是 `all`：
 * 一条失败不该让已经存进去的那些无声无息）——这是两种不同的失败语义，
 * 不是权限问题绕不绕过的事。
 */
export function useSaveConfigs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (rows: Array<{ id: string; body: ConfigBody }>) => {
      const results = await Promise.allSettled(
        rows.map((r) => api.PUT(`/api/v1/sys/configs/${r.id}`, { body: r.body }))
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) throw new Error(t('{{failed}} / {{total}} 项保存失败', { failed, total: rows.length }))
    },
    onSettled: () => invalidateConfigCaches(qc),
  })
}

/** 批量删除。这个接口是收数组的（body 直接是 id 列表） */
export function useDeleteConfigs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.DELETE('/api/v1/sys/configs', { body: ids }),
    onSuccess: () => invalidateConfigCaches(qc),
  })
}

// ─── 分组元数据 ───────────────────────────────────────────────────────────────

/** 后端 `plugin/config/enums.py: ConfigType` 的四个值 */
export const CONFIG_TYPES = ['LOGIN', 'USER_SECURITY', 'EMAIL', 'AI'] as const

export const TYPE_LABEL: Record<string, string> = {
  LOGIN: '登录',
  USER_SECURITY: '用户安全',
  EMAIL: '邮件',
  AI: 'AI',
}

export const TYPE_DESC: Record<string, string> = {
  LOGIN: '登录流程开关。关掉验证码会立刻对所有人生效。',
  USER_SECURITY: '口令强度与账号锁定策略。放宽会直接降低系统的抗暴力破解能力。',
  EMAIL: '发信服务器。密码字段以密文展示，留空表示不改动。',
  AI: '预留分组，种子数据里没有条目。',
}

// 参数名不能叫 t —— 会遮蔽本模块从 @admin/i18n 导入的翻译函数
export const typeLabel = (type: string | null | undefined) =>
  type ? (TYPE_LABEL[type] ?? type) : '未分组'

/** 组总开关：`<TYPE>_CONFIG_STATUS`。为 '0' 时后端整组不加载，回落到 .env */
export const isGroupSwitch = (key: string) => key.endsWith('_CONFIG_STATUS')

/**
 * 值要打码的键 —— 这些会以明文存库，但至少别在屏幕上晃。
 *
 * ⚠️ 必须是**后缀**匹配，不能用 `includes('PASSWORD')`：
 * `USER_PASSWORD_MIN_LENGTH` / `USER_PASSWORD_EXPIRY_DAYS` 这些是**口令策略**，
 * 不是口令本身。用包含匹配会把它们也当密码 —— 数字输入框变成小圆点、
 * 保存确认框里显示「（已隐藏）」，人根本不知道自己把最小长度改成了几。
 */
export const isSecret = (key: string) => /(PASSWORD|SECRET|TOKEN|API_?KEY|CREDENTIALS?)$/i.test(key)

/**
 * 改动会立刻放宽安全边界的键。页面上要单独标出来，
 * 保存前的确认框也会把它们列一遍。
 */
const SENSITIVE = new Set([
  'LOGIN_CAPTCHA_ENABLED',
  'USER_LOCK_THRESHOLD',
  'USER_LOCK_SECONDS',
  'USER_PASSWORD_MIN_LENGTH',
  'USER_PASSWORD_EXPIRY_DAYS',
  'USER_PASSWORD_REQUIRE_SPECIAL_CHAR',
  'USER_PASSWORD_HISTORY_CHECK_COUNT',
])
export const isSensitive = (key: string) => SENSITIVE.has(key) || isGroupSwitch(key)

// ─── 值类型推断 ───────────────────────────────────────────────────────────────

export type ValueKind = 'bool' | 'switch01' | 'int' | 'secret' | 'text'

/**
 * `value` 在库里一律是字符串，控件类型只能猜。
 *
 * 三种真实存在的布尔写法要分开：
 *   - `'true' / 'false'` —— 后端 `str_to_bool` 认这个（EMAIL_SSL / LOGIN_CAPTCHA_ENABLED）
 *   - `'1' / '0'` —— 组总开关 `*_CONFIG_STATUS` 用的是这个
 * 猜错会把开关存成字符串 'true' 而后端在等 '1'，那一组配置就整组失效且毫无提示。
 */
export function valueKind(item: Pick<ConfigItem, 'key' | 'value'>): ValueKind {
  if (isSecret(item.key)) return 'secret'
  if (item.value === 'true' || item.value === 'false') return 'bool'
  if (isGroupSwitch(item.key) && (item.value === '0' || item.value === '1')) return 'switch01'
  if (/^-?\d+$/.test(item.value)) return 'int'
  return 'text'
}

export function toBody(item: ConfigItem, value: string): ConfigBody {
  return {
    name: item.name,
    type: item.type,
    key: item.key,
    value,
    is_frontend: item.is_frontend,
    remark: item.remark,
  }
}

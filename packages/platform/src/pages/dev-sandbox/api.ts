import { queryOptions } from '@tanstack/react-query'

import { api } from '../../api-client/client'

/**
 * 沙箱的开关来自**参数配置**（`sys_config` 的 DEV 组）。
 *
 * 🔴 走的是专门开的 `GET /sys/configs/dev-sandbox-gate`，**不是**
 * `GET /sys/configs/all`。issue #30 之前这里确实打的是 `/all?type=DEV`，
 * 当时它只要 `DependsJwtAuth`；修完 #30 之后 `/all` 改成要 `sys:config:list`，
 * 而这批新演示账号大多没有这个权限码——沙箱页面直接被 403 打成报错态
 * （不是「关闭」提示，是真报错，见 `dev-sandbox/index.tsx` 的 `error` 分支）。
 * 新端点只读 DEV 组、type 写死不接受入参，所以能只挂 `DependsJwtAuth`：
 * 暴露面从「整张参数配置表（含邮件服务器地址等）」缩到「两个布尔开关」，
 * 跟这里"沙箱本身不碰业务数据，只用来决定露不露出来"的设计初衷对上号。
 *
 * 真正的参数配置读写页面仍然要 `sys:config:list`，两条路径不共用。
 */
type DevConfigRow = { key: string; value: string }

export const devConfigKeys = { all: ['sys', 'config', 'dev-sandbox-gate'] as const }

export const devConfigQuery = queryOptions({
  queryKey: devConfigKeys.all,
  queryFn: () => api.GET<DevConfigRow[]>('/api/v1/sys/configs/dev-sandbox-gate'),
  staleTime: 60_000,
})

/** 整组总开关。后端 `load_config` 认 '1'/'0'，不是 'true'/'false' */
export const DEV_GROUP_SWITCH = 'DEV_CONFIG_STATUS'
/** 沙箱开关。布尔类走 'true'/'false'（后端 `str_to_bool` 认这个） */
export const DEV_SANDBOX_ENABLED = 'DEV_SANDBOX_ENABLED'

export type SandboxGate = { on: boolean; reason: string }

/**
 * 沙箱开不开。
 *
 * 优先级：DEV 组总开关 → `DEV_SANDBOX_ENABLED` → 缺省。
 * 缺省是「开发期开、生产期关」—— 参数配置里还没建这一组时本地也能用，
 * 而生产构建默认不露出来。配置项一旦存在就以它为准（含把它打开）。
 *
 * ⚠️ 值的字面量不能混：总开关是 '1'/'0'，布尔项是 'true'/'false'。
 * 存错了后端不报错也不提示，只是整组配置不加载、回落到 .env。
 */
export function readSandboxGate(
  rows: DevConfigRow[] | undefined,
  isDev: boolean
): SandboxGate {
  if (!rows || rows.length === 0) {
    return isDev
      ? { on: true, reason: '参数配置里还没有 DEV 组，开发期默认开启' }
      : { on: false, reason: '参数配置里还没有 DEV 组，生产环境默认关闭' }
  }

  const get = (key: string) => rows.find((r) => r.key === key)?.value

  if (get(DEV_GROUP_SWITCH) === '0') {
    return { on: false, reason: 'DEV 组总开关已关闭（DEV_CONFIG_STATUS = 0）' }
  }

  const flag = get(DEV_SANDBOX_ENABLED)
  if (flag === undefined) {
    return isDev
      ? { on: true, reason: `DEV 组里没有 ${DEV_SANDBOX_ENABLED}，开发期默认开启` }
      : { on: false, reason: `DEV 组里没有 ${DEV_SANDBOX_ENABLED}，生产环境默认关闭` }
  }

  return flag === 'true'
    ? { on: true, reason: `${DEV_SANDBOX_ENABLED} = true` }
    : { on: false, reason: `${DEV_SANDBOX_ENABLED} = ${flag}` }
}

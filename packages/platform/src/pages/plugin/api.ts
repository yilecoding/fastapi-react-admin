import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { API_BASE, api } from '../../api-client/client'
import { ApiError } from '../../api-client/errors'
import { tokenStore } from '../../api-client/token-store'
import { t } from '@admin/i18n'

/**
 * 插件管理。
 *
 * 数据不来自数据库 —— `plugin_service.get_all()` 是把 Redis 里
 * `fba:plugin:*` 的键读出来，值是各插件 `plugin.toml` 解析后的 JSON。
 * 所以这一页没有分页、没有排序入参，一次全给。
 *
 * ⚠️ 全部接口都是 `DependsSuperUser`（不是权限码），
 * 而菜单表里「插件管理」这条的 `perms` 是空串 —— 路由守卫必须用
 * `requireSuperUser()`，用 `requirePerm()` 检查不到任何东西等于没设防。
 */
export type PluginMeta = {
  name: string
  summary: string
  version: string
  description: string
  author: string
  tags: string[]
  /** 插件声明支持的数据库 */
  database: string[]
  /** ⚠️ 是**字符串** '0' / '1'，不是 boolean */
  enable: string
}

export type PluginInfo = {
  plugin: PluginMeta
  /** `router` = 独立路由的应用级插件；`extend` = 挂到已有 app 下的扩展插件 */
  app?: { router?: string[]; extend?: string }
  api?: Record<string, { prefix?: string; tags?: string }>
  settings?: Record<string, unknown>
}

export const pluginKeys = {
  all: ['sys', 'plugin'] as const,
  list: () => [...pluginKeys.all, 'list'] as const,
  changed: () => [...pluginKeys.all, 'changed'] as const,
}

export const pluginsQuery = queryOptions({
  queryKey: pluginKeys.list(),
  queryFn: () => api.GET<PluginInfo[]>('/api/v1/sys/plugins'),
})

/**
 * 是否有插件变更待重启。
 *
 * 安装/卸载/改状态都会把 `fba:plugin:changed` 置位，但**这些改动要重启服务才生效**
 * —— 界面上必须把这件事说出来，否则用户会以为点完开关就已经生效了。
 */
export const pluginChangedQuery = queryOptions({
  queryKey: pluginKeys.changed(),
  queryFn: () => api.GET<boolean>('/api/v1/sys/plugins/changed'),
})

/**
 * 切换启用状态。
 *
 * ⚠️ 后端是**无参切换**（`PUT /{plugin}/status` 不收 body，自己读当前值取反），
 * 不是「设置成某个值」。所以不能乐观更新成指定值，只能取反或直接重取。
 */
export function useTogglePlugin() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (name: string) => api.PUT(`/api/v1/sys/plugins/${name}/status`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pluginKeys.all })
    },
  })
}

/** 卸载。后端会先备份成 zip 再删目录；必需插件会被拒绝。仅开发环境可用。 */
export function useUninstallPlugin() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (name: string) => api.DELETE(`/api/v1/sys/plugins/${name}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pluginKeys.all })
    },
  })
}

/**
 * 安装：zip 上传或 git 仓库地址。仅开发环境可用。
 *
 * zip 走 multipart，**不能经 `api.POST`** —— openapi-fetch 默认会把 body
 * JSON 序列化，FormData 进去就废了。而且 multipart 的 Content-Type 必须让
 * 浏览器自己生成（要带 boundary），手写会导致后端解析不出文件。
 * 所以这里直接 fetch，只补一个 Authorization 头。
 */
export function useInstallPlugin() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async (v: { type: 'zip'; file: File } | { type: 'git'; repoUrl: string }) => {
      if (v.type === 'git') {
        return api.POST(`/api/v1/sys/plugins?type=git&repo_url=${encodeURIComponent(v.repoUrl)}`)
      }
      const fd = new FormData()
      fd.append('file', v.file)
      const token = tokenStore.get()
      const res = await fetch(`${API_BASE}/api/v1/sys/plugins?type=zip`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      const body = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
      if (!res.ok || (body?.code !== undefined && body.code !== 200)) {
        throw new ApiError(res.status, body?.code ?? res.status, body?.msg ?? t('安装失败（HTTP {{code}}）', { code: res.status }), body)
      }
      return body
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pluginKeys.all })
    },
  })
}

/**
 * 下载插件 zip。
 *
 * 不能用 `<a href>` 直接指过去 —— 这个接口挂了 `DependsSuperUser`，
 * 普通链接不会带 Authorization 头，服务端会回 401 而浏览器只会显示一个坏文件。
 * 必须手动 fetch 带上 token，再用 blob URL 触发下载。
 */
export async function downloadPlugin(name: string): Promise<void> {
  const token = tokenStore.get()
  const res = await fetch(`${API_BASE}/api/v1/sys/plugins/${name}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let msg = t('下载失败（HTTP {{code}}）', { code: res.status })
    try {
      const body = await res.json()
      if (body?.msg) msg = body.msg
    } catch {
      /* 非 JSON 响应，保留默认文案 */
    }
    throw new ApiError(res.status, res.status, msg, null)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ─── 展示辅助 ────────────────────────────────────────────────────────────────

export const isEnabled = (p: PluginInfo) => p.plugin.enable === '1'

/** `app.extend` = 挂在已有 app 下；`app.router` = 独立路由 */
export function pluginKind(p: PluginInfo): { label: string; hint: string } {
  if (p.app?.extend) {
    return {
      label: t('扩展 · {{app}}', { app: p.app.extend }),
      hint: t('路由挂到 {{app}} 应用下，实际前缀会带上该应用的段', { app: p.app.extend }),
    }
  }
  if (p.app?.router?.length) {
    return { label: t('独立路由 · {{routers}}', { routers: p.app.router.join(', ') }), hint: t('拥有自己的一级路由') }
  }
  return { label: t('未声明'), hint: t('plugin.toml 里没写 app 段') }
}

/**
 * 插件声明的 API 前缀。
 *
 * ⚠️ 这只是 `plugin.toml` 里**写的**值，不一定是实际挂载路径：
 * `extend = "admin"` 的插件会被挂到 `/api/v1/sys/` 下，
 * 所以参数配置真实前缀是 `/api/v1/sys/configs` 而不是 `/configs`。
 * 界面上要把这个差异讲清楚，别让人照着 toml 去调接口。
 */
export function declaredPrefixes(p: PluginInfo): string[] {
  if (!p.api) return []
  return Object.values(p.api)
    .map((v) => v?.prefix)
    .filter((x): x is string => Boolean(x))
}

export function realPrefix(p: PluginInfo, declared: string): string {
  return p.app?.extend === 'admin' ? `/api/v1/sys${declared}` : `/api/v1${declared}`
}

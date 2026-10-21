import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * 能力开放应用：给对接的外部系统发一对 AK/SK，它就能签名调用勾选的开放接口（`/api/open/v1`）。
 *
 * 🔴 **接口永远不下发 SK，也不下发密文** —— 只有 `secret_hint`（前几位，用来辨认）。
 * 明文只出现在新建 / 重置密钥那一次的响应里（`IssuedSecret`），关掉弹窗就再也拿不到。
 */
export type OpenApp = {
  id: string
  code: string
  name: string
  access_key: string
  secret_hint: string
  scopes: string[]
  /** null = 不限 */
  ip_whitelist: string[] | null
  rate_per_minute: number | null
  expire_time: string | null
  status: number
  /** 派生状态：过期由后端按失效时间算，前端不自己比时间 */
  state: 'enabled' | 'disabled' | 'expired'
  remark: string | null
  last_used_time: string | null
  created_time: string
}

export type OpenAppBody = {
  name: string
  scopes: string[]
  ip_whitelist: string[] | null
  rate_per_minute: number | null
  expire_time: string | null
  status: number
  remark: string | null
}

export type IssuedSecret = { id: string; code: string; access_key: string; secret_key: string }

export type OpenScope = { scope: string; label: string; method: string; path: string }

export const openAppKeys = {
  all: ['open-app'] as const,
  list: (qs: string) => [...openAppKeys.all, 'list', qs] as const,
  detail: (id: string) => [...openAppKeys.all, 'detail', id] as const,
  scopes: () => [...openAppKeys.all, 'scopes'] as const,
}

export function openAppsQuery(qs: string) {
  return queryOptions({
    queryKey: openAppKeys.list(qs),
    queryFn: () => api.GET<PageData<OpenApp>>(`/api/v1/open-apps?${qs}`),
    placeholderData: (prev) => prev,
  })
}

/** 给调用日志页的「应用」下拉用：应用天然只有几十个，一次取够 */
export function allOpenAppsQuery() {
  return queryOptions({
    queryKey: openAppKeys.list('all'),
    queryFn: () => api.GET<PageData<OpenApp>>('/api/v1/open-apps?page=1&size=200'),
  })
}

export function openAppQuery(id: string | null) {
  return queryOptions({
    queryKey: openAppKeys.detail(id ?? ''),
    queryFn: () => api.GET<OpenApp>(`/api/v1/open-apps/${id}`),
    enabled: id !== null,
    retry: false,
  })
}

export function openScopesQuery() {
  return queryOptions({
    queryKey: openAppKeys.scopes(),
    queryFn: () => api.GET<OpenScope[]>('/api/v1/open-apps/scopes'),
    staleTime: Infinity,
  })
}

export function useCreateOpenApp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: OpenAppBody & { code: string }) => api.POST<IssuedSecret>('/api/v1/open-apps', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: openAppKeys.all }),
  })
}

export function useUpdateOpenApp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: OpenAppBody }) => api.PUT(`/api/v1/open-apps/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: openAppKeys.all }),
  })
}

export function useResetOpenAppSecret() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.POST<IssuedSecret>(`/api/v1/open-apps/${id}/secret`),
    onSuccess: () => qc.invalidateQueries({ queryKey: openAppKeys.all }),
  })
}

export function useDeleteOpenApp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/open-apps/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: openAppKeys.all }),
  })
}

/** 导出只含开放接口的 OpenAPI 文档。地址要 Authorization 头，不能做成 `<a href>`（存下来的会是 401 的 JSON） */
export async function downloadOpenApiDoc(): Promise<void> {
  const doc = await api.GET<unknown>('/api/v1/open-apps/openapi.json')
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'open-api.json'
  a.click()
  URL.revokeObjectURL(url)
}

/** 「每行一个 / 逗号分隔」的文本框 ↔ 字符串数组 */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean))]
}

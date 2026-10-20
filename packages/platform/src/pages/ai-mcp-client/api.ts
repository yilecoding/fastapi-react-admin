import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * MCP 凭据：外部系统（pis-agent、Claude Desktop…）经 `/api/v1/ai/mcp` 调 AI 工具时用的身份。
 *
 * 🔴 **接口永远不下发令牌，也不下发哈希** —— 只有 `token_hint`（前几位，用来辨认是哪一把）。
 * 明文只出现在新建 / 重新生成那一次的响应里（`IssuedToken`），关掉弹窗就再也拿不到。
 */
export type McpClient = {
  id: string
  client_id: string
  name: string
  token_hint: string
  /** 可代表的用户名；`*` = 任何普通用户 */
  act_as: string[]
  allow_superuser: boolean
  /** 允许发起写操作：仍不直接执行，每次都要被代表的人本人在网页确认 */
  allow_write: boolean
  /** 工具白名单；null = 不限（只能收窄） */
  tools: string[] | null
  rate_per_minute: number | null
  status: number
  remark: string | null
  last_used_time: string | null
  created_time: string
}

export type McpClientBody = {
  name: string
  act_as: string[]
  allow_superuser: boolean
  allow_write: boolean
  tools: string[] | null
  rate_per_minute: number | null
  status: number
  remark: string | null
}

export type IssuedToken = { id: string; client_id: string; mcp_token: string }

export const mcpClientKeys = {
  all: ['ai-mcp-client'] as const,
  list: () => [...mcpClientKeys.all, 'list'] as const,
}

export function mcpClientsQuery() {
  return queryOptions({
    queryKey: mcpClientKeys.list(),
    queryFn: () => api.GET<PageData<McpClient>>('/api/v1/ai/mcp-clients?page=1&size=100'),
  })
}

export function useCreateMcpClient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: McpClientBody & { client_id: string }) =>
      api.POST<IssuedToken>('/api/v1/ai/mcp-clients', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpClientKeys.all }),
  })
}

export function useUpdateMcpClient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: McpClientBody }) =>
      api.PUT(`/api/v1/ai/mcp-clients/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpClientKeys.all }),
  })
}

export function useRotateMcpClient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.POST<IssuedToken>(`/api/v1/ai/mcp-clients/${id}/rotate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpClientKeys.all }),
  })
}

export function useDeleteMcpClient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/ai/mcp-clients/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpClientKeys.all }),
  })
}

/** 「每行一个 / 逗号分隔」的文本框 ↔ 字符串数组 */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean))]
}

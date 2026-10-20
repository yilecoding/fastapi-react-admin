import { queryOptions } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * AI 工具调用审计。
 *
 * 🔴 **被拒绝的调用也在这里**（`status = 2`）——「有人在反复让 AI 试探他
 * 没有权限的操作」只能从这条线索看出来，所以它和普通失败是分开的两个状态。
 */
export type ToolInvocation = {
  id: string
  conversation_id: string
  user_id: string
  tool_name: string
  /** 见 `INVOCATION_STATUS` */
  status: number
  params_redacted: string | null
  result_summary: string | null
  permission_code: string | null
  error: string | null
  duration_ms: number | null
  /** null = 网页对话；`mcp:<client id>` = 外部系统经 MCP 替某个用户调的 */
  channel: string | null
  created_time: string
}

/** 数值和后端 `plugin/ai/enums.py: ToolInvocationStatus` 一一对应，改数字要两边一起改 */
export const INVOCATION_STATUS: Record<number, { label: string; tone: 'success' | 'danger' | 'warning' | 'muted' }> = {
  0: { label: '成功', tone: 'success' },
  1: { label: '失败', tone: 'danger' },
  2: { label: '无权限', tone: 'warning' },
  3: { label: '待确认', tone: 'muted' },
  4: { label: '已取消', tone: 'muted' },
}

/** 这一页列表 query 的 key 前缀。`useQuerySearch` 的 `refreshKey` 也用它 ——
 *  「点搜索必须真的重取」靠让这个前缀失效实现（见 use-query-search.ts） */
export const toolLogKeys = { all: ['ai-tool-log'] as const }

export function toolLogsQuery(qs: string) {
  return queryOptions({
    queryKey: [...toolLogKeys.all, qs],
    queryFn: () => api.GET<PageData<ToolInvocation>>(`/api/v1/ai/tools/logs?${qs}`),
    placeholderData: (prev: PageData<ToolInvocation> | undefined) => prev,
  })
}

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { t } from '@admin/i18n'

import { api, API_BASE, type PageData } from '../../api-client/client'
import { tokenStore } from '../../api-client/token-store'

/**
 * AI 助手。
 *
 * ⚠️ 接口前缀是 **`/api/v1/ai`** —— 这个插件是**应用级**（`plugin.toml` 里
 * `[app] router = ["v1"]`），自己挂在 v1 下，不像 notification 那样被塞进 `/sys`。
 *
 * ⚠️ id 全是雪花字符串，不要 `Number()`（CLAUDE.md 硬纪律 6）。
 */
export type Conversation = {
  id: string
  title: string
  provider_id: string | null
  created_time: string
  updated_time: string | null
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls: string | null
  created_time: string
}

export type AiTool = {
  name: string
  description: string
  domain: string
  perm: string | null
  mutating: boolean
  parameters: Record<string, unknown>
}

/**
 * SSE 事件。**和后端 `plugin/ai/core/events.py` 一一对应**，改一边要改另一边。
 *
 * 🔴 它刻意不是某个模型厂商的原生事件格式：直接透传 OpenAI 的 chunk，
 * 前端就和那个引擎绑死了，换引擎要连前端一起改（见 issue #104 的可插拔设计）。
 */
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call_id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_result'
      call_id: string
      name: string
      ok: boolean
      summary: string
      /** 这次调用要求的权限码；界面上的「执行轨迹」要显示它 */
      perm: string | null
      duration_ms: number | null
    }
  | { type: 'confirm_required'; token: string; name: string; preview: string; arguments: Record<string, unknown> }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number }
  | { type: 'error'; message: string; code: string | null }
  | { type: 'done'; message_id: string | null }

export const aiKeys = {
  all: ['ai'] as const,
  conversations: () => [...aiKeys.all, 'conversations'] as const,
  messages: (id: string) => [...aiKeys.all, 'messages', id] as const,
  tools: () => [...aiKeys.all, 'tools'] as const,
}

export function conversationsQuery() {
  return queryOptions({
    queryKey: aiKeys.conversations(),
    queryFn: () => api.GET<PageData<Conversation>>('/api/v1/ai/conversations?page=1&size=50'),
  })
}

export function messagesQuery(conversationId: string | undefined) {
  return queryOptions({
    queryKey: aiKeys.messages(conversationId ?? ''),
    queryFn: () => api.GET<ChatMessage[]>(`/api/v1/ai/conversations/${conversationId}/messages`),
    enabled: !!conversationId,
  })
}

export function toolsQuery() {
  return queryOptions({
    queryKey: aiKeys.tools(),
    queryFn: () => api.GET<AiTool[]>('/api/v1/ai/tools'),
  })
}

export function useCreateConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (title: string) => api.POST<Conversation>('/api/v1/ai/conversations', { body: { title } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.conversations() }),
  })
}

export function useDeleteConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/ai/conversations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.conversations() }),
  })
}

export function useRenameConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.PUT(`/api/v1/ai/conversations/${id}`, { body: { title } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.conversations() }),
  })
}

/**
 * 消费一条 SSE 流。
 *
 * 🔴 **不能用 `EventSource`**：它只发 GET、且带不了 `Authorization` 头。
 * 只能 `fetch` + 读 `response.body`。
 *
 * 🔴 **也不能走 `api.POST`**：那条路会把响应体当 JSON 整体解析，
 * 流式的意义（边出边显示）就没了。这是**唯一**允许绕开 `api-client` 的地方，
 * 而它绕开的代价是 401 自动刷新在这条路上不生效 —— 所以下面显式处理了 401。
 */
export async function streamChat(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = tokenStore.get()
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    credentials: 'include',
    signal,
  })

  if (!response.ok) {
    // 401 在这条路上不会被自动刷新（见上），所以要给一句人能懂的话。
    // 不这么做的话表现是「点发送没反应」——硬纪律 9 说的正是这个。
    onEvent({
      type: 'error',
      message:
        response.status === 401
          ? t('登录已过期，请刷新页面重新登录')
          : response.status === 429
            ? // 对话按人限流（`AI_CHAT_RATE_PER_MINUTE`）：说成「请求失败（HTTP 429）」的话，人会以为是系统坏了
              t('发得太快了，请 {{seconds}} 秒后再发', { seconds: response.headers.get('Retry-After') ?? '60' })
            : t('请求失败（HTTP {{status}}）', { status: response.status }),
      code: String(response.status),
    })
    return
  }
  if (!response.body) {
    onEvent({ type: 'error', message: t('当前浏览器不支持流式响应'), code: 'no_stream' })
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // 一帧以空行结束。⚠️ 必须按 `\n\n` 切而不是按行切：
    // 一次 read 拿到的可能是半帧，按行切会把半个 JSON 交给 parse
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as AgentEvent)
      } catch {
        // 坏帧跳过就好：丢一帧增量文本远好过整个对话崩掉
      }
    }
  }
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { aiKeys, messagesQuery, streamChat, useRenameConversation, type AgentEvent } from './api'
import type { Bubble, ToolTrace } from './message'

/** 解析落库的执行轨迹。坏数据一律当成"没有轨迹"，不能让它把整条历史渲染崩掉 */
function parseTraces(raw: string | null): ToolTrace[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    return parsed.map((t) => ({
      name: String(t.name ?? ''),
      ok: !!t.ok,
      perm: t.perm ?? null,
      durationMs: typeof t.duration_ms === 'number' ? t.duration_ms : null,
    }))
  } catch {
    return undefined
  }
}

/** 会话默认标题。首条消息发出后会被替换掉，所以它只在"刚建好还没说话"那一瞬出现 */
export const DEFAULT_CONVERSATION_TITLE = '新对话'

/**
 * 用首条用户消息给会话命名。
 *
 * 🔴 不做这一步的代价实测过：一屏 45 条会话**全都叫「新对话」**，
 * 唯一的区分是第二行的时间戳 —— 那份列表等于没有。
 * 命名发生在前端而不是后端，是因为它只需要那句话的前几个字，
 * 为此往返一次（或者让模型再生成一个标题）都不划算。
 */
export function deriveTitle(text: string): string {
  // 只取第一行：粘一整段进来时，第一行通常就是那句话本身
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  const compact = line.replace(/\s+/g, ' ')
  if (!compact) return DEFAULT_CONVERSATION_TITLE
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact
}

/**
 * 一次对话会话的全部运行时逻辑：历史回放、流式收帧、发送、二次确认。
 *
 * 🔴 **抽成 hook 是为了让整页和抽屉共用同一份。** 这里面最容易写错的是
 * SSE 收帧那段（哪个事件改哪一条气泡、pending 什么时候落下、错误怎么显示），
 * 抄成两份的话，改一处忘另一处的代价是"抽屉里能用、整页里不能"这种
 * 极难复现的差异。
 */
export function useChatSession(
  conversationId: string | undefined,
  /**
   * 还没有会话时用来现建一个，返回新会话 ID。
   *
   * 🔴 放在这一层而不是各个入口自己写：整页用 URL（`onSearchChange`）、抽屉用
   * store，两边"建会话"的做法不一样，但"没有会话就先建一个再发"这条**行为**
   * 必须一样。抄成两份的下场见这个文件顶上那段注释。
   */
  ensureConversation?: () => Promise<string | undefined>,
) {
  const qc = useQueryClient()
  const rename = useRenameConversation()
  const [bubbles, setBubbles] = React.useState<Bubble[]>([])
  const [streaming, setStreaming] = React.useState(false)
  // 🔴 单飞：StrictMode 双跑 + 用户连点两次发送都会打两条流（硬纪律 10）
  const inFlight = React.useRef(false)

  const historyQuery = useQuery(messagesQuery(conversationId))

  // ⚠️ 依赖只放 `historyQuery.data`：放整个 query 对象会让每次后台 refetch
  // 都把用户正在看的流式内容冲掉
  React.useEffect(() => {
    if (!historyQuery.data) return
    // 🔴 正在流式产出时不接受历史覆盖。新建会话后立刻发第一条消息时，
    // 那个新会话的历史（空数组）会在流跑到一半时返回 —— 不挡住的话
    // 用户刚打的那句话和已经出来的半截回答会当场消失，而且只在
    // "首条消息"这一条路径上发生，极难复现
    if (inFlight.current) return
    setBubbles(
      historyQuery.data.map((m) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        tools: parseTraces(m.tool_calls),
      })),
    )
  }, [historyQuery.data])

  const applyEvent = React.useCallback((event: AgentEvent) => {
    setBubbles((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (!last || last.role !== 'assistant') return prev
      switch (event.type) {
        case 'delta':
          next[next.length - 1] = { ...last, content: last.content + event.text }
          break
        case 'tool_result':
          next[next.length - 1] = {
            ...last,
            tools: [
              ...(last.tools ?? []),
              { name: event.name, ok: event.ok, perm: event.perm, durationMs: event.duration_ms },
            ],
          }
          break
        case 'confirm_required':
          next[next.length - 1] = {
            ...last,
            confirm: { token: event.token, name: event.name, preview: event.preview },
          }
          break
        case 'error':
          // 失败必须是可见状态，不是「没下文」（硬纪律 9）
          next[next.length - 1] = { ...last, content: `${last.content}\n\n> ⚠️ ${event.message}`, pending: false }
          break
        case 'done':
          next[next.length - 1] = { ...last, pending: false }
          break
        default:
          break
      }
      return next
    })
  }, [])

  const send = React.useCallback(
    async (text: string) => {
      const content = text.trim()
      if (!content || inFlight.current) return

      // 没有会话就现建一个。⚠️ 用返回的 id 直接发，不等 URL/store 回流再发 ——
      // 等的话要跨一次渲染，中间那个空档正是上面那条"历史把流冲掉"的窗口
      let id = conversationId
      if (!id) id = await ensureConversation?.()
      if (!id) return

      inFlight.current = true
      setStreaming(true)
      // 首条消息 = 给这个会话命名。判据是"当前一条气泡都没有"，
      // ⚠️ 要在 setBubbles 之前算：那之后 bubbles 里已经有两条了
      const isFirstMessage = bubbles.length === 0
      setBubbles((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: 'user', content },
        { id: `a-${Date.now()}`, role: 'assistant', content: '', pending: true },
      ])
      // 不 await：命名失败不该挡住对话本身（标题只是列表上的一个便利）
      if (isFirstMessage) rename.mutate({ id, title: deriveTitle(content) })
      try {
        await streamChat('/api/v1/ai/chat/stream', { conversation_id: id, content }, applyEvent)
      } finally {
        inFlight.current = false
        setStreaming(false)
        qc.invalidateQueries({ queryKey: aiKeys.messages(id) })
        qc.invalidateQueries({ queryKey: aiKeys.conversations() })
      }
    },
    [applyEvent, bubbles.length, conversationId, ensureConversation, qc, rename],
  )

  const confirmTool = useMutation({
    mutationFn: async (token: string) => {
      await streamChat('/api/v1/ai/chat/tools/confirm', { token }, applyEvent)
    },
  })

  return { bubbles, streaming, send, confirmTool, historyQuery }
}

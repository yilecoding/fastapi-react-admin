import { t } from '@admin/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { aiKeys, messagesQuery, streamChat, useRenameConversation, type AgentEvent } from './api'
import type { Bubble, ConfirmCard, ConfirmOutcome, ToolTrace } from './message'

/** 报错在气泡里的样子。流式时和从历史还原时必须是同一个样子，否则刷新一下报错就「变了」 */
const errorLine = (message: string) => `\n\n> ⚠️ ${message}`

/**
 * 解析落库的 `tool_calls`：这一轮界面上出现过的东西（后端 `chat_service._load_items`）。
 * 没有 `kind` 的是执行轨迹（老数据就是这个形状）；`confirm` 是确认卡片；`error` 是这一轮的报错。
 *
 * 🔴 卡片和报错必须从这里还原。原来只存轨迹，流一结束前端重拉历史，确认卡片当场被冲掉 ——
 * 网页上的 AI 写操作**一个都确认不了**（实测）。坏数据一律当成「没有」，不能把整条历史渲染崩掉
 */
function parseTurnItems(raw: string | null): { tools?: ToolTrace[]; confirms?: ConfirmCard[]; errors: string[] } {
  const out: { tools?: ToolTrace[]; confirms?: ConfirmCard[]; errors: string[] } = { errors: [] }
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  const tools: ToolTrace[] = []
  const confirms: ConfirmCard[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    if (item.kind === 'confirm') {
      if (!item.token) continue
      confirms.push({
        token: String(item.token),
        name: String(item.name ?? ''),
        preview: String(item.preview ?? ''),
        outcome: item.outcome === 'done' || item.outcome === 'failed' ? item.outcome : undefined,
        detail: item.detail ? String(item.detail) : undefined,
      })
    } else if (item.kind === 'error') {
      if (item.message) out.errors.push(String(item.message))
    } else {
      tools.push({
        name: String(item.name ?? ''),
        ok: !!item.ok,
        perm: item.perm ?? null,
        durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : null,
      })
    }
  }
  if (tools.length) out.tools = tools
  if (confirms.length) out.confirms = confirms
  return out
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
    setBubbles((prev) => {
      // 本地已经有结论的卡片（刚点完确认）以本地为准：「已过期」只有前端知道，后端找不到令牌也就写不回去
      const local = new Map(prev.flatMap((b) => b.confirms ?? []).map((c) => [c.token, c]))
      return historyQuery.data.map((m) => {
        const { tools, confirms, errors } = parseTurnItems(m.tool_calls)
        return {
          id: m.id,
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content + errors.map(errorLine).join(''),
          tools,
          confirms: confirms?.map((c) => (c.outcome || !local.get(c.token)?.outcome ? c : { ...c, ...local.get(c.token) })),
        }
      })
    })
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
            confirms: [...(last.confirms ?? []), { token: event.token, name: event.name, preview: event.preview }],
          }
          break
        case 'error':
          // 失败必须是可见状态，不是「没下文」（硬纪律 9）
          next[next.length - 1] = { ...last, content: last.content + errorLine(event.message), pending: false }
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

  // 确认之后把结果记到那张卡片上（见 `Bubble.confirm.outcome`）：只记**服务端给了结论**的那几种 ——
  // 成功 = 工具结果 ok；失败 = 工具结果不 ok、流里报了错；过期 = 令牌用过了或过期了（不一定没执行）。
  // 🔴 请求没送到（断网 / HTTP 层就被拒了：401 / 429 / 网关 5xx）不记：令牌还没动过，按钮要留着让人再点。
  // 原来一律记成「没执行成功」、按钮也没了，令牌明明还能用，只能让 AI 重新发起一次
  const settle = React.useCallback((token: string, outcome: ConfirmOutcome, detail?: string) => {
    setBubbles((prev) =>
      prev.map((b) =>
        b.confirms?.some((c) => c.token === token)
          ? { ...b, confirms: b.confirms.map((c) => (c.token === token ? { ...c, outcome, detail } : c)) }
          : b,
      ),
    )
  }, [])
  const confirmTool = useMutation({
    mutationFn: async (token: string) => {
      let outcome: ConfirmOutcome | undefined
      let detail: string | undefined
      await streamChat('/api/v1/ai/chat/tools/confirm', { token }, (event) => {
        if (event.type === 'tool_result') {
          outcome = event.ok ? 'done' : 'failed'
          detail = event.detail ?? undefined
        }
        // `streamChat` 把 HTTP 层的失败也报成 error 事件，code 是状态码 —— 那是没送到，不是结论
        if (event.type === 'error' && !/^\d+$/.test(event.code ?? '')) {
          outcome = event.code === 'confirm_expired' ? 'expired' : 'failed'
        }
        applyEvent(event)
      })
      return { outcome, detail }
    },
    onSuccess: ({ outcome, detail }, token) => {
      if (outcome) settle(token, outcome, detail)
    },
    // 连接断了：可能根本没送到，也可能执行到一半断开。再点一次是安全的 —— 令牌一次性，执行过的只会回「已经用过」
    onError: () =>
      applyEvent({ type: 'error', message: t('连接断了，可以再点一次确认（执行过的不会重复执行）'), code: 'network' }),
  })

  return { bubbles, streaming, send, confirmTool, historyQuery }
}

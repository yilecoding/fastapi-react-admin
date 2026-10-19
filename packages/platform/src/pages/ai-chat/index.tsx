import { useQuery } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { IconSparkles } from '@tabler/icons-react'
import * as React from 'react'

import { QueryError } from '@admin/ui/components/query-error'

import { conversationsQuery, toolsQuery, useCreateConversation, useDeleteConversation } from './api'
import { Composer } from './composer'
import { ConversationList } from './conversation-list'
import { MessageBubble } from './message'
import { buildSuggestions } from './suggestions'
import { DEFAULT_CONVERSATION_TITLE, useChatSession } from './use-chat-session'

export type AiChatSearch = {
  /** 当前会话 ID。**进 URL**（硬纪律 2）：刷新 / 多页签都要能回到同一个会话 */
  c?: string
}

/**
 * 首屏。
 *
 * 🔴 **它和输入区是同一块，不是上下两块。** 上一版空态是 `h-full` + 居中，
 * 输入框另起一行钉在底部 —— 实测的样子是：上面一屏内容居中飘着，
 * 下面 600px 白，再下面一个孤零零的输入框。两个东西各自居中，合起来谁也不居中。
 *
 * 现在改成"标题 → 输入框 → 建议"竖着一条，整条一起在竖直方向居中：
 * 用户的视线落点（我要在哪打字）和第一个动作（点一条建议）之间没有空洞。
 */
function FirstRun({
  suggestions,
  onPick,
  composer,
}: {
  suggestions: string[]
  onPick: (q: string) => void
  composer: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-3xl">
        <div className="mb-5 text-center">
          <div className="mx-auto flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
            <IconSparkles className="size-5 text-primary" />
          </div>
          <h2 className="mt-3 text-lg font-medium tracking-tight">{t('问点关于这套系统的事')}</h2>
          <p className="mx-auto mt-1.5 max-w-lg text-sm text-balance text-muted-foreground">
            <Trans
              t={t}
              i18nKey="它会调用你<b>有权限</b>的那些工具去查真实数据，每一次调用都记在「调用日志」里。"
              components={{ b: <strong className="font-medium text-foreground" /> }}
            />
          </p>
        </div>

        {composer}

        {suggestions.length ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onPick(q)}
                className="rounded-xl border bg-card px-3.5 py-2.5 text-start text-sm transition-colors hover:border-primary/40 hover:bg-accent/50"
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AiChatPage({
  search = {},
  onSearchChange,
}: {
  search?: AiChatSearch
  onSearchChange?: (next: AiChatSearch) => void
}) {
  const conversationId = search.c
  const [input, setInput] = React.useState('')
  const bottomRef = React.useRef<HTMLDivElement>(null)

  const listQuery = useQuery(conversationsQuery())
  const toolsQ = useQuery(toolsQuery())
  const createConversation = useCreateConversation()
  const deleteConversation = useDeleteConversation()
  /** 没有会话时现建一个，并把地址栏切过去。返回 id 给 hook 直接发这条消息 */
  const ensureConversation = React.useCallback(async () => {
    const conversation = await createConversation.mutateAsync(DEFAULT_CONVERSATION_TITLE)
    onSearchChange?.({ c: conversation.id })
    return conversation.id
  }, [createConversation, onSearchChange])

  // 整页和抽屉共用同一份对话逻辑，见 `use-chat-session.ts` 的注释
  const { bubbles, streaming, send, confirmTool, historyQuery } = useChatSession(conversationId, ensureConversation)

  const conversations = listQuery.data?.items ?? []
  const suggestions = React.useMemo(() => buildSuggestions(toolsQ.data), [toolsQ.data])

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [bubbles])

  /** 侧栏那个「+ 新建」：只建空会话、不发消息 */
  function startNew() {
    void ensureConversation()
  }

  function submit(text: string) {
    if (!text.trim()) return
    setInput('')
    // 🔴 没有会话时由 `send` 自己去建（`ensureConversation`），页面不做这件事。
    // 上一版是「没有会话就只建会话」，**用户打的那句话被丢掉了** ——
    // 点一张建议卡片的表现是：右边多了个空会话，什么也没发生。
    void send(text)
  }

  if (listQuery.error) return <QueryError error={listQuery.error} onRetry={() => listQuery.refetch()} />

  /* 🔴 `!conversationId` 这一项不能省。`messagesQuery` 是 `enabled: !!conversationId`，
     而 **disabled 的 query 会永远停在 `isPending: true`** —— 少了它，
     「还没选会话」这个状态里 `showEmpty` 恒为 false，首屏永远不出现，
     用户看到的是一整块白 + 一个孤零零的输入框。上一版就是这样，而且
     因为空状态组件本身写得好好的，完全看不出是哪里没接上。
     同 pages 分册里 `listState(q, { enabled })` 那条，一模一样的坑。 */
  const showEmpty = !conversationId || (bubbles.length === 0 && !historyQuery.isPending && !historyQuery.error)

  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSend={() => submit(input)}
      disabled={createConversation.isPending}
      streaming={streaming}
      toolCount={toolsQ.data?.length}
    />
  )

  return (
    /* `py-3`：左栏是带边框的卡片，不给上下留白它会死贴标签栏和窗口底边 ——
       而全站别的页面第一个可见元素距框顶约 24px（实测），只有这一页是 0，
       所以那条边框看起来像被"卡住"了 */
    <div className="flex h-full flex-col gap-4 py-3 content-scroll:min-h-0 lg:flex-row">
      <ConversationList
        conversations={conversations}
        activeId={conversationId}
        loading={listQuery.isPending}
        creating={createConversation.isPending}
        onSelect={(id) => onSearchChange?.({ c: id })}
        onCreate={startNew}
        onDelete={(id) => deleteConversation.mutate(id)}
      />

      <section className="flex min-w-0 flex-1 flex-col content-scroll:lg:min-h-0">
        {historyQuery.error ? (
          <div className="mx-auto w-full max-w-3xl px-4 pt-4">
            <QueryError error={historyQuery.error} onRetry={() => historyQuery.refetch()} />
          </div>
        ) : showEmpty ? (
          <FirstRun
            suggestions={suggestions}
            onPick={submit}
            composer={composer}
          />
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {/* 🔴 `mt-auto` 是这一版最要紧的一行：消息要**贴着输入框往上堆**。
                  少了它，一两条消息时这块从顶部开始排，底下空出一屏高的白 ——
                  上一版实测就是一条用户消息孤零零挂在右上角、下面 600px 全白。

                  🔴 `w-full` 同样不能省。父级是 column flex，而 flex 项上的 auto
                  外边距会**取消 stretch**，盒子退化成按内容定宽 —— 于是每条消息的
                  左边界都跟着自己的内容长度移动（实测短内容 711px、输入区 768px）。
                  表现就是"有些居中有些不居中"。 */}
              <div className="mx-auto mt-auto w-full max-w-3xl space-y-6 px-4 py-5">
                {bubbles.map((b) => (
                  <MessageBubble
                    key={b.id}
                    bubble={b}
                    confirming={confirmTool.isPending}
                    onConfirm={(token) => confirmTool.mutate(token)}
                  />
                ))}
              </div>
              <div ref={bottomRef} />
            </div>

            <div className="shrink-0 px-4 pb-1">{composer}</div>
          </>
        )}
      </section>
    </div>
  )
}

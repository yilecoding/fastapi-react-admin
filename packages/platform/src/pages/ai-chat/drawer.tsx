import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconChevronDown, IconExternalLink, IconRobot, IconX } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'

import { usePreferences } from '../../shell/preferences'
import { conversationsQuery, toolsQuery, useCreateConversation } from './api'
import { Composer } from './composer'
import { useAiDrawerStore } from './drawer-store'
import { MessageBubble } from './message'
import { buildSuggestions } from './suggestions'
import { DEFAULT_CONVERSATION_TITLE, useChatSession } from './use-chat-session'

const MIN_WIDTH = 320
/** 上限按视口算：拖到盖住整屏就没法"边看边问"了，那正是抽屉存在的理由 */
const maxWidth = () => Math.min(880, Math.round(window.innerWidth * 0.6))

/** 顶栏入口。和铃铛一样是**外壳家具**，不是标签页 —— 别注册进 page-registry */
export function AiDrawerTrigger() {
  const { t } = useTranslation()
  const toggle = useAiDrawerStore((s) => s.toggle)
  const open = useAiDrawerStore((s) => s.open)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={t('AI 助手')} aria-expanded={open} onClick={toggle}>
            <IconRobot className="size-4" />
          </Button>
        }
      />
      <TooltipContent>{t('AI 助手')}</TooltipContent>
    </Tooltip>
  )
}

/**
 * 右侧滑出的 AI 抽屉。
 *
 * 🔴 **刻意不用 `Sheet`**：Sheet 是模态的（自带 Backdrop + 焦点陷阱），
 * 打开之后就没法一边看着表格一边问 —— 而"在用户管理页看着数据顺手问一句"
 * 正是这个抽屉存在的理由。所以这里是个**非模态**面板：不挡交互、不锁焦点，
 * 只用 Esc 关闭。代价是焦点管理要自己想，收益是它真的能当副驾用。
 */
export function AiDrawer() {
  const { t } = useTranslation()
  const open = useAiDrawerStore((s) => s.open)
  const setOpen = useAiDrawerStore((s) => s.setOpen)
  const conversationId = useAiDrawerStore((s) => s.conversationId)
  const setConversationId = useAiDrawerStore((s) => s.setConversationId)
  const width = usePreferences((s) => s.aiDrawerWidth)
  const patch = usePreferences((s) => s.patch)

  const [input, setInput] = React.useState('')
  const [dragging, setDragging] = React.useState(false)
  const bottomRef = React.useRef<HTMLDivElement>(null)

  const listQuery = useQuery({ ...conversationsQuery(), enabled: open })
  const toolsQ = useQuery({ ...toolsQuery(), enabled: open })
  const createConversation = useCreateConversation()
  /** 没有会话时现建一个，返回 id 给 hook 直接发 —— 和整页同一条行为，见 hook 里的注释 */
  const ensureConversation = React.useCallback(async () => {
    const conversation = await createConversation.mutateAsync(DEFAULT_CONVERSATION_TITLE)
    setConversationId(conversation.id)
    return conversation.id
  }, [createConversation, setConversationId])

  const { bubbles, streaming, send, confirmTool } = useChatSession(conversationId, ensureConversation)

  const conversations = listQuery.data?.items ?? []
  const suggestions = React.useMemo(() => buildSuggestions(toolsQ.data, 3), [toolsQ.data])
  const activeTitle = conversations.find((c) => c.id === conversationId)?.title

  // 打开时若还没有会话，自动挑最近一条 —— 让人一开就能问，而不是先点一次"新建"。
  // ⚠️ 依赖用 `latestId` 而不是 `conversations` 数组：后者每次渲染都是新引用
  // （`?? []` 的兜底），会让这个 effect 每帧都重跑
  const latestId = conversations[0]?.id
  React.useEffect(() => {
    if (open && !conversationId && latestId) setConversationId(latestId)
  }, [open, conversationId, latestId, setConversationId])

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [bubbles])

  // Esc 关闭。非模态面板没有焦点陷阱，这条是唯一的键盘出口
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // 拖拽改宽度。监听挂在 window 上而不是手柄上 —— 挂手柄的话鼠标一旦移出
  // 那 4px 宽的区域就丢事件，表现是"拖着拖着突然不跟手了"
  React.useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const next = Math.min(maxWidth(), Math.max(MIN_WIDTH, window.innerWidth - e.clientX))
      patch({ aiDrawerWidth: next })
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // 拖拽时禁掉文本选中，否则整页文字会被一路刷蓝
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
  }, [dragging, patch])

  /** 头部那个「新建」：只建空会话、不发消息 */
  function startNew() {
    void ensureConversation()
  }

  if (!open) return null

  return (
    <aside
      role="complementary"
      aria-label={t('AI 助手')}
      className="fixed inset-y-0 end-0 z-40 flex flex-col border-s bg-background shadow-lg"
      style={{ width }}
    >
      {/* 拖拽手柄：4px 命中区，hover 才显色，不抢视觉 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整宽度')}
        onMouseDown={() => setDragging(true)}
        className={`absolute inset-y-0 -start-0.5 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30 ${
          dragging ? 'bg-primary/40' : ''
        }`}
      />

      {/* 🔴 `h-12` 必须和外壳顶栏**完全一致**（`routes/_auth.tsx` 也是 h-12）。
          抽屉是全高的，它的底边线和顶栏底边线会并排出现在同一个视野里 ——
          差一点点就是两条错开的平行线，看着就是糙。
          实测踩过：这里原来是 `py-2`（算出来 45px），和顶栏的 48px 差 3px。 */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <IconRobot className="size-4 shrink-0 text-primary" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="h-8 min-w-0 flex-1 justify-start gap-1 px-2">
                <span className="truncate text-sm">{activeTitle ?? t('选择会话')}</span>
                <IconChevronDown className="size-3.5 shrink-0 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
            {conversations.map((c) => (
              <DropdownMenuItem key={c.id} onClick={() => setConversationId(c.id)}>
                <span className="truncate">{c.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" className="h-8 px-2" onClick={startNew} disabled={createConversation.isPending}>
          {t('新建')}
        </Button>
        {/* 在整页打开：抽屉适合顺手问一句，长对话/要看历史还是整页舒服。
            带上当前会话 ID，两边看的是同一段对话。
            用 `<Link>` 不用 `useNavigate()` —— 全站页面组件的统一做法（同铃铛）。 */}
        {conversationId ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  to="/ai/chat"
                  search={{ c: conversationId }}
                  onClick={() => setOpen(false)}
                  aria-label={t('在整页打开')}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <IconExternalLink className="size-4" />
                </Link>
              }
            />
            <TooltipContent>{t('在整页打开')}</TooltipContent>
          </Tooltip>
        ) : null}
        <Button variant="ghost" size="icon" className="size-8" aria-label={t('关闭')} onClick={() => setOpen(false)}>
          <IconX className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
        {bubbles.length === 0 ? (
          <div className="space-y-2 pt-6">
            <p className="text-center text-xs text-muted-foreground">{t('问点关于这套系统的事')}</p>
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void send(q)}
                className="w-full rounded-lg border px-3 py-2 text-start text-xs transition-colors hover:border-primary/40 hover:bg-accent/50"
              >
                {q}
              </button>
            ))}
          </div>
        ) : (
          /* `mt-auto`：消息贴着输入框往上堆。少了它，抽屉里一两条消息会挂在
             顶部、下面空一大片 —— 和整页那条是同一个问题，见 `index.tsx` */
          <div className="mt-auto space-y-5">
            {bubbles.map((b) => (
              <MessageBubble
                key={b.id}
                bubble={b}
                confirming={confirmTool.isPending}
                onConfirm={(token) => confirmTool.mutate(token)}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-3 pb-3">
        <Composer
          value={input}
          onChange={setInput}
          onSend={() => {
            void send(input)
            setInput('')
          }}
          disabled={createConversation.isPending}
          streaming={streaming}
          toolCount={toolsQ.data?.length}
        />
      </div>
    </aside>
  )
}

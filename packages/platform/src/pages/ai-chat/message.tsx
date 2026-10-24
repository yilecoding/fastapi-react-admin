import { IconAlertTriangle, IconCheck, IconSparkles, IconX } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'

import { Markdown } from './markdown'

/** 一次工具调用在界面上的痕迹 */
export type ToolTrace = {
  name: string
  ok: boolean
  perm: string | null
  durationMs: number | null
}

export type Bubble = {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  tools?: ToolTrace[]
  /**
   * 写操作的确认卡片。`outcome`：点了确认之后的结果 —— 🔴 不记的话卡片原样留着、按钮又能点了，
   * 再点一次只会拿到「已过期」（令牌是一次性的），看起来像「刚才没执行」
   */
  confirm?: { token: string; name: string; preview: string; outcome?: ConfirmOutcome }
}

/** `expired`：令牌用过了或过期了 —— 可能是别处已经执行过，所以不说「没执行」 */
export type ConfirmOutcome = 'done' | 'failed' | 'expired'


/**
 * 执行轨迹 —— 这一页的**签名元素**。
 *
 * 普通聊天框把工具调用藏起来（或者缩成一个灰色小标签）。这里反过来把它摊开成
 * 一块可追溯的审计记录：`工具名 · 权限码 · 耗时`。理由是这个助手的价值前提就是
 * "每个回答都来自一次受权限约束的真实调用"——藏起来，它就退化成一个会编数据的聊天框。
 *
 * 机器标识（工具名 / 权限码）走 `font-mono`：它们是系统里的标识符，不是散文，
 * 排版上就该看得出来。JetBrains Mono 是仓库已有的字体，不新增依赖。
 *
 * ⚠️ 它是**回答的来源**，所以排在正文**上面**、并且自带一个容器 ——
 * 上一版是几行裸文字浮在正文旁边，读起来像日志误入了对话。
 */
function ToolTraces({ traces }: { traces: ToolTrace[] }) {
  const { t } = useTranslation()
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <div className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        {t('查了 {{n}} 次', { n: traces.length })}
      </div>
      <ul className="divide-y divide-border/60">
        {traces.map((trace, i) => (
          <li key={i} className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] leading-5">
            {trace.ok ? (
              <IconCheck className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <IconX className="size-3 shrink-0 text-destructive" />
            )}
            <span className="truncate font-medium text-foreground">{trace.name}</span>
            {trace.perm ? <span className="truncate text-muted-foreground">{trace.perm}</span> : null}
            {trace.durationMs !== null ? (
              <span className="ms-auto shrink-0 tabular-nums text-muted-foreground">{trace.durationMs}ms</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 流式产出但还没出字时的等待态。
 *
 * 用 `shimmer`（见 `ui/src/styles/globals.css`）让**这句话自己**发光，
 * 而不是在旁边摆三个跳动的点：字出来的时候是原地替换，整块不会跳。
 */
function Thinking() {
  const { t } = useTranslation()
  return (
    <p className="shimmer py-0.5 text-sm" aria-label={t('正在生成回复')}>
      {t('正在查…')}
    </p>
  )
}

/** 助手那一侧的身份标记。有它，一屏里「谁在说」不用靠气泡方向去推 */
function AssistantAvatar() {
  return (
    <div
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10"
      aria-hidden
    >
      <IconSparkles className="size-3.5 text-primary" />
    </div>
  )
}

export function MessageBubble({
  bubble,
  onConfirm,
  confirming,
}: {
  bubble: Bubble
  onConfirm: (token: string) => void
  confirming: boolean
}) {
  const { t } = useTranslation()
  if (bubble.role === 'user') {
    // 用户消息靠右、带底色气泡 —— 让「谁在说」一眼可分。
    // 底色用主色淡染而不是 `bg-muted`：页面里别的灰块（卡片、表头、代码块）太多了，
    // 再来一个灰气泡就分不出哪块是"我说的话"。淡染跟着主题色走，换主题不会掉队。
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-primary/15 bg-primary/10 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {bubble.content}
        </div>
      </div>
    )
  }

  return (
    // 头像 + 内容两列。上一版是整块挂一条 `border-s`，那条竖线在一屏里会和
    // 左边会话栏的边框、卡片边框叠成三条平行线；换成头像锚点后这一列干净了
    <div className="group/msg flex gap-3">
      <AssistantAvatar />
      <div className="min-w-0 flex-1 space-y-2">
        {bubble.tools?.length ? <ToolTraces traces={bubble.tools} /> : null}

        {/* 助手回复**不套气泡**：它经常是表格/代码块，套进气泡里会被挤窄 */}
        {bubble.content ? (
          <div className="text-sm">
            <Markdown text={bubble.content} />
          </div>
        ) : bubble.pending ? (
          <Thinking />
        ) : null}

        {bubble.confirm ? (
          <div className="rounded-lg border border-amber-300/70 bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-950/30">
            <div className="flex items-start gap-2">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium">{t('这个操作会改变系统数据')}</p>
                <pre className="overflow-x-auto rounded bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap">
                  {bubble.confirm.preview}
                </pre>
                {bubble.confirm.outcome === 'done' ? (
                  <p className="flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400" data-testid="ai-confirm-done">
                    <IconCheck className="size-4" />
                    {t('已执行')}
                  </p>
                ) : bubble.confirm.outcome === 'failed' ? (
                  <p className="text-sm text-destructive" data-testid="ai-confirm-failed">
                    {t('没执行成功，原因见上面的回复')}
                  </p>
                ) : bubble.confirm.outcome === 'expired' ? (
                  <p className="text-sm text-muted-foreground" data-testid="ai-confirm-expired">
                    {t('这个确认已经用过或过期了，结果以单据 / 页面上的为准')}
                  </p>
                ) : (
                  <Button
                    size="sm"
                    disabled={confirming}
                    onClick={() => onConfirm(bubble.confirm!.token)}
                    data-testid="ai-confirm"
                  >
                    {t('确认执行')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* 回答写完才给复制口。hover 才显形：常驻的话每条回答下面都挂一个按钮，
            一屏下来全是图标；而 `focus-visible:` 那条保证键盘用户仍然够得到 */}
        {bubble.content && !bubble.pending ? (
          <div className="opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
            <CopyButton text={bubble.content} label={t('复制回答')} className="size-7" />
          </div>
        ) : null}
      </div>
    </div>
  )
}

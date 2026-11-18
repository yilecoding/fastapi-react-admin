import type { Bubble } from './message'

/**
 * 一个流式事件要落到哪条助手气泡上：对话流按它自己那条气泡的 id，确认流按卡片的令牌找它所在的气泡。
 *
 * 🔴 **刻意没有「不给就写最后一条」。** 原来确认流就是这么写的（#372）：在会话 A 点确认、流还没结束就切到 B，
 * 工具结果和报错行追加到了 **B** 的最后一条助手气泡上。对话流在 #329 修过同一个问题，确认流那条同形路径漏了。
 * 找不到（气泡已经不在眼前，比如切走了）就返回 -1，调用方丢弃事件 —— 切回来时按历史重建，结论在库里
 */
export type BubbleTarget = { bubbleId: string } | { token: string }

export function targetBubbleIndex(bubbles: readonly Bubble[], target: BubbleTarget): number {
  if ('bubbleId' in target) return bubbles.findIndex((b) => b.id === target.bubbleId)
  return bubbles.findIndex((b) => b.confirms?.some((c) => c.token === target.token))
}

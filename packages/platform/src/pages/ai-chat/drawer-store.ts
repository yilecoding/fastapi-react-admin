import { create } from 'zustand'

/**
 * AI 抽屉的开合。
 *
 * 为什么是 store 而不是 context：呼出它的是顶栏那个按钮，渲染它的是外壳底部，
 * 两者不在同一棵子树上（同 `shell/command-store.ts` 的理由）。
 *
 * ⚠️ 刻意**不持久化**：抽屉开着时刷新页面，恢复出一个盖住半屏的面板是纯粹的困惑。
 * 但**宽度**是持久化的（在 `shell/preferences.ts`）—— 宽度描述"这块屏幕上我想要多宽"，
 * 是设备属性；开没开着是此刻的瞬时状态。两者分开存，见 shell 分册「设备 vs 人」。
 */
type AiDrawerState = {
  open: boolean
  /** 抽屉里当前看的会话；和整页的 URL 参数各自独立 —— 两边可以停在不同会话上 */
  conversationId?: string
  setOpen: (v: boolean) => void
  toggle: () => void
  setConversationId: (id: string | undefined) => void
}

export const useAiDrawerStore = create<AiDrawerState>()((set) => ({
  open: false,
  conversationId: undefined,
  setOpen: (v) => set({ open: v }),
  toggle: () => set((s) => ({ open: !s.open })),
  setConversationId: (id) => set({ conversationId: id }),
}))

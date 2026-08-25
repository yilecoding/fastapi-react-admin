import { create } from 'zustand'

/**
 * 命令面板 / 快捷键帮助的开合。
 *
 * 为什么是 store 而不是 context：呼出它的地方和渲染它的地方不在同一棵子树上 ——
 * 顶栏那个搜索按钮、全局键盘监听、面板自己的条目（「快捷键帮助」那条要
 * 关掉面板再开帮助）三处都要能改这个状态。用 store 就不用把
 * `onOpenChange` 一层层往下传，也不用为此在外壳顶部再包一个 provider。
 *
 * ⚠️ 刻意**不持久化**（对比 `tab-store` / `preferences` 都是 persist 的）：
 * 面板开着的时候刷新页面，恢复出一个盖住整屏的对话框是纯粹的困惑。
 */
type CommandState = {
  open: boolean
  shortcutsOpen: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
  setShortcutsOpen: (v: boolean) => void
}

export const useCommandStore = create<CommandState>()((set) => ({
  open: false,
  shortcutsOpen: false,
  setOpen: (v) => set({ open: v }),
  toggle: () => set((s) => ({ open: !s.open })),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
}))

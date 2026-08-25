import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"

export type Tab = {
  /** 稳定标识：routeId + JSON(params)，不含 search */
  key: string
  /** 完整 URL（含 search），切回时导航用 */
  href: string
  title: string
  routeId: string
  /** 渲染隐藏 tab 时用的 props 快照 */
  snapshot: { params: unknown; search: unknown }
  closable: boolean
  /** 用户手动固定（或路由 staticData 声明）—— 固定的 tab 不给关，且排在最前 */
  pinned: boolean
  /**
   * 「重新加载」的代号。TabOutlet 把它拼进页面组件的 key：
   * 加一 → 组件卸载重挂 → 重新取数。
   * 页面被 `<Activity>` 保活，不换 key 是无论如何刷不掉的。
   */
  revision: number
}

const MAX_TABS = 20

type TabState = {
  tabs: Tab[]
  activeKey: string | null
  open: (
    tab: Omit<Tab, "closable" | "pinned" | "revision"> &
      Partial<Pick<Tab, "closable" | "pinned">>
  ) => void
  close: (key: string) => string | null
  closeOthers: (key: string) => void
  closeLeft: (key: string) => void
  closeRight: (key: string) => void
  closeAll: () => string | null
  /** 清空（换身份时用）—— 连固定的一起清，见下面实现处的注释 */
  reset: () => void
  togglePin: (key: string) => void
  reload: (key: string) => void
  /** 拖拽排序：把 from 挪到 to 的位置。跨固定/非固定分区的拖拽会被拒绝 */
  reorder: (fromKey: string, toKey: string) => void
}

/** 固定的排在前面，其余保持打开顺序 —— 与若依/Vben 的行为一致 */
function sortPinned(tabs: Tab[]): Tab[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]
}

/** 能被关掉的：既没被路由锁死，也没被用户固定 */
export function isRemovable(t: Tab): boolean {
  return t.closable && !t.pinned
}

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeKey: null,

      open: (input) => {
        const { tabs } = get()
        const existing = tabs.findIndex((t) => t.key === input.key)
        if (existing >= 0) {
          // 同一 tab，只更新 href/snapshot（search 变化不开新 tab）
          const next = [...tabs]
          next[existing] = { ...next[existing], href: input.href, snapshot: input.snapshot }
          set({ tabs: next, activeKey: input.key })
          return
        }
        const tab: Tab = {
          closable: input.closable ?? true,
          pinned: input.pinned ?? false,
          ...input,
          revision: 0,
        }
        let next = sortPinned([...tabs, tab])
        // LRU：超上限淘汰最旧的非 pinned、非当前
        if (next.length > MAX_TABS) {
          const victim = next.find((t) => !t.pinned && t.key !== input.key)
          if (victim) next = next.filter((t) => t.key !== victim.key)
        }
        set({ tabs: next, activeKey: input.key })
      },

      close: (key) => {
        const { tabs, activeKey } = get()
        const idx = tabs.findIndex((t) => t.key === key)
        if (idx < 0) return null
        const target = tabs[idx]
        if (!isRemovable(target)) return null
        const next = tabs.filter((t) => t.key !== key)
        let nextActive = activeKey
        if (activeKey === key) {
          const neighbour = next[idx] ?? next[idx - 1] ?? null
          nextActive = neighbour?.key ?? null
        }
        set({ tabs: next, activeKey: nextActive })
        return nextActive
      },

      closeOthers: (key) => {
        const { tabs } = get()
        set({ tabs: tabs.filter((t) => t.key === key || !isRemovable(t)), activeKey: key })
      },

      closeLeft: (key) => {
        const { tabs } = get()
        const idx = tabs.findIndex((t) => t.key === key)
        if (idx < 0) return
        set({ tabs: tabs.filter((t, i) => i >= idx || !isRemovable(t)), activeKey: key })
      },

      closeRight: (key) => {
        const { tabs } = get()
        const idx = tabs.findIndex((t) => t.key === key)
        if (idx < 0) return
        set({ tabs: tabs.filter((t, i) => i <= idx || !isRemovable(t)), activeKey: key })
      },

      closeAll: () => {
        const { tabs } = get()
        const keep = tabs.filter((t) => !isRemovable(t))
        const nextActive = keep[0]?.key ?? null
        set({ tabs: keep, activeKey: nextActive })
        return nextActive
      },

      /**
       * 清空全部标签页。
       *
       * 🔴 和 `closeAll` 不是一件事：`closeAll` 保留固定的（用户的意图是
       * 「收拾桌面」），这个是**换身份**用的 —— 上一个账号固定的页面，
       * 对下一个账号可能连权限都没有，一条都不能留。
       *
       * 调用方在 `auth/session.ts` 的 `login()` / `logout()`（理由见那里）。
       */
      reset: () => set({ tabs: [], activeKey: null }),

      togglePin: (key) => {
        const { tabs } = get()
        const target = tabs.find((t) => t.key === key)
        // 路由声明的常驻页（closable=false，如仪表盘）不给取消固定 —— 它本来就关不掉
        if (!target || !target.closable) return
        set({
          tabs: sortPinned(tabs.map((t) => (t.key === key ? { ...t, pinned: !t.pinned } : t))),
        })
      },

      reload: (key) => {
        const { tabs } = get()
        set({
          tabs: tabs.map((t) => (t.key === key ? { ...t, revision: (t.revision ?? 0) + 1 } : t)),
        })
      },

      reorder: (fromKey, toKey) => {
        if (fromKey === toKey) return
        const { tabs } = get()
        const from = tabs.findIndex((t) => t.key === fromKey)
        const to = tabs.findIndex((t) => t.key === toKey)
        if (from < 0 || to < 0) return
        // 固定的永远在前面 —— 跨区拖拽直接忽略。否则 sortPinned 会把它弹回原位，
        // 表现成「拖了没反应」，不如一开始就不接受
        if (tabs[from].pinned !== tabs[to].pinned) return
        const next = [...tabs]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        set({ tabs: next })
      },
    }),
    {
      name: "admin:tabs",
      // 多页签是「会话」概念：新开浏览器窗口应当是干净的
      storage: createJSONStorage(() => sessionStorage),
    }
  )
)

/** tab key = routeId + params（不含 search） */
export function makeTabKey(routeId: string, params: unknown) {
  const p = params && Object.keys(params as object).length ? JSON.stringify(params) : ""
  return p ? `${routeId}|${p}` : routeId
}

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"

export type Tab = {
  /** 稳定标识：routeId + JSON(params)，不含 search */
  key: string
  /** 完整 URL（含 search），切回时导航用 */
  href: string
  title: string
  routeId: string
  /**
   * 路由 `staticData.icon`。只给**不进侧边栏**的页面兜底 —— 页签图标照旧先按路径查菜单树，
   * 查不到才用它（原来查不到就是一个圆点，比如开放接口日志，#210）
   */
  icon?: string
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
  /**
   * 最近一次被切到前台的序号（单调递增，不是时间戳 —— 同一毫秒里切两次也分得出先后）。
   * 超上限时淘汰它最小的那个。老版本存进 sessionStorage 的页签没有这个字段，按 0 算（最先被淘汰，
   * 同为 0 时按打开顺序）
   */
  lastUsed?: number
}

const MAX_TABS = 20

/** 下一个「最近使用」序号 */
function nextStamp(tabs: Tab[]): number {
  return tabs.reduce((m, t) => Math.max(m, t.lastUsed ?? 0), 0) + 1
}

/**
 * 超上限时淘汰谁：**最久没用过的**非固定页签（不是最早打开的）。
 *
 * 🔴 原来注释写着 LRU，实现是 `find(!pinned)` —— 数组里第一个非固定项，也就是最早**打开**的（#405）。
 * 开满 20 个时，正在最早打开的那一页里填抽屉、从侧边栏点开另一页查东西，刚才那一页被卸载，
 * 表单没了，没有任何提示。store 里原来压根没有「最近使用」的记录。
 */
export function pickVictim(tabs: Tab[], keep: string): Tab | undefined {
  let victim: Tab | undefined
  for (const t of tabs) {
    if (!isRemovable(t) || t.key === keep) continue
    if (!victim || (t.lastUsed ?? 0) < (victim.lastUsed ?? 0)) victim = t
  }
  return victim
}

type TabState = {
  ownerId: string | null
  bindOwner: (userId: string | null) => void
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
  /**
   * 后台页签改了自己的 search（请求回来之后才写 URL 的那种）：只更新快照和 href，不碰地址栏。
   * 切回来时按新的 href 导航，URL 自然跟上。见 `tab-outlet.tsx` 的 `onSearchChange`
   */
  setSearch: (key: string, search: unknown, href: string) => void
  /** 拖拽排序：把 from 插到 to 的前侧或后侧。跨固定/非固定分区的拖拽会被拒绝 */
  reorder: (fromKey: string, toKey: string, side: 'start' | 'end') => void
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
      ownerId: null,
      bindOwner: (userId) => {
        if (get().ownerId !== userId) set({ ownerId: userId, tabs: [], activeKey: null })
      },
      tabs: [],
      activeKey: null,

      open: (input) => {
        const { tabs } = get()
        const existing = tabs.findIndex((t) => t.key === input.key)
        if (existing >= 0) {
          // 同一 tab：更新 href/snapshot（search 变化不开新 tab），标题和图标也跟着路由当前的声明走 ——
          // 只更新前两样的话，从 sessionStorage 恢复出来的老页签永远留着改名前的标题、没有新加的图标（#220 评审）。
          // 标题都是静态的（staticData / 菜单），没有别处动态改它，所以覆盖是安全的
          const next = [...tabs]
          next[existing] = {
            ...next[existing],
            href: input.href,
            snapshot: input.snapshot,
            title: input.title,
            icon: input.icon,
            lastUsed: nextStamp(tabs),
          }
          set({ tabs: next, activeKey: input.key })
          return
        }
        const tab: Tab = {
          closable: input.closable ?? true,
          pinned: input.pinned ?? false,
          ...input,
          revision: 0,
          lastUsed: nextStamp(tabs),
        }
        let next = sortPinned([...tabs, tab])
        if (next.length > MAX_TABS) {
          const victim = pickVictim(next, input.key)
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

      setSearch: (key, search, href) => {
        const { tabs } = get()
        set({
          tabs: tabs.map((t) => (t.key === key ? { ...t, href, snapshot: { ...t.snapshot, search } } : t)),
        })
      },

      reorder: (fromKey, toKey, side) => {
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
        const target = next.findIndex((t) => t.key === toKey)
        if (target < 0) return
        next.splice(target + (side === 'end' ? 1 : 0), 0, moved)
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

/**
 * 页签用哪个图标：先按路径查菜单树，查不到再用路由 `staticData.icon`（不进侧边栏的页面）。
 * 标签条、标签列表下拉、⌘K「已打开的标签页」三处共用这一条，别各写各的（#220 评审：只改了标签条，另两处还是圆点）
 */
export function tabIcon(tab: Pick<Tab, 'href' | 'icon'>, iconByPath: Map<string, string | null>): string | null {
  const pathname = tab.href.split('?')[0] ?? tab.href
  return iconByPath.get(pathname) ?? tab.icon ?? null
}

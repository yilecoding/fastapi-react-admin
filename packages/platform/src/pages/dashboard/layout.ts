/**
 * 工作台布局的纯逻辑（#202）：存什么、读回来怎么和「现在能用哪些卡片」合并、默认长什么样。
 * 不 import React，单测在 `layout.test.ts`。
 *
 * 存在服务端的个人偏好 `dashboard.layout` 里（`GET / PUT /sys/users/me/preferences/{key}`），跟人走、不跟设备走。
 */

export const LAYOUT_PREF_KEY = 'dashboard.layout'

export type CardWidth = 'half' | 'full'

export type LayoutItem = { id: string; visible: boolean; width: CardWidth }

/** 合并之后、界面上用的布局：`items` 只含**当前能用**的卡片，顺序就是显示顺序 */
export type DashboardLayout = {
  items: LayoutItem[]
  /** 快捷入口挑了哪些页面（路由 path）。`null` = 没挑过，用默认的那几个 */
  quickLinks: string[] | null
}

/** 存进服务端的形状。`v` 是格式版本，以后改格式时按它迁移 */
export type StoredLayout = { v: 1; cards: LayoutItem[]; quickLinks?: string[] }

/** 一张卡片的默认值（注册表里每张卡片各自声明，按注册表顺序就是默认顺序） */
export type CardDefault = { id: string; defaultVisible: boolean; defaultWidth: CardWidth }

/**
 * 快捷入口最多**显示 / 勾选**几个：再多就不是「快捷」了。
 *
 * 🔴 这个数只管**现在看得见的**那些。存着、但这个人现在没权限的 path 原样留在清单末尾（权限还回来时照旧出现），
 * 不算进这 12 个 —— 拿它去截存的清单，末尾那些「暂时没权限」的就被静默截掉了（代码评审翻出来的）
 */
export const QUICK_LINKS_MAX = 12

/** 存的清单的硬上界（含暂时看不见的）。只是防一份坏数据撑爆偏好值的 16 KB，正常用不到 */
export const QUICK_LINKS_STORED_MAX = 64

export function defaultLayout(available: readonly CardDefault[]): DashboardLayout {
  return {
    items: available.map((c) => ({ id: c.id, visible: c.defaultVisible, width: c.defaultWidth })),
    quickLinks: null,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 存的一项卡片：形状不对的返回 null（整项丢掉，不猜） */
function readItem(raw: unknown): { id: string; visible?: boolean; width?: CardWidth } | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  return {
    id: raw.id,
    visible: typeof raw.visible === 'boolean' ? raw.visible : undefined,
    width: raw.width === 'half' || raw.width === 'full' ? raw.width : undefined,
  }
}

export type ResolvedLayout = {
  layout: DashboardLayout
  /**
   * 存过东西、但整份形状认不出来（不是对象 / 没有 `cards` 数组）。界面上要说出来 ——
   * 这时显示的是默认布局，**不是**这个人存的那份（硬纪律 9：不能静默退回默认还假装是他的布局）
   */
  unreadable: boolean
}

/**
 * 把存的布局和「现在能用的卡片」合并成界面上的布局。三条兼容规则（issue #202「1.0 起的兼容约定」）：
 *
 * 1. 存的里面有**不认识 / 现在不能用**的卡片 id（卡片删了、权限收回了、插件卸了）→ 渲染时忽略
 * 2. **新加的卡片**存的里面没有 → 按它自己的默认显隐和宽度排到最后
 * 3. 单项字段坏了（宽度拼错、显隐不是布尔）→ 那一项回落到卡片自己的默认值，不连累别的项
 *
 * `stored` 是接口原样给的 `value`：`null` = 没存过（默认布局，不算认不出来）
 */
export function resolveLayout(stored: unknown, available: readonly CardDefault[]): ResolvedLayout {
  if (stored === null || stored === undefined) return { layout: defaultLayout(available), unreadable: false }
  if (!isRecord(stored) || !Array.isArray(stored.cards)) {
    return { layout: defaultLayout(available), unreadable: true }
  }

  const byId = new Map(available.map((c) => [c.id, c]))
  const seen = new Set<string>()
  const items: LayoutItem[] = []
  for (const raw of stored.cards) {
    const item = readItem(raw)
    if (!item || seen.has(item.id)) continue
    const def = byId.get(item.id)
    if (!def) continue // 规则 1
    seen.add(item.id)
    items.push({
      id: item.id,
      visible: item.visible ?? def.defaultVisible, // 规则 3
      width: item.width ?? def.defaultWidth,
    })
  }
  for (const def of available) {
    if (!seen.has(def.id)) items.push({ id: def.id, visible: def.defaultVisible, width: def.defaultWidth }) // 规则 2
  }

  return { layout: { items, quickLinks: readQuickLinks(stored.quickLinks) }, unreadable: false }
}

function readQuickLinks(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const p of raw) {
    if (typeof p === 'string' && p.startsWith('/') && !out.includes(p)) out.push(p)
    if (out.length >= QUICK_LINKS_STORED_MAX) break
  }
  return out
}

/**
 * 要存回服务端的那一份。
 *
 * 🔴 **存的里面「现在不能用」的卡片原样带回去**，排在后面：权限临时被收走（或者另一台设备上是更新的版本、
 * 多认识一张卡片）的时候保存一次，那张卡片的设置不能跟着丢 —— 权限还回来时它应该还在原来的样子，
 * 而不是退回默认值排到最后。渲染时它们照样被 `resolveLayout` 忽略
 */
export function toStoredLayout(layout: DashboardLayout, previous: unknown): StoredLayout {
  const cards: LayoutItem[] = layout.items.map((i) => ({ id: i.id, visible: i.visible, width: i.width }))
  const kept = new Set(cards.map((c) => c.id))
  if (isRecord(previous) && Array.isArray(previous.cards)) {
    for (const raw of previous.cards) {
      const item = readItem(raw)
      if (!item || kept.has(item.id) || item.visible === undefined || item.width === undefined) continue
      kept.add(item.id)
      cards.push({ id: item.id, visible: item.visible, width: item.width })
    }
  }
  const stored: StoredLayout = { v: 1, cards }
  if (layout.quickLinks) stored.quickLinks = layout.quickLinks.slice(0, QUICK_LINKS_STORED_MAX)
  return stored
}

/** 拖拽排序：把 `from` 那一项挪到 `to` 那一项的位置 */
export function moveItem(layout: DashboardLayout, fromId: string, toId: string): DashboardLayout {
  const from = layout.items.findIndex((i) => i.id === fromId)
  const to = layout.items.findIndex((i) => i.id === toId)
  if (from < 0 || to < 0 || from === to) return layout
  const items = layout.items.slice()
  const [moved] = items.splice(from, 1)
  items.splice(to, 0, moved!)
  return { ...layout, items }
}

export function patchItem(layout: DashboardLayout, id: string, patch: Partial<Omit<LayoutItem, 'id'>>): DashboardLayout {
  return { ...layout, items: layout.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }
}

/** 两份布局在界面上是不是一样（「保存」按钮要不要亮） */
export function sameLayout(a: DashboardLayout, b: DashboardLayout): boolean {
  if (a.items.length !== b.items.length) return false
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i]!
    const y = b.items[i]!
    if (x.id !== y.id || x.visible !== y.visible || x.width !== y.width) return false
  }
  const la = a.quickLinks
  const lb = b.quickLinks
  if (la === null || lb === null) return la === lb
  return la.length === lb.length && la.every((p, i) => p === lb[i])
}

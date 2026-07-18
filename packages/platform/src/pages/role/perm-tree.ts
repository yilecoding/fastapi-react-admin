import type { MenuNode } from './api'

/**
 * 权限矩阵的纯逻辑层 —— 不 import React，可以单独测。
 *
 * 后端的菜单树里「按钮」是普通子节点（type=2），照原样铺成树的话，
 * 一个 23 个按钮的菜单会撑出 23 行，勾一次权限要滚半屏。
 * 这里把树拆成两层语义：
 *   - **结构节点**（目录/菜单/内嵌/外链）→ 表格的行
 *   - **按钮**（type=2）→ 挂在所属行的「按钮权限」单元格里平铺
 * 勾选状态本身仍然是一个扁平的 id 集合，和 `PUT /roles/{id}/menus` 的入参同构。
 */

export const BUTTON_TYPE = 2

export type PermNode = {
  id: string
  title: string
  type: number
  icon: string | null
  path: string | null
  /** 挂在本节点下的按钮，按 sort 排 */
  buttons: MenuNode[]
  /** 非按钮子节点 */
  children: PermNode[]
}

export function toPermTree(nodes: MenuNode[]): PermNode[] {
  return nodes
    .filter((n) => n.type !== BUTTON_TYPE)
    .map((n) => {
      const kids = n.children ?? []
      return {
        id: n.id,
        title: n.title,
        type: n.type,
        icon: n.icon,
        path: n.path,
        buttons: kids.filter((c) => c.type === BUTTON_TYPE),
        children: toPermTree(kids),
      }
    })
}

// ─── 索引：父子关系查得快一点 ──────────────────────────────────────────────────

export type MenuIndex = {
  parentOf: Map<string, string | null>
  /** 全部子孙（不含自身） */
  descOf: Map<string, string[]>
  allIds: string[]
}

export function indexMenus(nodes: MenuNode[]): MenuIndex {
  const parentOf = new Map<string, string | null>()
  const descOf = new Map<string, string[]>()
  const allIds: string[] = []

  const walk = (list: MenuNode[], parent: string | null): string[] => {
    const collected: string[] = []
    for (const n of list) {
      parentOf.set(n.id, parent)
      allIds.push(n.id)
      const sub = walk(n.children ?? [], n.id)
      descOf.set(n.id, sub)
      collected.push(n.id, ...sub)
    }
    return collected
  }
  walk(nodes, null)

  return { parentOf, descOf, allIds }
}

// ─── 三态 ─────────────────────────────────────────────────────────────────────

export type TriState = 'checked' | 'indeterminate' | 'unchecked'

export function stateOf(id: string, checked: ReadonlySet<string>, idx: MenuIndex): TriState {
  const desc = idx.descOf.get(id) ?? []
  const self = checked.has(id)
  if (desc.length === 0) return self ? 'checked' : 'unchecked'
  const hit = desc.reduce((n, d) => (checked.has(d) ? n + 1 : n), 0)
  if (self && hit === desc.length) return 'checked'
  if (self || hit > 0) return 'indeterminate'
  return 'unchecked'
}

/** 一组 id 的整体三态（表头那个全选框用） */
export function stateOfAll(ids: string[], checked: ReadonlySet<string>): TriState {
  if (ids.length === 0) return 'unchecked'
  const hit = ids.reduce((n, d) => (checked.has(d) ? n + 1 : n), 0)
  if (hit === 0) return 'unchecked'
  return hit === ids.length ? 'checked' : 'indeterminate'
}

/**
 * 勾选/取消一个节点。
 *
 * `linked`（节点关联）：
 *   - 选中 → 连同全部子孙一起选中，并把祖先补上。
 *     祖先必须补，否则菜单挂不到侧边栏上 —— 授权了却看不见。
 *   - 取消 → 连同全部子孙一起取消；祖先如果一个子孙都不剩，跟着摘掉。
 *
 * `!linked`（节点独立）：只动它自己。用于「只给按钮权限、不给菜单入口」这类
 * 精细场景，代价是可能勾出孤儿 —— 界面上要提示，见 `orphanIds`。
 */
export function toggleNode(
  id: string,
  checked: ReadonlySet<string>,
  idx: MenuIndex,
  linked: boolean
): Set<string> {
  const next = new Set(checked)
  const on = stateOf(id, checked, idx) !== 'checked'

  if (!linked) {
    if (on) next.add(id)
    else next.delete(id)
    return next
  }

  const family = [id, ...(idx.descOf.get(id) ?? [])]
  if (on) {
    for (const x of family) next.add(x)
    for (let p = idx.parentOf.get(id) ?? null; p; p = idx.parentOf.get(p) ?? null) next.add(p)
  } else {
    for (const x of family) next.delete(x)
    for (let p = idx.parentOf.get(id) ?? null; p; p = idx.parentOf.get(p) ?? null) {
      if ((idx.descOf.get(p) ?? []).some((d) => next.has(d))) break
      next.delete(p)
    }
  }
  return next
}

/** 已勾选但上级没勾的节点 —— 它们在侧边栏里挂不上去 */
export function orphanIds(checked: ReadonlySet<string>, idx: MenuIndex): string[] {
  const out: string[] = []
  for (const id of checked) {
    const p = idx.parentOf.get(id)
    if (p && !checked.has(p)) out.push(id)
  }
  return out
}

/** 把孤儿的祖先链一次性补齐 */
export function fixOrphans(checked: ReadonlySet<string>, idx: MenuIndex): Set<string> {
  const next = new Set(checked)
  for (const id of checked) {
    for (let p = idx.parentOf.get(id) ?? null; p; p = idx.parentOf.get(p) ?? null) next.add(p)
  }
  return next
}

// ─── 过滤 ─────────────────────────────────────────────────────────────────────

/**
 * 标题的匹配文本。
 *
 * 界面上显示的是**翻译后**的标题（英文界面下是 `Role management`），
 * 搜「显示出来的那串字」搜不到等于没搜 —— 所以原文和译文都要参与匹配。
 * `tr` 由调用方（组件）传进来，本模块保持不 import React / i18n。
 */
type Translate = (title: string, path?: string | null) => string

const haystack = (title: string, path: string | null | undefined, tr?: Translate): string =>
  (tr ? `${title} ${tr(title, path)}` : title).toLowerCase()

/**
 * 按关键字过滤。命中判定包含本行的按钮标题与权限码 ——
 * 搜 `sys:role:del` 应该能定位到「角色管理」那一行。
 * 命中的节点保留整条祖先链，否则树会断成碎片。
 */
export function filterPermTree(nodes: PermNode[], keyword: string, tr?: Translate): PermNode[] {
  const q = keyword.trim().toLowerCase()
  if (!q) return nodes

  const walk = (list: PermNode[]): PermNode[] => {
    const out: PermNode[] = []
    for (const n of list) {
      const kids = walk(n.children)
      const selfHit =
        haystack(n.title, n.path, tr).includes(q) ||
        (n.path ?? '').toLowerCase().includes(q) ||
        n.buttons.some(
          (b) => haystack(b.title, null, tr).includes(q) || (b.perms ?? '').toLowerCase().includes(q)
        )
      if (selfHit || kids.length) out.push({ ...n, children: kids })
    }
    return out
  }
  return walk(nodes)
}

/**
 * 关键字命中了**按钮**的那些行。
 *
 * 按钮面板默认收起，搜 `sys:role:del` 只把行筛出来、按钮还藏着等于没搜到，
 * 所以命中按钮的行要自动展开。
 */
export function rowsWithMatchingButtons(nodes: PermNode[], keyword: string, tr?: Translate): string[] {
  const q = keyword.trim().toLowerCase()
  if (!q) return []
  const out: string[] = []
  const walk = (list: PermNode[]) => {
    for (const n of list) {
      if (n.buttons.some((b) => haystack(b.title, null, tr).includes(q) || (b.perms ?? '').toLowerCase().includes(q))) {
        out.push(n.id)
      }
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 树里所有有子节点的结构节点 id（展开/折叠全部要用） */
export function expandableIds(nodes: PermNode[]): string[] {
  const out: string[] = []
  const walk = (list: PermNode[]) => {
    for (const n of list) {
      if (n.children.length) {
        out.push(n.id)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return out
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

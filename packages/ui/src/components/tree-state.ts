/**
 * 树形多选的**纯逻辑**：三态判定、级联勾选、关键字过滤。
 *
 * 🔴 单独成文件是为了能直接测。三态级联是这个库里最容易改错、
 * 而且改错了**不报错**的一段代码 —— 半选算漏一个分支，
 * 界面上只是某个父节点少了一条横杠，勾选结果照样存得进去。
 * 组件里的 `useCallback` 测不了（要挂 React），拆出来就是几行输入输出。
 *
 * 同一个形状在 `platform/pages/role/perm-tree.ts` 也有（权限矩阵那套），
 * 那份也是纯函数、不 import React —— 两处都按这个约定写。
 */

export type TreeNode = {
  id: string
  label: React.ReactNode
  /** 用于搜索过滤的纯文本，缺省时回落到 label（仅当它是字符串） */
  searchText?: string
  icon?: React.ReactNode
  disabled?: boolean
  children?: TreeNode[]
}

export type NodeState = "checked" | "indeterminate" | "unchecked"

/** 收集某节点下的全部 id（**含自身**，第 0 个就是它） */
export function collectIds(node: TreeNode, out: string[] = []): string[] {
  out.push(node.id)
  node.children?.forEach((c) => collectIds(c, out))
  return out
}

export type TreeIndex = {
  byId: Map<string, TreeNode>
  parentOf: Map<string, string | null>
}

export function buildIndex(nodes: TreeNode[]): TreeIndex {
  const byId = new Map<string, TreeNode>()
  const parentOf = new Map<string, string | null>()
  const walk = (list: TreeNode[], parent: string | null) => {
    for (const n of list) {
      byId.set(n.id, n)
      parentOf.set(n.id, parent)
      if (n.children?.length) walk(n.children, n.id)
    }
  }
  walk(nodes, null)
  return { byId, parentOf }
}

/**
 * 某节点的勾选态。
 *
 * 叶子直接看在不在集合里。有子节点时看子孙的命中数：
 * 全中 = checked、全不中 = unchecked（除非它自己被勾了 → indeterminate，
 * 这是「节点独立」模式下勾了父没勾子的情形）、部分 = indeterminate。
 */
export function nodeState(node: TreeNode, checked: ReadonlySet<string>): NodeState {
  if (!node.children?.length) return checked.has(node.id) ? "checked" : "unchecked"
  const ids = collectIds(node).slice(1)
  const hit = ids.filter((i) => checked.has(i)).length
  if (checked.has(node.id) && hit === ids.length) return "checked"
  if (hit === 0) return checked.has(node.id) ? "indeterminate" : "unchecked"
  return hit === ids.length ? "checked" : "indeterminate"
}

/**
 * 勾 / 取消一个节点，返回新的选中集合（扁平 id 数组）。
 *
 * 两步：
 * 1. `cascade` 时把自己和全部子孙一起改；否则只改自己
 * 2. **向上修正祖先** —— 子节点全选则祖先也选中，否则取消。
 *    少了这一步，「勾满所有子节点」不会让父节点变成 checked，
 *    界面上是一个永远停在半选的父节点
 *
 * `disabled` 的节点跳过 —— 它不该因为父节点被勾就跟着变。
 */
export function toggleNode(
  node: TreeNode,
  next: boolean,
  checked: readonly string[],
  index: TreeIndex,
  cascade = true
): string[] {
  const { byId, parentOf } = index
  const set = new Set(checked)
  const affected = cascade ? collectIds(node) : [node.id]
  for (const id of affected) {
    if (byId.get(id)?.disabled) continue
    if (next) set.add(id)
    else set.delete(id)
  }

  let p = parentOf.get(node.id) ?? null
  while (p) {
    const parent = byId.get(p)
    if (!parent) break
    const kids = collectIds(parent).slice(1)
    const all = kids.length > 0 && kids.every((i) => set.has(i))
    if (all) set.add(p)
    else set.delete(p)
    p = parentOf.get(p) ?? null
  }
  return [...set]
}

/** 按关键字过滤树，保留命中节点的祖先链 */
export function filterTree(nodes: TreeNode[], keyword: string): TreeNode[] {
  const q = keyword.trim().toLowerCase()
  if (!q) return nodes
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const n of list) {
      const kids = n.children ? walk(n.children) : []
      const text = (n.searchText ?? (typeof n.label === "string" ? n.label : "")).toLowerCase()
      if (text.includes(q) || kids.length) out.push({ ...n, children: kids.length ? kids : n.children })
    }
    return out
  }
  return walk(nodes)
}

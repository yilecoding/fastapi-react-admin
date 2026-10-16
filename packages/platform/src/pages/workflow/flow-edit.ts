/**
 * 流程树的纯函数编辑（不 import React）。
 *
 * 模型**本身就是树**，设计器、存储、运行时三方用同一个形状（#107 设计 2）——
 * avc-bp 存 DAG、前端来回转换，丢过两次字段。所以这里所有操作都直接改树，
 * 每次 `structuredClone` 一份再改，不在原对象上动手（react-query 缓存里那份不能被改）。
 *
 * 🔴 未知字段要原样保留：只改要改的键，不要「按已知字段重建节点」——
 * 那正是 avc-bp「`approveMode` 丢了，重新打开总显示单人」的根因。
 */
import type { AssigneeRule, ApprovalNode, Branch, CcNode, ConditionNode, FlowModel, FlowNode, StartNode } from './api'

type Holder = StartNode | FlowNode

let seq = 0
/** 节点 / 分支 / 字段的稳定 ID。只要在一份模型里唯一；带时间戳免得两次打开设计器撞号 */
export function newId(prefix: string): string {
  seq = (seq + 1) % 1000
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`
}

/** 遍历全部节点（含分支子树），回调拿到节点和「持有它的那个槽」 */
export function walk(
  model: FlowModel,
  fn: (node: FlowNode, setSlot: (n: FlowNode | null) => void) => void
): void {
  const visit = (node: FlowNode | null, setSlot: (n: FlowNode | null) => void) => {
    let cur = node
    let set = setSlot
    while (cur) {
      const holder = cur
      fn(holder, set)
      if (holder.type === 'condition') {
        for (const br of holder.branches) visit(br.child, (n) => { br.child = n })
      }
      set = (n) => { holder.next = n }
      cur = holder.next
    }
  }
  visit(model.root.next, (n) => { model.root.next = n })
}

export function findNode(model: FlowModel, id: string): FlowNode | null {
  let hit: FlowNode | null = null
  walk(model, (n) => { if (n.id === id) hit = n })
  return hit
}

function findHolder(model: FlowModel, id: string): Holder | null {
  if (model.root.id === id) return model.root
  return findNode(model, id)
}

export function blankNode(type: FlowNode['type']): FlowNode {
  if (type === 'approval') {
    return {
      type: 'approval',
      id: newId('n'),
      name: '审批人',
      mode: 'any',
      assignee: null,
      onEmpty: 'reject',
      actions: null,
      fieldPerms: {},
      next: null,
    } satisfies ApprovalNode
  }
  if (type === 'cc') return { type: 'cc', id: newId('cc'), name: '抄送人', targets: [], next: null } satisfies CcNode
  return {
    type: 'condition',
    id: newId('c'),
    name: '条件分支',
    branches: [
      { id: newId('b'), name: '条件 1', when: null, child: null },
      { id: newId('b'), name: '其他情况', default: true, child: null },
    ],
    next: null,
  } satisfies ConditionNode
}

/** 在 `afterId`（可以是开始节点）后面插一个节点 */
export function insertAfter(model: FlowModel, afterId: string, node: FlowNode): FlowModel {
  const m = structuredClone(model)
  const holder = findHolder(m, afterId)
  if (holder) {
    node.next = holder.next
    holder.next = node
  }
  return m
}

/** 插到某个分支的最前面 */
export function insertBranchHead(model: FlowModel, condId: string, branchId: string, node: FlowNode): FlowModel {
  const m = structuredClone(model)
  const cond = findNode(m, condId)
  const br = cond?.type === 'condition' ? cond.branches.find((b) => b.id === branchId) : undefined
  if (br) {
    node.next = br.child
    br.child = node
  }
  return m
}

/** 删一个节点。条件节点连同它所有分支一起删，后面的节点接上来 */
export function removeNode(model: FlowModel, id: string): FlowModel {
  const m = structuredClone(model)
  walk(m, (n, setSlot) => {
    if (n.id === id) setSlot(n.next)
  })
  return m
}

export function patchNode<T extends FlowNode>(model: FlowModel, id: string, patch: Partial<T>): FlowModel {
  const m = structuredClone(model)
  const n = findNode(m, id)
  if (n) Object.assign(n, patch)
  return m
}

export function addBranch(model: FlowModel, condId: string): FlowModel {
  const m = structuredClone(model)
  const cond = findNode(m, condId)
  if (cond?.type === 'condition') {
    const at = cond.branches.findIndex((b) => b.default)
    const br: Branch = { id: newId('b'), name: `条件 ${cond.branches.length}`, when: null, child: null }
    cond.branches.splice(at < 0 ? cond.branches.length : at, 0, br)
  }
  return m
}

export function patchBranch(model: FlowModel, condId: string, branchId: string, patch: Partial<Branch>): FlowModel {
  const m = structuredClone(model)
  const cond = findNode(m, condId)
  const br = cond?.type === 'condition' ? cond.branches.find((b) => b.id === branchId) : undefined
  if (br) Object.assign(br, patch)
  return m
}

/** 删分支。只剩两条时不让删 —— 那就不是「条件分支」了，要删就删整个条件节点 */
export function removeBranch(model: FlowModel, condId: string, branchId: string): FlowModel {
  const m = structuredClone(model)
  const cond = findNode(m, condId)
  if (cond?.type === 'condition' && cond.branches.length > 2) {
    cond.branches = cond.branches.filter((b) => b.id !== branchId)
  }
  return m
}

/** 审批节点 / 抄送节点用到的表单字段（删字段之前要知道谁在用它） */
export function usedFields(model: FlowModel): Set<string> {
  const out = new Set<string>()
  const scanCond = (c: unknown) => {
    if (!c || typeof c !== 'object') return
    const o = c as Record<string, unknown>
    if (typeof o.var === 'string') out.add(o.var)
    for (const k of ['all', 'any']) if (Array.isArray(o[k])) (o[k] as unknown[]).forEach(scanCond)
  }
  const scanRule = (r: AssigneeRule | null | undefined) => {
    if (r?.kind === 'var_user' && r.field) out.add(r.field)
  }
  walk(model, (n) => {
    if (n.type === 'condition') n.branches.forEach((b) => scanCond(b.when))
    if (n.type === 'approval') scanRule(n.assignee)
    if (n.type === 'cc') n.targets.forEach(scanRule)
  })
  return out
}

export const EMPTY_MODEL: FlowModel = { schemaVersion: 1, root: { type: 'start', id: 'start', next: null } }

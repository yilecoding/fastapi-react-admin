"use client"

import * as React from "react"
import { IconChevronRight } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import { cn } from "@admin/ui/lib/utils"
import { Checkbox } from "@admin/ui/components/checkbox"

/**
 * 受控树 + 三态复选。
 *
 * shadcn/Base UI 生态里没有现成的树形多选，做了这个通用实现：
 *   - 受控展开（`expanded` / `onExpandedChange`）
 *   - 三态复选：全选 / 未选 / 半选（部分子节点被选中）
 *   - 勾选父节点级联选中全部子孙；取消同理
 *   - 输出扁平的 id 数组，直接喂后端
 *
 * ⚠️ **目前零调用方。** 部门管理用的是手写树表，角色授权的权限矩阵
 * 走 `perm-matrix.tsx` + `perm-tree.ts`（按钮收在「已授权 n/m」芯片里就地展开，
 * 不铺成树的叶子行），菜单管理同样是手写树表 —— 三者都没有用到这个组件，
 * 详见 CLAUDE.md「主从页」一节。留着是给未来真的需要「树 + 三态复选」的场景用，
 * 改这个文件之前先确认有没有新的调用方，别以为改了就会影响到上面三个页面。
 *
 * 不做虚拟滚动 —— 菜单/部门量级在几百以内，加虚拟化只会让键盘导航和
 * 展开动画复杂化。真到几千节点再说。
 */
export type TreeNode = {
  id: string
  label: React.ReactNode
  /** 用于搜索过滤的纯文本，缺省时不参与过滤 */
  searchText?: string
  icon?: React.ReactNode
  disabled?: boolean
  children?: TreeNode[]
}

export type TreeProps = {
  nodes: TreeNode[]
  /** 选中的 id（只含被显式勾选的节点，父节点半选不在其中） */
  checked: string[]
  onCheckedChange: (next: string[]) => void
  expanded?: string[]
  onExpandedChange?: (next: string[]) => void
  /** 勾选父节点时是否级联子孙，默认 true */
  cascade?: boolean
  className?: string
  emptyText?: string
}

/** 收集某节点下的全部 id（含自身） */
function collectIds(node: TreeNode, out: string[] = []): string[] {
  out.push(node.id)
  node.children?.forEach((c) => collectIds(c, out))
  return out
}

function useNodeIndex(nodes: TreeNode[]) {
  return React.useMemo(() => {
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
  }, [nodes])
}

export function Tree({
  nodes,
  checked,
  onCheckedChange,
  expanded,
  onExpandedChange,
  cascade = true,
  className,
  emptyText,
}: TreeProps) {
  const { t } = useTranslation()
  const { byId, parentOf } = useNodeIndex(nodes)
  const checkedSet = React.useMemo(() => new Set(checked), [checked])

  const [innerExpanded, setInnerExpanded] = React.useState<string[]>(() =>
    nodes.filter((n) => n.children?.length).map((n) => n.id)
  )
  const expandedSet = React.useMemo(
    () => new Set(expanded ?? innerExpanded),
    [expanded, innerExpanded]
  )
  const setExpanded = onExpandedChange ?? setInnerExpanded

  /** 某节点的勾选态：全选 / 半选 / 未选 */
  const stateOf = React.useCallback(
    (node: TreeNode): "checked" | "indeterminate" | "unchecked" => {
      if (!node.children?.length) return checkedSet.has(node.id) ? "checked" : "unchecked"
      const ids = collectIds(node).slice(1)
      const hit = ids.filter((i) => checkedSet.has(i)).length
      if (checkedSet.has(node.id) && hit === ids.length) return "checked"
      if (hit === 0) return checkedSet.has(node.id) ? "indeterminate" : "unchecked"
      return hit === ids.length ? "checked" : "indeterminate"
    },
    [checkedSet]
  )

  const toggle = React.useCallback(
    (node: TreeNode, next: boolean) => {
      const affected = cascade ? collectIds(node) : [node.id]
      const set = new Set(checkedSet)
      for (const id of affected) {
        if (byId.get(id)?.disabled) continue
        if (next) set.add(id)
        else set.delete(id)
      }
      // 向上修正祖先：子节点全选则祖先也选中，否则取消
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
      onCheckedChange([...set])
    },
    [byId, parentOf, checkedSet, cascade, onCheckedChange]
  )

  if (!nodes.length) {
    return <div className={cn("py-8 text-center text-sm text-muted-foreground", className)}>{emptyText ?? t("暂无数据")}</div>
  }

  return (
    <div role="tree" className={cn("flex flex-col gap-0.5 text-sm", className)}>
      {nodes.map((n) => (
        <TreeItem
          key={n.id}
          node={n}
          depth={0}
          stateOf={stateOf}
          expandedSet={expandedSet}
          onToggleExpand={(id) => {
            const next = new Set(expandedSet)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            setExpanded([...next])
          }}
          onToggleCheck={toggle}
        />
      ))}
    </div>
  )
}

function TreeItem({
  node, depth, stateOf, expandedSet, onToggleExpand, onToggleCheck,
}: {
  node: TreeNode
  depth: number
  stateOf: (n: TreeNode) => "checked" | "indeterminate" | "unchecked"
  expandedSet: Set<string>
  onToggleExpand: (id: string) => void
  onToggleCheck: (n: TreeNode, next: boolean) => void
}) {
  const { t } = useTranslation()
  const hasChildren = Boolean(node.children?.length)
  const open = expandedSet.has(node.id)
  const state = stateOf(node)

  return (
    <div role="treeitem" aria-expanded={hasChildren ? open : undefined}>
      <div
        className="flex items-center gap-1.5 rounded-md py-1.5 pe-2 hover:bg-muted/60"
        style={{ paddingInlineStart: `${depth * 20 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? t("折叠") : t("展开")}
            data-testid={`tree-toggle-${node.id}`}
            onClick={() => onToggleExpand(node.id)}
            className="grid size-4 shrink-0 place-content-center rounded-sm hover:bg-muted"
          >
            <IconChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}

        <Checkbox
          checked={state === "checked"}
          indeterminate={state === "indeterminate"}
          disabled={node.disabled}
          data-testid={`tree-check-${node.id}`}
          onCheckedChange={(c) => onToggleCheck(node, Boolean(c))}
        />

        {node.icon}
        <span className={cn("truncate", node.disabled && "text-muted-foreground")}>{node.label}</span>
      </div>

      {hasChildren && open && (
        <div role="group">
          {node.children!.map((c) => (
            <TreeItem
              key={c.id}
              node={c}
              depth={depth + 1}
              stateOf={stateOf}
              expandedSet={expandedSet}
              onToggleExpand={onToggleExpand}
              onToggleCheck={onToggleCheck}
            />
          ))}
        </div>
      )}
    </div>
  )
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

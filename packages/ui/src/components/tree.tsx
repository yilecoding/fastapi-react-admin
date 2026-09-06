/**
 * ⚠️ **没有生产调用方**，留着是刻意的 —— 但判据变了，见下。
 *
 * 现在它满足「留」的条件：有沙箱 demo（`/sandbox/components?c=tree`）+
 * 纯逻辑单测（`tree-state.test.ts`，23 条）。`pnpm arch:check` 的
 * `orphan-component` 认这个 —— **零调用方零 demo 才报错**。
 *
 * 🔴 **它没有业务调用方，是因为权限矩阵页（`platform/pages/role/perm-matrix.tsx`）
 * 用裸 `Checkbox` 又实现了一套三态树。** 仓库里有**两套**同类实现，
 * 这一套是被绕过的那个。没合并是因为「把 perm-matrix 收敛到这一套」是设计活、
 * 要动一个改错了会**静默**出错的页面（勾选状态），不该顺手做。
 * 真要合并从 `tree-state.ts` 开始 —— 三态与级联的纯逻辑都在那里，有测试兜着。
 */
"use client"

import * as React from "react"
import { IconChevronRight } from "@tabler/icons-react"
import { useT } from "../lib/i18n"

import { cn } from "@admin/ui/lib/utils"
import { Checkbox } from "@admin/ui/components/checkbox"
// ⚠️ 相对路径，不是 `@admin/ui/components/tree-state`。
// 包自引用走 package.json 的 `exports`，而 `./components/*` 那条原来只映射
// `*.tsx` —— 这是本目录唯一一个 `.ts`（纯逻辑、无 JSX），于是解析不到。
// 失败方式很脏：`tsconfig` 的 `paths`（`@admin/ui/*` → `./src/*`）不认扩展名，
// 所以 **typecheck / lint / build 全绿**，只有 `pnpm dev` 白屏 500。
// `exports` 现在补了 `.ts` 兜底，但这里保持相对路径 —— 和同文件的
// `../lib/i18n` 一致，也少一层解析。
import {
  buildIndex,
  filterTree,
  nodeState,
  toggleNode,
  type NodeState,
  type TreeNode,
} from "./tree-state"

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
  const t = useT()
  const index = React.useMemo(() => buildIndex(nodes), [nodes])
  const checkedSet = React.useMemo(() => new Set(checked), [checked])

  const [innerExpanded, setInnerExpanded] = React.useState<string[]>(() =>
    nodes.filter((n) => n.children?.length).map((n) => n.id)
  )
  const expandedSet = React.useMemo(
    () => new Set(expanded ?? innerExpanded),
    [expanded, innerExpanded]
  )
  const setExpanded = onExpandedChange ?? setInnerExpanded

  // 三态判定与级联都在 `tree-state.ts` 里（纯函数，有单测覆盖）——
  // 这里只把 React 的状态接上去
  const stateOf = React.useCallback(
    (node: TreeNode): NodeState => nodeState(node, checkedSet),
    [checkedSet]
  )

  const toggle = React.useCallback(
    (node: TreeNode, next: boolean) => {
      onCheckedChange(toggleNode(node, next, checked, index, cascade))
    },
    [checked, index, cascade, onCheckedChange]
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
  const t = useT()
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

// 纯逻辑都在 tree-state.ts。这里继续 re-export，调用方不用关心它在哪一个文件
export { filterTree }
export type { TreeNode, NodeState }

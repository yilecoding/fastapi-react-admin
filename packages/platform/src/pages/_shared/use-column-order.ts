import * as React from 'react'
import type { ColumnOrderState, OnChangeFn } from '@tanstack/react-table'

/** 列定义里这个 hook 用得到的那几个字段（`createColumnHelper` 产出的定义都有） */
type ColumnDefLike = { id?: string; accessorKey?: unknown; accessorFn?: unknown; enableHiding?: boolean }

/**
 * 列顺序进 URL（#11，同 `use-column-visibility`：视图状态进 URL 是硬纪律 2）。
 *
 * URL 里只存**可移动列**的顺序（`cols=email,username,phone`），而且只在和默认不一样时才写 ——
 * 默认顺序下地址栏干净，和 `hide` 同一个口径。
 *
 * - 「可移动」= 有 accessor、能隐藏的列，和「列」面板（`ui/data-table.tsx`）里列出来的是同一批。
 *   勾选列、序号、操作列不进 URL，固定在自己的槽位上
 * - 代码里**加了列**：老链接里没有它，它按定义顺序补在可移动列的末尾；**删了列**：老链接里那个 id 被丢掉。
 *   两种都不会让老链接错位
 *
 * ⚠️ 要传给 `useTable` 的是**完整**顺序（含固定列）：TanStack 会把 `columnOrder` 里没写到的列
 * 统统排到最后 —— 只传可移动列的话，勾选列会跑到最右边
 */
export function useUrlColumnOrder(
  cols: string | undefined,
  onColsChange: (next: string | undefined) => void,
  columns: readonly ColumnDefLike[]
): [ColumnOrderState, OnChangeFn<ColumnOrderState>] {
  const all = React.useMemo(() => columns.map(idOf), [columns])
  const movable = React.useMemo(() => columns.filter(isMovable).map(idOf), [columns])

  const state = React.useMemo<ColumnOrderState>(() => {
    const wanted = [...new Set((cols ?? '').split(',').filter((id) => movable.includes(id)))]
    const order = [...wanted, ...movable.filter((id) => !wanted.includes(id))]
    let i = 0
    return all.map((id) => (movable.includes(id) ? order[i++] : id))
  }, [cols, all, movable])

  const setState = React.useCallback<OnChangeFn<ColumnOrderState>>(
    (updater) => {
      const next = typeof updater === 'function' ? updater(state) : updater
      const seq = next.filter((id) => movable.includes(id))
      // 空数组是「恢复默认」（`ui/data-table.tsx` 的重置按钮写的就是 []）
      const isDefault = seq.length === 0 || seq.join(',') === movable.join(',')
      onColsChange(isDefault ? undefined : seq.join(','))
    },
    [state, movable, onColsChange]
  )

  return [state, setState]
}

function idOf(col: ColumnDefLike): string {
  return col.id ?? String(col.accessorKey)
}

function isMovable(col: ColumnDefLike): boolean {
  return (col.accessorKey !== undefined || col.accessorFn !== undefined) && col.enableHiding !== false
}

import * as React from 'react'
import type { ColumnVisibilityState, OnChangeFn } from '@tanstack/react-table'

/**
 * 列显隐进 URL。
 *
 * 「列」下拉的状态原先只活在组件 state 里 —— 操作日志 12 列，隐掉一半，
 * 刷新或换 tab 回来全都冒出来了，等于每次都要重新点一遍。
 * 视图状态进 URL 是硬纪律 2，这一项之前漏了。
 *
 * URL 里存的是**被隐藏**的列 id（`hide=browser,os`）而不是全部可见列：
 * 默认全显示，所以隐藏集通常是空的，URL 干净；将来加列也不会让老链接错位。
 */
export function useUrlColumnVisibility(
  hide: string | undefined,
  onHideChange: (next: string | undefined) => void
): [ColumnVisibilityState, OnChangeFn<ColumnVisibilityState>] {
  const state = React.useMemo<ColumnVisibilityState>(() => {
    const ids = (hide ?? '').split(',').filter(Boolean)
    return Object.fromEntries(ids.map((id) => [id, false]))
  }, [hide])

  const setState = React.useCallback<OnChangeFn<ColumnVisibilityState>>(
    (updater) => {
      const next = typeof updater === 'function' ? updater(state) : updater
      const hidden = Object.entries(next)
        .filter(([, visible]) => visible === false)
        .map(([id]) => id)
        .sort()
      onHideChange(hidden.length ? hidden.join(',') : undefined)
    },
    [state, onHideChange]
  )

  return [state, setState]
}

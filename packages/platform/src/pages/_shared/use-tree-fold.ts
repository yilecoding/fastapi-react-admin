import * as React from 'react'

/**
 * 树形表格的展开/折叠状态。
 *
 * **粗粒度进 URL，细粒度留会话**：URL 只放一个 `fold=all`（默认全折叠），
 * 逐个节点的展开记录放组件 state。
 *
 * 为什么不把展开的 id 全塞进 URL：菜单树 65 个节点、每个 id 是 19 位雪花，
 * 拼出来的 search params 长到没法看也没法分享。而 `<Activity>` 保活只在会话内
 * 有效 —— 两者互补：刷新后回到「全展开 / 全折叠」的默认态，
 * 会话内逐个点开的记录照旧保留。
 */
export function useTreeFold(foldAll: boolean) {
  // 存的是「与默认态相反」的节点 —— 这样切换默认态时只要清空它
  const [flipped, setFlipped] = React.useState<Set<string>>(() => {
    // eslint-disable-next-line no-console
    console.log('[E2E_PROBE] useTreeFold 初始化/重新 mount，foldAll=', foldAll)
    return new Set()
  })

  // 默认态一变（点了展开/折叠全部），逐个覆盖就该失效
  React.useEffect(() => setFlipped(new Set()), [foldAll])

  const isOpen = React.useCallback(
    (id: string) => (flipped.has(id) ? foldAll : !foldAll),
    [flipped, foldAll]
  )

  const toggle = React.useCallback((id: string) => {
    setFlipped((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // eslint-disable-next-line no-console
      console.log('[E2E_PROBE] toggle', id, '-> flipped now:', [...next])
      return next
    })
  }, [])

  // eslint-disable-next-line no-console
  if (flipped.size > 0) console.log('[E2E_PROBE] render，flipped=', [...flipped], 'foldAll=', foldAll)

  return { isOpen, toggle, dirty: flipped.size > 0 }
}

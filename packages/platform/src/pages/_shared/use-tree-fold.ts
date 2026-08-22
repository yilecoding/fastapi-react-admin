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
  const [flipped, setFlipped] = React.useState<Set<string>>(new Set())

  // 默认态一变（点了展开/折叠全部），逐个覆盖就该失效。
  //
  // 🔴 不能只靠依赖数组判断「变了没有」——`<Activity mode="hidden">` 切回可见时会把
  // effect 整个销毁重建（`tab-outlet.tsx` 那条注释写的「销毁 effects」），
  // 一个新建的 effect 无论依赖数组内容是什么，**首次挂载都会跑一次**。
  // 于是切一次 tab 出去再回来，这里就会误判成「foldAll 变了」，把用户手动展开/折叠的
  // 节点全部清空——`flipped` 这个 state 本身好好地被 Activity 保活着，
  // 是这个 effect 自己把它清空的。E2E 测试实测踩到过（部门管理，折叠一个节点、
  // 切到角色管理、切回来，折叠状态丢了）。
  //
  // 用 ref 记住「上一次真正生效的 foldAll」，effect 重跑时先比对，值没变就什么都不做——
  // ref 和 state 一样是 Activity 保活的（只有 effect 本身被摘掉重建），这条比对才成立。
  const lastFoldAll = React.useRef(foldAll)
  React.useEffect(() => {
    if (lastFoldAll.current !== foldAll) {
      lastFoldAll.current = foldAll
      setFlipped(new Set())
    }
  }, [foldAll])

  const isOpen = React.useCallback(
    (id: string) => (flipped.has(id) ? foldAll : !foldAll),
    [flipped, foldAll]
  )

  const toggle = React.useCallback((id: string) => {
    setFlipped((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return { isOpen, toggle, dirty: flipped.size > 0 }
}

import * as React from 'react'

/**
 * 「滚到底就加载下一页」的哨兵。
 *
 * 用在主从页左栏那种**窄选择器**上：那一栏只有 288px 宽，塞一条分页条
 * 等于为了翻页要先滚到底、再点一下、再滚回顶部找目标 —— 而它本来就是个
 * 「快速跳到某个角色」的控件，翻页是纯摩擦。
 *
 * 两个实现要点：
 *
 * 1. **`root` 必须指向那个滚动容器，不能用默认的视口。**
 *    多页签下隐藏 tab 的 DOM 仍在文档树里（CLAUDE.md 硬纪律 5），
 *    而且内容区滚动模式下页面根本不滚 window —— 用视口当 root 时
 *    哨兵永远「不在视口内」，一页都不会加载。
 *
 * 2. **`hasMore` / `loading` 要进依赖**，否则观察器闭包里拿的是旧值：
 *    第一次加载完之后 `hasMore` 变了，旧闭包还以为没有下一页，
 *    表现是「滚到底只多加载一页就不动了」。
 *
 * 用法：把返回的 ref 挂在**列表最后一个元素之后**的空 div 上。
 */
export function useInfiniteScroll({
  rootRef,
  hasMore,
  loading,
  onLoadMore,
  /** 提前多少像素开始取下一页 —— 留一屏的余量，滚动过程中不会看到空白 */
  rootMargin = '200px',
}: {
  rootRef: React.RefObject<HTMLElement | null>
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  rootMargin?: string
}) {
  const sentinelRef = React.useRef<HTMLDivElement | null>(null)
  // onLoadMore 每次渲染都是新函数，进依赖会让观察器反复重建 —— 用 ref 兜住
  const cb = React.useRef(onLoadMore)
  React.useEffect(() => { cb.current = onLoadMore })

  React.useEffect(() => {
    const node = sentinelRef.current
    const root = rootRef.current
    if (!node || !root || !hasMore || loading) return
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) cb.current() },
      { root, rootMargin }
    )
    io.observe(node)
    return () => io.disconnect()
  }, [rootRef, hasMore, loading, rootMargin])

  return sentinelRef
}

import type { QueryObserverBaseResult } from '@tanstack/react-query'

/**
 * 列表页取数状态 → 组件 props 的**唯一一处映射**。
 *
 * 🔴 存在的理由是硬纪律 9。原来每个列表页手写这三行：
 *
 * ```ts
 * const { data, isPending, isFetching } = useQuery(xxxQuery(params))
 * <DataTable loading={isPending} busy={isFetching && !isPending} />
 * ```
 *
 * `error` 根本没被解构出来 —— 于是接口 500 时 `data` 是 `undefined`、
 * `rows` 退化成 `[]`，表格渲染出「暂无数据」，和「筛选太窄、真的没数据」
 * 一模一样。11 个页面都是这个样板，也就都漏了同一条。
 *
 * 现在换成摊开一个对象，**少写一个就是类型错误**：
 *
 * ```ts
 * const query = useQuery(xxxQuery(params))
 * const rows = query.data?.items ?? []
 * <DataTable {...listState(query)} … />
 * ```
 *
 * 分页 / 树 / 无限滚动三种查询都能进来 —— 只认 `isPending` / `isFetching` /
 * `error` / `refetch` 这四个字段，`useInfiniteQuery` 的结果也满足。
 */
export type ListStateProps = {
  /** 首屏加载中（表体走骨架，工具栏与表头留在位） */
  loading: boolean
  /** 后台重取（整体降透明，不换骨架、不拦点击） */
  busy: boolean
  /** 取数失败 —— 传给 `DataTable` / `MasterList` 渲染错误块，不是空态 */
  error: unknown
  /**
   * 重新取一次。
   *
   * 两个调用方共用它：错误块上的「重试」，以及工具行的「刷新」按钮
   * （`_shared/filters.tsx` 的 `RefreshButton`）—— 两者要做的事完全一样，
   * 不该有两条路径。
   */
  onRetry: () => void
}

type AnyQueryResult = Pick<
  QueryObserverBaseResult,
  'isPending' | 'isFetching' | 'error' | 'refetch'
> & {
  /** `useInfiniteQuery` 才有 —— 取下一页时不算 busy（列表底部已经有骨架占位了） */
  isFetchingNextPage?: boolean
}

export function listState(
  query: AnyQueryResult,
  options?: {
    /**
     * 查询本身是否已启用。`enabled: false` 的 query 状态一直停在 `pending`，
     * 照搬会让骨架屏一直转（字典页没选类型时踩过）。
     */
    enabled?: boolean
    /**
     * 重取之前先做一件事。**有行选中的页面必须传 `() => setRowSelection({})`**：
     *
     * 🔴 重取回来的行可能已经不在了（别人删了 / 状态改了），而选中态是按
     * `getRowId` 存的一组 id —— 留着它，接下来的批量删除会打到**用户看不见的
     * 记录**上，而界面上没有任何异常（同硬纪律「改筛选要清 rowSelection」那条，
     * 只是触发方式从「换条件」变成了「点刷新」）。
     */
    onBeforeRefetch?: () => void
  }
): ListStateProps {
  const enabled = options?.enabled ?? true
  const loading = enabled && query.isPending
  const before = options?.onBeforeRefetch
  return {
    loading,
    busy: query.isFetching && !loading && !query.isFetchingNextPage,
    error: query.error ?? undefined,
    onRetry: () => {
      before?.()
      void query.refetch()
    },
  }
}

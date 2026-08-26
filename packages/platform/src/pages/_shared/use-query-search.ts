import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  emptyQuery, fromUrlParams, nextId, toQueryParams, toUrlParams, urlParamKeys,
  type FilterField, type QueryValue,
} from '@admin/ui/components/query-bar'

/**
 * 把 `QueryBar` 接到 URL search params 上。
 *
 * 每个列表页都要写同一段胶水：从 URL 恢复条件 → 本地编辑 → 点搜索时写回 URL +
 * 拼接口入参 → 顺手跳回第一页。散在 20 个页面里各写一遍必然漂移，
 * 所以收成一个 hook。
 *
 * ```tsx
 * const q = useQuerySearch({ fields: FIELDS, search, onSearchChange })
 * <QueryBar fields={FIELDS} value={q.value} onChange={q.setValue}
 *           onSearch={q.submit} onReset={q.reset} applied={q.applied} />
 * // 取数用 q.params（已经是**后端**入参名了）
 * useQuery(listQuery({ ...q.params, page: search.page, size: search.size }))
 * ```
 *
 * ---
 *
 * ## 🔴 URL 里只存**一份**
 *
 * 第一版存了两份：平铺参数（给接口）+ `q`（整份查询的 JSON）。理由是
 * 「值为空的条件不出参，刷新后那几格会消失」—— 但那只需要记住**摆了哪几格**，
 * 不需要把值再存一遍。两份的代价是地址栏长这样：
 *
 * ```
 * ?start_time=…&end_time=…&q={"b":[["createdAt","between",["2026-08-16 00:00:00",…]]]}
 * ```
 *
 * 现在：一个字段一个参数（键是**字段 key**），外加一个 `f` 记录
 * 「摆开但没填值 / 运算符不是默认」的那几格。高级模式才用 `q`（嵌套的
 * AND/OR 树平铺不了）。同一份查询：
 *
 * ```
 * ?time=2026-08-16~2026-08-22
 * ```
 *
 * ## 另外两条不能少的
 *
 * 1. **搜索时 `page` 必须回第一页**，而且是写 `page: undefined` 而不是 `page: 1`
 *    （见 `_shared/pagination.ts`）。在第 5 页改了筛选条件、结果只有 3 条 →
 *    第 5 页是空的，页面看起来像「什么都没查到」。
 * 2. **写回时要先把查询区管的键全清掉**（`urlParamKeys`）。只做 `{...search, ...next}`
 *    的话，被移除的条件会永远留在地址栏里 —— 界面上没有那一格、请求里也没有它，
 *    但复制出去的链接还带着，别人打开就多一个筛选。
 */

/** 页面 search 里和查询区无关、但要保留的那几个键 */
export type QuerySearch = {
  page?: number
  size?: number
}

export function useQuerySearch<S extends QuerySearch>({
  fields,
  search,
  onSearchChange,
  /** 写回 URL 时要保留的键（`hide`、`section` 这种和筛选无关的视图状态） */
  keep,
  /**
   * 这一页列表 query 的 key 前缀（如 `userKeys.all`）。
   *
   * 🔴 传了它，「搜索」才是**幂等**的：条件一个字都没改时再点一次，也会真的
   * 重新取一次数据。不传的话点搜索**什么都不会发生** —— `submit` 只写 URL，
   * 条件没变 → URL 不变 → queryKey 不变 → 全局 `staleTime: 30_000` 让
   * react-query 直接给缓存，连 spinner 都不闪（实测 0 次请求，issue #36）。
   *
   * 用户点搜索的心智模型是「照这些条件再查一次」，不是「如果条件变了才查」。
   *
   * ⚠️ 为什么是 key 前缀而不是直接收一个 `refetch`：`refetch` 来自
   * `useQuery`，而 `useQuery` 的入参又来自这个 hook 返回的 `params` ——
   * 顺序上拿不到。key 工厂是模块级常量，没有这个问题。
   */
  refreshKey,
}: {
  fields: readonly FilterField[]
  search: S
  onSearchChange?: (next: S) => void
  keep?: readonly (keyof S)[]
  refreshKey?: readonly unknown[]
}) {
  const qc = useQueryClient()
  /**
   * URL 里那一份 = **已经生效的那一份**。
   *
   * 它同时喂给 `QueryBar` 的 `applied`（算「有未应用的改动」）和取数的入参 ——
   * 一个来源，不会出现「地址栏是 A、请求发的是 B」。
   */
  const managed = React.useMemo(() => urlParamKeys(fields), [fields])

  /** 只依赖查询区管的那几个键；`page` / `size` 变了不该重建条件 */
  const signature = React.useMemo(
    () => JSON.stringify(managed.map((k) => (search as Record<string, unknown>)[k] ?? null)),
    [managed, search]
  )

  const applied = React.useMemo(
    () => fromUrlParams(search as Record<string, unknown>, fields, nextId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, fields]
  )

  const [value, setValue] = React.useState<QueryValue>(applied)

  /**
   * URL 变了（前进/后退、外部跳转、从仪表盘带条件跳进来）要跟着换。
   *
   * ⚠️ 依赖是 `signature` **这个字符串**而不是 `applied` 对象 ——
   * `applied` 每次 `useMemo` 重算都是新对象（id 是 `nextId()` 现生的），
   * 用它当依赖会在每次渲染后把用户正在编辑的草稿冲掉。
   */
  const lastSignature = React.useRef(signature)
  React.useEffect(() => {
    if (lastSignature.current === signature) return
    lastSignature.current = signature
    setValue(applied)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const write = React.useCallback(
    (next: QueryValue) => {
      const out: Record<string, unknown> = {}
      // 先清掉查询区管的所有键 —— 不清的话移除掉的条件会留在地址栏
      for (const k of managed) out[k] = undefined
      for (const k of keep ?? []) {
        const v = (search as Record<string, unknown>)[k as string]
        if (v !== undefined) out[k as string] = v
      }
      // size 保留（用户显式选过的每页条数不该被一次搜索重置）；page 不写 = 回第一页
      if (search.size !== undefined) out.size = search.size
      Object.assign(out, toUrlParams(next, fields))
      onSearchChange?.(out as S)
      setValue(next)
      // 条件没变时 URL 不变、queryKey 不变，只能靠这一下把缓存作废（见 refreshKey 的注释）
      if (refreshKey) void qc.invalidateQueries({ queryKey: refreshKey })
    },
    [fields, keep, managed, onSearchChange, qc, refreshKey, search]
  )

  const reset = React.useCallback(() => write(emptyQuery(fields)), [write, fields])

  /** 发给后端的入参（已经是接口的名字了，`param` / `rangeParams` 都应用过） */
  const params = React.useMemo(() => toQueryParams(applied, fields), [applied, fields])

  return { value, setValue, applied, submit: write, reset, params }
}

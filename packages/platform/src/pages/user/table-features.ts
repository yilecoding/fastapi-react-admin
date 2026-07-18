import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  tableFeatures,
} from '@tanstack/react-table'

/**
 * TanStack Table v9 是 tree-shaken 的 —— 用到哪个特性就要显式注册。
 *
 * **不注册** `columnFilteringFeature` / `filteredRowModel` / `paginatedRowModel`：
 * 筛选和分页都在服务端做（`manualPagination`），客户端再过滤一遍会导致
 * 「只筛当前页」的错觉。
 *
 * **也不注册** `rowSortingFeature`：后端各列表接口固定 `ORDER BY id`
 * （见 `crud_*.py` 的 `select_order`），没有 sort 入参。以前注册了它并且
 * 接了 `sorting` state + `manualSorting`，但表头没有排序 UI、sorting 也从没
 * 进过请求 —— 纯死代码。真要做服务端排序，得先给后端加入参。
 */
export const features = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
})

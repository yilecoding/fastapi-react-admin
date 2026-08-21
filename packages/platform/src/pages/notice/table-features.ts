import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  tableFeatures,
} from '@tanstack/react-table'

/**
 * TanStack Table v9 是 tree-shaken 的 —— 用到哪个特性就要显式注册。
 *
 * 不注册 `columnFilteringFeature` / `paginatedRowModel`：筛选与分页都在服务端
 * （`manualPagination`），客户端再过一遍会造成「只筛当前页」的错觉。
 *
 * 也不注册 `rowSortingFeature`：`crud_notice.py` 固定 `select_order('id')`，
 * 接口没有排序入参 —— 挂上排序 UI 只会点了没反应。
 */
export const features = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
})

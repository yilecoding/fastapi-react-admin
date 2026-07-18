import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  tableFeatures,
} from '@tanstack/react-table'

/**
 * 除用户页外各列表页共用的表格特性（服务端分页，不注册客户端过滤/分页模型）。
 * 同样不注册 `rowSortingFeature` —— 后端没有 sort 入参，理由见 `user/table-features.ts`。
 */
export const logFeatures = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
})

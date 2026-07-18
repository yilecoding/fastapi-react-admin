import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  tableFeatures,
} from '@tanstack/react-table'

/**
 * 与其他列表页同一套特性。
 *
 * 这里**依然**是 `manualPagination` —— 虽然数据是前端全量持有的，
 * 但分页游标在 URL 里（硬纪律 2），由页面自己 slice；
 * 注册客户端分页模型会和 URL 里的 page 打架，出现「翻页两次才动一页」。
 */
export const features = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
})

import { columnVisibilityFeature, rowPaginationFeature, tableFeatures } from '@tanstack/react-table'

/**
 * TanStack Table v9 是 tree-shaken 的 —— 用到哪个特性就要显式注册。
 *
 * **不注册 `rowSelectionFeature`**：收件箱没有批量动作。接口只有「标记一条」和
 * 「全部已读」两个动作，摆一列复选框却没有任何按钮能作用于选中项，
 * 是个点了没反应的空控件。
 *
 * 也不注册排序：`crud_notification.py` 固定 `select_order('id', 'desc')`，
 * 接口没有排序入参。
 */
export const features = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
})

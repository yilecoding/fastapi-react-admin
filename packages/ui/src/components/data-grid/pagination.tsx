/**
 * data-grid 的分页条。
 *
 * 实现已经搬到 `components/pagination.tsx`（全站唯一一份，`DataTable` 也用它）。
 * 这里只剩一层适配：把 grid 的 `page` 对象摊平成 `Pagination` 的 props，
 * 并钉住 `grid-*` 这组 testid。
 *
 * 🔴 **原来这里是一份独立实现**，和 `DataTable` 那份行为一致但细节全不同：
 * 每页选项 `[10,20,50,100]` vs `[10,20,30,50]`、页码显示 `1 / 9` vs `第 1 / 9 页`、
 * 而且**整份硬编码中文**（这个目录在 i18n 的 SKIP_DIRS 里）。
 * 于是同一个产品里有两种分页条，切到用 data-grid 的页面就换一种说法。
 */
import { Pagination } from "@admin/ui/components/pagination"

export type GridPagination = {
  /** 0 起 */
  pageIndex: number
  pageCount: number
  pageSize: number
  totalCount: number
  onPageChange: (i: number) => void
  onPageSizeChange: (s: number) => void
  pageSizeOptions?: number[]
}

export function DataGridPagination({ page }: { page: GridPagination }) {
  return <Pagination {...page} testIdPrefix="grid" />
}

/**
 * 表格密度。
 *
 * `rowHeight` 不是装饰 —— 虚拟滚动要靠它估算行高，估歪了滚动条会跳。
 * 三档的值是照着实际渲染量出来的（含 border），改 padding 记得同步改。
 */
export type GridDensity = "compact" | "standard" | "loose"

export const GRID_DENSITY: Record<
  GridDensity,
  { cell: string; head: string; rowHeight: number; label: string }
> = {
  compact: { cell: "py-1", head: "h-8", rowHeight: 37, label: "紧凑" },
  standard: { cell: "py-2", head: "h-10", rowHeight: 53, label: "标准" },
  loose: { cell: "py-3.5", head: "h-12", rowHeight: 74, label: "舒展" },
}

export const GRID_DENSITIES: GridDensity[] = ["compact", "standard", "loose"]

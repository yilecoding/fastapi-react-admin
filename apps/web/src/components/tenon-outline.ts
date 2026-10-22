/**
 * 榫卯两片轮廓的顶点序列，24×24 视口。
 *
 * 一份数据两种用法：`tenon-mark.tsx` 的 SVG 路径，以及登录页 3D 舞台
 * （`routes/_guest/-tenon-stage.tsx`）每一层薄片的 `clip-path: polygon()`。
 * 舞台要是手抄一份百分比坐标，改了图形就只有一边跟着变。
 *
 * 单独一个文件而不是从 `tenon-mark.tsx` 导出：那边只能导出组件，
 * 否则 Vite 的 Fast Refresh 会退化成整页刷新（`react-refresh/only-export-components`）。
 *
 * ⚠️ 徽章版（favicon / 桌面图标）由 `scripts/gen-brand-icons.mjs` 生成，那边按矩形分解
 * 重写了一遍同样的形状 —— 改这里的顶点，要同步改那边的 `inTenon` / `inMortise` 再跑 `pnpm brand:icons`。
 */
export type Outline = ReadonlyArray<readonly [number, number]>

/** 榫：右边伸出榫舌 */
export const TENON_OUTLINE: Outline = [
  [2, 4], [10, 4], [10, 9], [13, 9], [13, 15], [10, 15], [10, 20], [2, 20],
]
/** 卯：左边挖出与榫舌等大的孔 */
export const MORTISE_OUTLINE: Outline = [
  [15, 4], [22, 4], [22, 20], [15, 20], [15, 15], [18, 15], [18, 9], [15, 9],
]

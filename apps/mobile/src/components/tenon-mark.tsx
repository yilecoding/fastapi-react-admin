import Svg, { Path } from 'react-native-svg'

/**
 * 榫卯标记 —— `apps/web/src/components/tenon-mark.tsx` 的 RN 版，**路径逐字一致**。
 *
 * 一枚榫头（左，实色）和一枚卯眼（右，半透明），中间留 2px 缝 ——
 * 画的是「即将咬合」而不是「已经拼死」，正好是单向依赖的样子。
 *
 * ⚠️ web 那份用 `currentColor` + `className` 上色；RN 的 `react-native-svg`
 * **不认 `currentColor`**（没有 CSS 继承这回事），所以颜色走 `color` prop 显式传。
 * 改了图形要**两边一起改**，那边还连着 `scripts/gen-brand-icons.mjs`。
 */
export function TenonMark({ size = 24, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* 榫：右边伸出榫舌 */}
      <Path d="M2 4 H10 V9 H13 V15 H10 V20 H2 Z" fill={color} />
      {/* 卯：左边挖出等大的孔 */}
      <Path d="M15 4 H22 V20 H15 V15 H18 V9 H15 Z" fill={color} fillOpacity={0.45} />
    </Svg>
  )
}

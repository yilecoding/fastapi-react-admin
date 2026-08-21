/**
 * 榫卯标记：一枚榫头（左，实色）和一枚卯眼（右，半透明），中间留 2px 缝 ——
 * 画的是「即将咬合」而不是「已经拼死」，正好是单向依赖的样子。
 * 两片都用 currentColor，深色面板和浅色页头共用一个组件。
 */
export function TenonMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden focusable="false">
      {/* 榫：右边伸出榫舌 */}
      <path d="M2 4 H10 V9 H13 V15 H10 V20 H2 Z" />
      {/* 卯：左边挖出等大的孔 */}
      <path d="M15 4 H22 V20 H15 V15 H18 V9 H15 Z" fillOpacity="0.45" />
    </svg>
  )
}

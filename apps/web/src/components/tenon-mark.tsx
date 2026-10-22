import { MORTISE_OUTLINE, TENON_OUTLINE, type Outline } from "@/components/tenon-outline"

const toPath = (pts: Outline) =>
  `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")} Z`

/**
 * 榫卯标记：一枚榫头（左，实色）和一枚卯眼（右，半透明），中间留 2px 缝 ——
 * 画的是「即将咬合」而不是「已经拼死」，正好是单向依赖的样子。
 * 两片都用 currentColor，跟随所在面板的文字色（侧边栏顶部就是这么用的）。
 */
export function TenonMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden focusable="false">
      <path d={toPath(TENON_OUTLINE)} />
      <path d={toPath(MORTISE_OUTLINE)} fillOpacity="0.45" />
    </svg>
  )
}

/**
 * 徽章版：紫底圆 + 白榫卯，和浏览器标签页、桌面图标是同一枚。
 *
 * 直接引用生成产物 `public/favicon.svg`，不在组件里再画一份 —— 底色和缩放比例的
 * 唯一真相源是 `scripts/gen-brand-icons.mjs`，这里要是手抄一个 `#4630DB`，
 * 下次改配色就会出现「标签页换了、登录页没换」。路径写成 `/favicon.svg` 与
 * `index.html` 的 `<link rel="icon">` 同一个写法。
 *
 * 装饰性：旁边总跟着 wordmark 文字，所以 `alt=""`。
 */
export function TenonBadge({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" aria-hidden className={className} draggable={false} />
}

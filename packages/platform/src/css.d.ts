/**
 * CSS 的 side-effect import 只在 `shell/tour/tour.ts` 里有（driver.css + 主题映射）。
 * tsc 解析不到 `.css` 会报 TS2882；真正处理它们的是 Vite，这里只是让类型检查认得这种 import。
 */
declare module '*.css'

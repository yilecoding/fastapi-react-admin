/**
 * 渲染层访问桌面外壳的入口。
 *
 * 同一份前端代码要同时能在浏览器和桌面壳里跑，所以这里的原则是：
 * **能力靠探测，不靠构建标志**。没有 `window.desktop` 就是浏览器，走原来的路径。
 */
import type { DesktopBridge } from './contract'

export * from './contract'

declare global {
  interface Window {
    /** 只有在 apps/desktop 的外壳里才存在 */
    desktop?: DesktopBridge
  }
}

/** 当前是否跑在桌面外壳里 */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.desktop
}

/**
 * 取桥。**不在桌面壳里会抛**——这是故意的：
 * 调用方要么先 `isDesktop()` 分支，要么就该明确这段代码只在桌面端跑。
 * 返回 undefined 让调用方 `?.` 掉，等于把「这个功能在浏览器里静默消失」
 * 伪装成正常行为，正是 CLAUDE.md 第 4 条纪律要杜绝的。
 */
export function desktop(): DesktopBridge {
  const bridge = typeof window !== 'undefined' ? window.desktop : undefined
  if (!bridge) {
    throw new Error('当前不在桌面客户端中运行：window.desktop 不存在。调用前请先用 isDesktop() 分支。')
  }
  return bridge
}

/** 取桥，拿不到就返回 null。适合「有就用、没有就降级」的场景 */
export function tryDesktop(): DesktopBridge | null {
  return (typeof window !== 'undefined' ? window.desktop : undefined) ?? null
}

/**
 * 导览目标的解析 —— 所有 tour 步骤的 `element` 都从这里出去，步骤定义里**写不了裸选择器**。
 *
 * 为什么：driver.js 对字符串目标是 `document.querySelector(e)`（1.8.0 产物实读），
 * 全局查询。而多页签外壳把所有已打开的页签同时挂在文档树里（硬纪律 5），
 * 先打开的页签在前 —— `[data-tour="create"]` 命中的会是**另一个页签里隐藏的那个按钮**，
 * 它 `display:none`、矩形全 0，高亮框画在视口左上角。
 *
 * 更糟的是 `arch:check` 的 `unscoped-dom-query` 抓不到它：那条规则只扫源码里字面出现的
 * `document.querySelector(`，查询发生在 node_modules 里就漏过。所以这里做四件事：
 *
 *   1. `TourTarget` 只接受函数 —— 类型上就传不了字串
 *   2. 页签内的目标按 tab key 锁（`[data-tab="…"]`），**不按 `data-visible` 锁**：
 *      切页签时有一段窗口两个 frame 都是 `true`（实测 18ms ~ 300ms，见硬纪律 5）
 *   3. 壳层目标排除掉任何页签内的同名元素（`:not([data-tab] *)`）——
 *      哪天有人在页面里也写了个 `data-tour="sidebar"`，壳导览不会被它带跑
 *   4. `isRendered()`：`display:none` 的元素 `getClientRects()` 为空，一并过滤
 *
 * 另有一条闸门：`arch:check` 的 `dead-tour-target` 核对这里引用的每个 id 在源码里
 * 都有对应的 `data-tour="…"`。目标标记被改名/删掉时导览不会报错，只会那一步凭空消失。
 */
export type TourTarget = () => Element | null

/** CSS 字符串字面量：把 `"` 和 `\` 转义掉。tab key 里带参数时是 `routeId|{"name":"x"}`，直接内插会把选择器撑破 */
const cssString = (v: string) => JSON.stringify(v)

// ⚠️ 下面三个 querySelector 的实参里都要**字面**出现 `data-tab` —— `arch:check` 的
// `unscoped-dom-query` 是正则抓实参判作用域的，遇到第一个 `)` 就停。所以带括号的
// `cssString(...)` 先算成变量再内插，别写进实参里（第一版就是这么被判成「没限定作用域」的）。

/** 壳层元素（侧边栏 / 页签条 / 顶栏）：不在任何页签里，全文档唯一 */
export const inShell = (id: string): TourTarget => {
  const own = cssString(id)
  return () => document.querySelector(`[data-tour=${own}]:not([data-tab] *)`)
}

/** 某个页签内的元素。`tabKey` 用 `useTabStore` 里的 `tab.key`（见 `makeTabKey`） */
export const inTab = (tabKey: string, id: string): TourTarget => {
  const key = cssString(tabKey)
  const own = cssString(id)
  return () => document.querySelector(`[data-tab=${key}] [data-tour=${own}]`)
}

/** 页签的内容框本身（`TabFrame` 那层 div） */
export const tabFrame = (tabKey: string): TourTarget => {
  const key = cssString(tabKey)
  return () => document.querySelector(`[data-tab=${key}]`)
}

/** 在文档里且真的画出来了。隐藏页签里的元素 `isConnected` 为真、但没有 client rect */
export function isRendered(el: Element | null): el is Element {
  return !!el && el.isConnected && el.getClientRects().length > 0
}

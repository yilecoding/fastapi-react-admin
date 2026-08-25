/**
 * 全局快捷键的两个共享判断。
 *
 * 修饰键的**显示**要跟平台走（mac 是 ⌘，其余是 Ctrl），而**监听**一律
 * `metaKey || ctrlKey` —— 和 `ui/components/sidebar.tsx` 里 `Ctrl/⌘+B`
 * 的判法保持一致，别在两处长出两套规则。
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

/** 显示用的修饰键名 */
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'

/**
 * 焦点是否落在可编辑元素里。
 *
 * 🔴 单键快捷键（`?`）必须先过这一关：不过的话在任意输入框里打一个问号
 * 就会弹出帮助面板，而那个字符**还是会被吞掉**（我们 preventDefault 了）——
 * 表现是「输入框里打不出问号」，没人会往快捷键上想。
 * 带修饰键的组合（⌘K / ⌘B）不需要这层判断，那些组合本来就没有输入语义。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable) return true
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'))
}

import { MENU_TYPE, type Menu } from './api'

/**
 * 死链判定的**唯一实现** —— 计数、行内标记、「只看死链」筛选、编辑表单的提示都用它。
 *
 * 判定口径是「**这一条会不会从侧边栏消失**」，所以规则必须跟
 * `shell/use-sidebar.ts: toNavTree` 保持一致（改一边就要改另一边）：
 *
 * - **按钮**：本来就不进侧边栏，只提供 perms 权限标识 → 从不算死链
 * - **外链 / 内嵌**：走 `link` 字段，不是前端路由 → 从不算死链
 * - **目录**：有可见子项时它只是个可展开分组，自己的 `path` 根本不会被用到 → 不算死链。
 *   种子数据里 `/system` `/log` `/monitor` 这些目录的 path 前端确实没有对应路由，
 *   但那是**设计如此** —— 目录不该可导航。
 *   只有子项全都进不了侧边栏时，目录才会降级成普通链接，这时才需要自己的 path 有效
 * - **菜单**：需要自己的 path 有效
 *
 * > 原实现把目录和菜单一视同仁（`Boolean(path) && !isValidPath(path)`），
 * > 于是 `/system` `/log` `/monitor` 三个工作得好好的目录被划了删除线、
 * > tooltip 写着「侧边栏会跳过」，而侧边栏其实一直正常显示它们 ——
 * > 59 项里的「8 个死链」有 3 个是假的。
 */
export function isBrokenMenu(m: Menu, isValidPath: (p: string) => boolean): boolean {
  if (m.type === MENU_TYPE.BUTTON || m.type === MENU_TYPE.LINK || m.type === MENU_TYPE.IFRAME) {
    return false
  }
  if (m.type === MENU_TYPE.DIR && hasVisibleChild(m, isValidPath)) return false
  return !m.path || !isValidPath(m.path)
}

/**
 * 有没有「进得了侧边栏」的子项 —— 与 `toNavTree` 的过滤口径一致：
 * 按钮不算、`display=0`（不在菜单显示）不算、自己也是死链的不算。
 *
 * 必须**递归**：子项自己也可能是死链（比如指向一个已经被合并/下线的旧页面），
 * 这种子项不算「可见」——一个目录如果所有子项都这样，它自己也没有可导航的
 * path，才会被判成**真**死链。（历史上 `/scheduler` 短暂踩过这条：子项的
 * 页面还没上线时，两个子项自己都是死链，父目录也跟着被判死——页面补上之后就不再是了。）
 */
export function hasVisibleChild(m: Menu, isValidPath: (p: string) => boolean): boolean {
  return (m.children ?? []).some((c) => {
    if (c.type === MENU_TYPE.BUTTON) return false
    if (c.display === 0) return false
    if (c.type === MENU_TYPE.LINK || c.type === MENU_TYPE.IFRAME) return true
    return !isBrokenMenu(c, isValidPath)
  })
}

export function countBroken(list: Menu[], isValidPath: (p: string) => boolean): number {
  let n = 0
  for (const m of list) {
    if (isBrokenMenu(m, isValidPath)) n += 1
    n += countBroken(m.children ?? [], isValidPath)
  }
  return n
}

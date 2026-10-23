import { describe, expect, it } from 'vitest'

import { MENU_TYPE, type Menu } from './api'
import { hasVisibleChild, isBrokenMenu } from './dead-link'

/**
 * 死链判定和 `toNavTree` 同口径。#143 之后停用的那一枝后端整棵不下发，
 * 所以停用的子项不能再算「可见」—— 否则子项全停用的目录被判成「正常分组」，而它其实从侧边栏消失了。
 */
const valid = new Set(['/system/user'])
const isValidPath = (p: string) => valid.has(p)

function menu(over: Partial<Menu>): Menu {
  return {
    id: '1', title: 'x', name: 'X', path: null, sort: 0, icon: null, type: MENU_TYPE.MENU, perms: null,
    status: 1, display: 1, link: null, remark: null, parent_id: null, children: [], ...over,
  } as Menu
}

describe('hasVisibleChild', () => {
  const page = menu({ id: '2', path: '/system/user' })

  it('启用的有效页面算可见', () => {
    expect(hasVisibleChild(menu({ type: MENU_TYPE.DIR, children: [page] }), isValidPath)).toBe(true)
  })

  it('停用的不算 —— 侧边栏根本收不到它', () => {
    const dir = menu({ type: MENU_TYPE.DIR, path: '/system', children: [{ ...page, status: 0 }] })
    expect(hasVisibleChild(dir, isValidPath)).toBe(false)
    // 目录自己的 path 不是前端路由 → 降级成链接也进不去 → 死链
    expect(isBrokenMenu(dir, isValidPath)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import {
  QUICK_LINKS_MAX,
  defaultLayout,
  moveItem,
  patchItem,
  resolveLayout,
  sameLayout,
  toStoredLayout,
  type CardDefault,
} from './layout'

const AVAILABLE: CardDefault[] = [
  { id: 'a', defaultVisible: true, defaultWidth: 'full' },
  { id: 'b', defaultVisible: true, defaultWidth: 'half' },
  { id: 'c', defaultVisible: false, defaultWidth: 'half' },
]

const ids = (r: { layout: { items: { id: string }[] } }) => r.layout.items.map((i) => i.id)

describe('工作台布局：存的和现在能用的卡片怎么合并', () => {
  it('没存过（null）= 默认布局，不算「认不出来」', () => {
    const r = resolveLayout(null, AVAILABLE)
    expect(r.unreadable).toBe(false)
    expect(r.layout).toEqual(defaultLayout(AVAILABLE))
    expect(r.layout.quickLinks).toBeNull()
  })

  it('照存的顺序 / 显隐 / 宽度来', () => {
    const r = resolveLayout(
      {
        v: 1,
        cards: [
          { id: 'c', visible: true, width: 'full' },
          { id: 'a', visible: false, width: 'half' },
          { id: 'b', visible: true, width: 'full' },
        ],
      },
      AVAILABLE
    )
    expect(r.layout.items).toEqual([
      { id: 'c', visible: true, width: 'full' },
      { id: 'a', visible: false, width: 'half' },
      { id: 'b', visible: true, width: 'full' },
    ])
  })

  it('🔴 存的里面有不认识的 id（卡片删了 / 没权限了）→ 忽略，页面照常', () => {
    const r = resolveLayout(
      { v: 1, cards: [{ id: 'gone', visible: true, width: 'full' }, { id: 'b', visible: false, width: 'half' }] },
      AVAILABLE
    )
    expect(r.unreadable).toBe(false)
    expect(ids(r)).toEqual(['b', 'a', 'c'])
    expect(r.layout.items[0]).toEqual({ id: 'b', visible: false, width: 'half' })
  })

  it('🔴 新加的卡片存的里面没有 → 按它自己的默认显隐 / 宽度排到最后', () => {
    const r = resolveLayout({ v: 1, cards: [{ id: 'b', visible: true, width: 'full' }] }, AVAILABLE)
    expect(r.layout.items).toEqual([
      { id: 'b', visible: true, width: 'full' },
      { id: 'a', visible: true, width: 'full' },
      { id: 'c', visible: false, width: 'half' },
    ])
  })

  it('单项坏了只回落那一项：宽度拼错 / 显隐不是布尔 / 重复的 id / 不是对象', () => {
    const r = resolveLayout(
      {
        v: 1,
        cards: [
          { id: 'a', visible: 'yes', width: 'wide' },
          'b',
          { id: 'b', visible: false, width: 'full' },
          { id: 'b', visible: true, width: 'half' },
          { visible: true },
        ],
      },
      AVAILABLE
    )
    expect(r.layout.items).toEqual([
      { id: 'a', visible: true, width: 'full' },
      { id: 'b', visible: false, width: 'full' },
      { id: 'c', visible: false, width: 'half' },
    ])
  })

  it('整份认不出来 → 默认布局，但要标出来（不能假装是这个人存的那份）', () => {
    for (const bad of ['oops', 42, [], { v: 1 }, { cards: 'x' }]) {
      const r = resolveLayout(bad, AVAILABLE)
      expect(r.unreadable, JSON.stringify(bad)).toBe(true)
      expect(r.layout).toEqual(defaultLayout(AVAILABLE))
    }
  })

  it('快捷入口：只收 / 开头的字符串、去重、有上限；没给 = null（用默认那几个）', () => {
    expect(resolveLayout({ v: 1, cards: [] }, AVAILABLE).layout.quickLinks).toBeNull()
    expect(resolveLayout({ v: 1, cards: [], quickLinks: [] }, AVAILABLE).layout.quickLinks).toEqual([])
    const r = resolveLayout({ v: 1, cards: [], quickLinks: ['/x', 3, 'http://evil', '/x', '/y'] }, AVAILABLE)
    expect(r.layout.quickLinks).toEqual(['/x', '/y'])
    const many = Array.from({ length: QUICK_LINKS_MAX + 5 }, (_, i) => `/p${i}`)
    expect(resolveLayout({ v: 1, cards: [], quickLinks: many }, AVAILABLE).layout.quickLinks).toHaveLength(QUICK_LINKS_MAX)
  })
})

describe('工作台布局：存回去的那一份', () => {
  it('🔴 现在不能用的卡片（权限临时收走）原样带回去，不跟着这次保存丢掉', () => {
    const previous = { v: 1, cards: [{ id: 'secret', visible: false, width: 'full' }, { id: 'a', visible: true, width: 'full' }] }
    const { layout } = resolveLayout(previous, AVAILABLE)
    const stored = toStoredLayout(patchItem(layout, 'a', { width: 'half' }), previous)
    expect(stored.cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'secret'])
    expect(stored.cards.find((c) => c.id === 'secret')).toEqual({ id: 'secret', visible: false, width: 'full' })
    // 往返一遍：带回去的那张在「能用」之前照样被忽略
    expect(ids(resolveLayout(stored, AVAILABLE))).toEqual(['a', 'b', 'c'])
  })

  it('形状不全的旧项不带回去（带回去也读不出原样）', () => {
    const stored = toStoredLayout(defaultLayout(AVAILABLE), { v: 1, cards: [{ id: 'x', visible: true }] })
    expect(stored.cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('没挑过快捷入口就不写这个键；挑过（哪怕是空的）就写', () => {
    expect('quickLinks' in toStoredLayout(defaultLayout(AVAILABLE), null)).toBe(false)
    expect(toStoredLayout({ ...defaultLayout(AVAILABLE), quickLinks: [] }, null).quickLinks).toEqual([])
  })
})

describe('编辑动作', () => {
  it('拖拽：把一项挪到另一项的位置（两个方向）', () => {
    const base = defaultLayout(AVAILABLE)
    expect(moveItem(base, 'a', 'c').items.map((i) => i.id)).toEqual(['b', 'c', 'a'])
    expect(moveItem(base, 'c', 'a').items.map((i) => i.id)).toEqual(['c', 'a', 'b'])
    expect(moveItem(base, 'a', 'nope')).toBe(base)
  })

  it('sameLayout：顺序 / 显隐 / 宽度 / 快捷入口任一不同就是改过了', () => {
    const base = defaultLayout(AVAILABLE)
    expect(sameLayout(base, defaultLayout(AVAILABLE))).toBe(true)
    expect(sameLayout(base, moveItem(base, 'a', 'b'))).toBe(false)
    expect(sameLayout(base, patchItem(base, 'b', { visible: false }))).toBe(false)
    expect(sameLayout(base, patchItem(base, 'b', { width: 'full' }))).toBe(false)
    expect(sameLayout(base, { ...base, quickLinks: [] })).toBe(false)
    expect(sameLayout({ ...base, quickLinks: ['/x'] }, { ...base, quickLinks: ['/x'] })).toBe(true)
  })
})

import { afterEach, describe, expect, it } from 'vitest'

import { useTabStore } from './tab-store'

function tab(key: string, pinned = false) {
  return {
    key,
    href: key,
    routeId: key,
    title: key,
    snapshot: { params: {}, search: {} },
    pinned,
  }
}

function openTabs(...keys: string[]) {
  useTabStore.getState().reset()
  keys.forEach((key) => useTabStore.getState().open(tab(key)))
}

afterEach(() => useTabStore.getState().reset())

describe('tab reorder', () => {
  it('inserts before or after the target, including when moving across its index', () => {
    openTabs('a', 'b', 'c', 'd')

    useTabStore.getState().reorder('a', 'c', 'start')
    expect(useTabStore.getState().tabs.map((item) => item.key)).toEqual(['b', 'a', 'c', 'd'])

    useTabStore.getState().reorder('d', 'b', 'end')
    expect(useTabStore.getState().tabs.map((item) => item.key)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('keeps pinned tabs ahead and rejects drops across the pinned boundary', () => {
    useTabStore.getState().reset()
    useTabStore.getState().open(tab('pinned', true))
    useTabStore.getState().open(tab('regular'))

    useTabStore.getState().reorder('regular', 'pinned', 'start')
    expect(useTabStore.getState().tabs.map((item) => item.key)).toEqual(['pinned', 'regular'])
  })
})

describe('超上限淘汰（#405）', () => {
  const keys = () => useTabStore.getState().tabs.map((item) => item.key)

  it('🔴 淘汰最久没用过的，不是最早打开的', () => {
    openTabs(...Array.from({ length: 20 }, (_, i) => `t${i}`))
    // 回到最早打开的那一页（正在里面填抽屉），再从侧边栏开一个新的
    useTabStore.getState().open(tab('t0'))
    useTabStore.getState().open(tab('new'))
    expect(keys()).toContain('t0')
    expect(keys()).not.toContain('t1')
    expect(keys()).toHaveLength(20)
  })

  it('固定的不淘汰；刚打开的那个不淘汰', () => {
    useTabStore.getState().reset()
    useTabStore.getState().open(tab('pinned', true))
    for (let i = 0; i < 19; i++) useTabStore.getState().open(tab(`t${i}`))
    useTabStore.getState().open(tab('new'))
    expect(keys()).toContain('pinned')
    expect(keys()).toContain('new')
    expect(keys()).not.toContain('t0')
  })

  it('老版本存下来的页签没有序号：按 0 算、同为 0 时按打开顺序', () => {
    openTabs(...Array.from({ length: 20 }, (_, i) => `t${i}`))
    useTabStore.setState({
      tabs: useTabStore.getState().tabs.map((item) => (item.key === 't5' || item.key === 't9' ? { ...item, lastUsed: undefined } : item)),
    })
    useTabStore.getState().open(tab('new'))
    expect(keys()).not.toContain('t5')
    expect(keys()).toContain('t9')
  })
})

describe('setSearch（后台页签改 search，#405）', () => {
  it('只改那一页的快照和 href，不动当前页签', () => {
    openTabs('a', 'b')
    useTabStore.getState().setSearch('a', { id: '2049629108245233664' }, 'a?id=2049629108245233664')
    const [a, b] = useTabStore.getState().tabs
    expect(a.href).toBe('a?id=2049629108245233664')
    expect(a.snapshot).toEqual({ params: {}, search: { id: '2049629108245233664' } })
    expect(b.href).toBe('b')
    expect(useTabStore.getState().activeKey).toBe('b')
  })
})

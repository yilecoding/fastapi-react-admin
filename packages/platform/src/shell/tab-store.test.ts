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

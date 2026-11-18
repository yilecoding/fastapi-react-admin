import { describe, expect, it } from 'vitest'

import { targetBubbleIndex } from './bubble-target'
import type { Bubble } from './message'

const a: Bubble[] = [
  { id: 'u1', role: 'user', content: '建个部门' },
  { id: 'a1', role: 'assistant', content: '', confirms: [{ token: 'cf_a', name: 'dept_create', preview: '新建「研发部」' }] },
  { id: 'u2', role: 'user', content: '再看看角色' },
  { id: 'a2', role: 'assistant', content: '有 3 个角色' },
]
// 切到会话 B 之后眼前的气泡：没有那张卡片
const b: Bubble[] = [
  { id: 'u9', role: 'user', content: '你好' },
  { id: 'a9', role: 'assistant', content: '你好，有什么可以帮你' },
]

describe('targetBubbleIndex', () => {
  it('确认流落在卡片所在的那条气泡上，不是最后一条', () => {
    expect(targetBubbleIndex(a, { token: 'cf_a' })).toBe(1)
  })

  it('#372：确认途中切到别的会话，卡片不在眼前就丢弃，不落到 B 的最后一条气泡上', () => {
    expect(targetBubbleIndex(b, { token: 'cf_a' })).toBe(-1)
  })

  it('对话流按气泡 id 找；气泡不在了同样丢弃（#329）', () => {
    expect(targetBubbleIndex(a, { bubbleId: 'a2' })).toBe(3)
    expect(targetBubbleIndex(b, { bubbleId: 'a2' })).toBe(-1)
  })
})

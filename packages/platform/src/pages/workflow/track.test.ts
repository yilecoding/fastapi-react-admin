import { describe, expect, it } from 'vitest'

import { avatarText } from './track'

describe('avatarText', () => {
  it('中文取名的末尾', () => {
    expect(avatarText('张三丰', 2)).toBe('三丰')
    expect(avatarText('张三丰', 1)).toBe('丰')
  })
  it('去掉括号后缀和空白，不显示成「）」', () => {
    expect(avatarText('张三（已停用）', 1)).toBe('三')
    expect(avatarText('李四 ', 1)).toBe('四')
  })
  it('韩文 / 日文也按中日韩处理', () => {
    expect(avatarText('김민수', 1)).toBe('수')
    expect(avatarText('さくら', 1)).toBe('ら')
  })
  it('拉丁名取首字母，中号两个', () => {
    expect(avatarText('John Smith', 2)).toBe('JS')
    expect(avatarText('John Smith', 1)).toBe('J')
    expect(avatarText('admin', 2)).toBe('AD')
  })
})

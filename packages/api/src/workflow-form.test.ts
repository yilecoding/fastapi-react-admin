import { describe, expect, it } from 'vitest'

import { evaluate, formRules, missingRequired, type FormField } from './workflow-form'

const field = (f: Partial<FormField> & Pick<FormField, 'id' | 'type'>): FormField => ({ label: f.id, ...f })

describe('evaluate', () => {
  it('雪花 ID 按十进制字符串比，不经 double（硬纪律 6）', () => {
    // 转成 Number 之后这两个是同一个数：4000000000000000000
    const cond = { var: 'dept', op: 'ne' as const, value: '4000000000000000005' }
    expect(evaluate(cond, { dept: '4000000000000000006' })).toBe(true)
    expect(evaluate(cond, { dept: '4000000000000000005' })).toBe(false)
  })

  it('数字串和数字按数值相等（同后端 Decimal）', () => {
    expect(evaluate({ var: 'n', op: 'eq', value: 1 }, { n: '1.0' })).toBe(true)
  })

  it('取不到的变量只有 empty 成立', () => {
    expect(evaluate({ var: 'x', op: 'empty' }, {})).toBe(true)
    expect(evaluate({ var: 'x', op: 'ne', value: 'a' }, {})).toBe(false)
  })
})

describe('formRules', () => {
  const schema = {
    fields: [
      field({ id: 'type', type: 'select' }),
      field({ id: 'proof', type: 'attachment', required: true, visibleWhen: { var: 'type', op: 'eq', value: 'sick' } }),
      field({ id: 'range', type: 'daterange' }),
      field({ id: 'days', type: 'number', calc: { kind: 'days', field: 'range' } }),
      field({ id: 'items', type: 'table' }),
      field({ id: 'total', type: 'amount', precision: 2, calc: { kind: 'sum', field: 'items', column: 'amt' } }),
    ],
  }

  it('显示条件不成立的字段藏掉，值也不带', () => {
    const r = formRules(schema, { type: 'annual', proof: ['f1'] })
    expect(r.inactive.has('proof')).toBe(true)
    expect(r.data).not.toHaveProperty('proof')
    expect(formRules(schema, { type: 'sick' }).inactive.has('proof')).toBe(false)
  })

  it('天数含首尾两天', () => {
    expect(formRules(schema, { range: ['2026-11-09', '2026-11-13'] }).data.days).toBe(5)
  })

  it('金额求和不走浮点：0.1 + 0.2 = 0.30', () => {
    const r = formRules(schema, { items: [{ amt: '0.1' }, { amt: '0.2' }] })
    expect(r.data.total).toBe('0.30')
  })
})

describe('missingRequired', () => {
  const schema = {
    fields: [
      field({ id: 'reason', type: 'textarea', required: true }),
      field({ id: 'proof', type: 'attachment', required: true, visibleWhen: { var: 'type', op: 'eq', value: 'sick' } }),
      field({ id: 'note', type: 'text', required: true }),
    ],
  }

  it('不显示的必填字段不算缺', () => {
    expect(missingRequired(schema, { type: 'annual' })).toEqual({ reason: 'reason', note: 'note' })
    expect(missingRequired(schema, { type: 'sick' })).toHaveProperty('proof')
  })

  it('only：审批人只查自己这一步能填的', () => {
    expect(missingRequired(schema, {}, new Set(['note']))).toEqual({ note: 'note' })
  })
})

import { describe, expect, it } from 'vitest'

import {
  LAYOUT_PARAM,
  TREE_PARAM,
  conditionParams,
  fromUrlParams,
  packQuery,
  rangeParamNames,
  toFilterTree,
  toQueryParams,
  toUrlParams,
  unpackQuery,
  urlParamKeys,
} from './params'
import { defaultOperatorOf } from './types'
import type { Condition, FilterField, QueryValue } from './types'

/**
 * 这一层是「用户点的东西 → 地址栏 → 接口入参」的翻译器，
 * 而它的失败方式**全是静默的**：日期少补一个 `23:59:59`，
 * 后端把 `end_time=2026-08-22` 解析成当天 00:00:00，
 * **整整一天的数据消失**，界面上只是「查出来比预期少」。
 *
 * 所以测的重点是三件：
 *   1. URL ↔ 条件值的**往返**不丢东西（尤其是时间的整天边界）
 *   2. URL 参数名 ≠ 接口入参名（两套命名不能串味）
 *   3. 空值 / 脏 URL 不产生垃圾参数、也不白屏
 */

let seq = 0
const nextId = () => `id${++seq}`

const FIELDS: FilterField[] = [
  { key: 'username', label: '用户名', type: 'text', defaultVisible: true },
  { key: 'amount', label: '额度', type: 'number', param: 'amount_total', showOperator: true },
  {
    key: 'status',
    label: '状态',
    type: 'select',
    defaultVisible: true,
    // 选项 value 是**数字** —— 出参要发数字，不是 "1"
    options: [
      { value: 1, label: '正常' },
      { value: 0, label: '停用' },
    ],
  },
  {
    key: 'role',
    label: '角色',
    type: 'multiSelect',
    options: [
      { value: '10', label: '管理员' },
      { value: '20', label: '审计员' },
    ],
  },
  {
    key: 'time',
    label: '登录时间',
    type: 'dateTimeRange',
    defaultVisible: true,
    rangeParams: ['start_time', 'end_time'],
  },
  { key: 'birthday', label: '生日', type: 'date' },
]

/**
 * ⚠️ 不给 `op` 时用**字段自己的默认运算符**，不是硬编码 `eq` ——
 * 第一版就是 `op: 'eq'`，于是 text 字段（默认 `like`）和区间字段（默认 `between`）
 * 全被当成「用户切过运算符」，`f` 里写成 `username:eq,time:eq`，
 * 四条布局断言一起红。测试夹具和真实构造（`newCondition`）必须同源。
 */
const fieldOf = (key: string) => FIELDS.find((f) => f.key === key)

const basic = (conds: Array<Partial<Condition> & { field: string }>): QueryValue => ({
  mode: 'basic',
  basic: conds.map(
    (c) => {
      const f = fieldOf(c.field)
      // 未知字段（测「老链接带着已删的 key」那条）没有默认运算符可取
      return { id: nextId(), op: f ? defaultOperatorOf(f) : 'eq', ...c } as Condition
    }
  ),
  advanced: { id: nextId(), logic: 'and', children: [] },
})

describe('rangeParamNames', () => {
  it('声明了 rangeParams 就用它', () => {
    expect(rangeParamNames(FIELDS[4]!)).toEqual(['start_time', 'end_time'])
  })

  it('没声明就按 param（或 key）加 _start / _end 后缀', () => {
    expect(rangeParamNames({ key: 'age', label: '', type: 'number' })).toEqual([
      'age_start',
      'age_end',
    ])
    expect(rangeParamNames({ key: 'age', label: '', type: 'number', param: 'user_age' })).toEqual([
      'user_age_start',
      'user_age_end',
    ])
  })
})

describe('toQueryParams（→ 接口入参）', () => {
  it('用 param 覆盖 key —— URL 叫 amount，接口叫 amount_total', () => {
    const out = toQueryParams(basic([{ field: 'amount', op: 'gt', value: '100' }]), FIELDS)
    expect(out).toEqual({ amount_total: 100 })
  })

  it('🔴 number 字段发出去是数字，不是字符串', () => {
    const out = toQueryParams(basic([{ field: 'amount', value: '42' }]), FIELDS)
    expect(out.amount_total).toBe(42)
    expect(typeof out.amount_total).toBe('number')
  })

  it('🔴 select 按 options 查回**原始类型** —— 条件里存的是字符串，发出去是数字', () => {
    const out = toQueryParams(basic([{ field: 'status', value: '1' }]), FIELDS)
    expect(out.status).toBe(1)
    expect(typeof out.status).toBe('number')
  })

  it('多选默认拼成 csv', () => {
    const out = toQueryParams(basic([{ field: 'role', op: 'in', value: ['10', '20'] }]), FIELDS)
    expect(out.role).toBe('10,20')
  })

  it('区间铺成两个入参', () => {
    const out = toQueryParams(
      basic([{ field: 'time', op: 'between', value: ['2026-08-16 00:00:00', '2026-08-22 23:59:59'] }]),
      FIELDS
    )
    expect(out).toEqual({
      start_time: '2026-08-16 00:00:00',
      end_time: '2026-08-22 23:59:59',
    })
  })

  it('区间只有一端也出一个参数', () => {
    const out = toQueryParams(
      basic([{ field: 'time', op: 'between', value: [undefined, '2026-08-22 23:59:59'] }]),
      FIELDS
    )
    expect(out).toEqual({ end_time: '2026-08-22 23:59:59' })
  })

  it('空值不出参 —— 摆着没填的格子不该污染请求', () => {
    expect(toQueryParams(basic([{ field: 'username', value: '' }]), FIELDS)).toEqual({})
    expect(toQueryParams(basic([{ field: 'username' }]), FIELDS)).toEqual({})
    expect(toQueryParams(basic([{ field: 'role', op: 'in', value: [] }]), FIELDS)).toEqual({})
  })

  it('未知字段忽略（老链接带着已删的 key）', () => {
    expect(toQueryParams(basic([{ field: 'gone', value: 'x' }]), FIELDS)).toEqual({})
  })

  it('「为空 / 不为空」在平铺入参里没有表达方式 —— 出 {} 而不是 undefined 值', () => {
    const f = FIELDS[0]!
    expect(conditionParams({ id: 'x', field: 'username', op: 'isNull', value: undefined }, f)).toEqual({})
  })

  it('toParam 完全接管这个字段的出参', () => {
    const f: FilterField = {
      key: 'kw',
      label: '关键词',
      type: 'text',
      toParam: (v, op) => ({ [`kw__${op}`]: v }),
    }
    expect(conditionParams({ id: 'x', field: 'kw', op: 'like', value: 'ab' }, f)).toEqual({
      kw__like: 'ab',
    })
  })
})

describe('toUrlParams（→ 地址栏）', () => {
  it('🔴 键是**字段 key**，不是接口入参名', () => {
    const out = toUrlParams(basic([{ field: 'amount', op: 'gt', value: '100' }]), FIELDS)
    expect(out.amount).toBe(100)
    expect(out.amount_total).toBeUndefined()
  })

  it('🔴 整天边界压掉 —— 地址栏里只留日期', () => {
    const out = toUrlParams(
      basic([{ field: 'time', op: 'between', value: ['2026-08-16 00:00:00', '2026-08-22 23:59:59'] }]),
      FIELDS
    )
    expect(out.time).toBe('2026-08-16~2026-08-22')
  })

  it('不是整天边界就保留时分秒（用 T 连接，省掉一个 %20）', () => {
    const out = toUrlParams(
      basic([{ field: 'time', op: 'between', value: ['2026-08-16 09:30:00', '2026-08-22 18:00:00'] }]),
      FIELDS
    )
    expect(out.time).toBe('2026-08-16T09:30:00~2026-08-22T18:00:00')
  })

  it('区间只有一端时保留分隔符，区分「只有下限」和「只有上限」', () => {
    const only = (value: unknown[]) =>
      toUrlParams(basic([{ field: 'time', op: 'between', value }]), FIELDS).time
    expect(only(['2026-08-16 00:00:00', undefined])).toBe('2026-08-16~')
    expect(only([undefined, '2026-08-22 23:59:59'])).toBe('~2026-08-22')
  })

  it('🔴 布局和默认一致时**不写** f —— 否则一进页面地址栏就是一串噪音', () => {
    const out = toUrlParams(
      basic([{ field: 'username' }, { field: 'status' }, { field: 'time' }]),
      FIELDS
    )
    expect(out[LAYOUT_PARAM]).toBeUndefined()
  })

  it('加了一格就写 f', () => {
    const out = toUrlParams(
      basic([{ field: 'username' }, { field: 'status' }, { field: 'time' }, { field: 'role' }]),
      FIELDS
    )
    expect(out[LAYOUT_PARAM]).toBe('username,status,time,role')
  })

  it('🔴 删掉一个默认格子也要写 f —— 不然刷新它自己回来了', () => {
    const out = toUrlParams(basic([{ field: 'username' }, { field: 'status' }]), FIELDS)
    expect(out[LAYOUT_PARAM]).toBe('username,status')
  })

  it('非默认运算符记成 key:op', () => {
    const out = toUrlParams(
      basic([{ field: 'username' }, { field: 'status' }, { field: 'time' }, { field: 'amount', op: 'gt' }]),
      FIELDS
    )
    expect(out[LAYOUT_PARAM]).toBe('username,status,time,amount:gt')
  })

  it('高级模式整份塞进 adv，不铺平', () => {
    const v: QueryValue = {
      mode: 'advanced',
      basic: [],
      advanced: {
        id: 'g',
        logic: 'or',
        children: [{ id: 'c', field: 'username', op: 'like', value: 'ab' }],
      },
    }
    const out = toUrlParams(v, FIELDS)
    expect(typeof out[TREE_PARAM]).toBe('string')
    expect(out.username).toBeUndefined()
  })
})

describe('fromUrlParams（← 地址栏）', () => {
  it('🔴 URL 里的日期解码时补回整天边界 —— 少了这一步后端会吞掉最后一天', () => {
    const v = fromUrlParams({ time: '2026-08-16~2026-08-22' }, FIELDS, nextId)
    const time = v.basic.find((c) => c.field === 'time')!
    expect(time.value).toEqual(['2026-08-16 00:00:00', '2026-08-22 23:59:59'])
  })

  it('🔴 补回来之后接口入参是完整的', () => {
    const v = fromUrlParams({ time: '2026-08-16~2026-08-22' }, FIELDS, nextId)
    expect(toQueryParams(v, FIELDS)).toEqual({
      start_time: '2026-08-16 00:00:00',
      end_time: '2026-08-22 23:59:59',
    })
  })

  it('🔴 没有 f 时用默认布局，不是空数组（空的话第一次进页面筛选栏是空的）', () => {
    const v = fromUrlParams({}, FIELDS, nextId)
    expect(v.basic.map((c) => c.field)).toEqual(['username', 'status', 'time'])
    expect(v.basic.every((c) => c.value === undefined)).toBe(true)
  })

  it('有 f 就照 f 来，且**按字段声明顺序**渲染（不按 URL 里的顺序）', () => {
    const v = fromUrlParams({ [LAYOUT_PARAM]: 'time,username' }, FIELDS, nextId)
    expect(v.basic.map((c) => c.field)).toEqual(['username', 'time'])
  })

  it('f 里的 key:op 恢复运算符', () => {
    const v = fromUrlParams({ [LAYOUT_PARAM]: 'amount:gt' }, FIELDS, nextId)
    expect(v.basic[0]!.op).toBe('gt')
  })

  it('手改 URL 给了不在布局里的字段的值，那一格也摆出来', () => {
    const v = fromUrlParams({ [LAYOUT_PARAM]: 'username', role: '10,20' }, FIELDS, nextId)
    expect(v.basic.map((c) => c.field)).toEqual(['username', 'role'])
    expect(v.basic[1]!.value).toEqual(['10', '20'])
  })

  it('未知 key 直接忽略', () => {
    const v = fromUrlParams({ [LAYOUT_PARAM]: 'gone,username' }, FIELDS, nextId)
    expect(v.basic.map((c) => c.field)).toEqual(['username'])
  })

  it('number 字段解码成数字，解析不了就当没填', () => {
    expect(fromUrlParams({ amount: '42' }, FIELDS, nextId).basic.find((c) => c.field === 'amount')!.value).toBe(42)
    expect(fromUrlParams({ amount: 'abc' }, FIELDS, nextId).basic.find((c) => c.field === 'amount')!.value).toBeUndefined()
  })

  it('🔴 脏 adv 不白屏，回落成一棵空的高级树', () => {
    const v = fromUrlParams({ [TREE_PARAM]: '{坏掉的' }, FIELDS, nextId)
    expect(v.mode).toBe('advanced')
    expect(v.advanced.children).toEqual([])
  })
})

describe('URL 往返', () => {
  const roundTrip = (v: QueryValue) => {
    const url = toUrlParams(v, FIELDS)
    const clean = Object.fromEntries(Object.entries(url).filter(([, x]) => x !== undefined))
    return fromUrlParams(clean, FIELDS, nextId)
  }

  it('基础模式：字段、运算符、值都还在', () => {
    const v = basic([
      { field: 'username', op: 'like', value: 'zhang' },
      { field: 'status', value: '1' },
      { field: 'time', op: 'between', value: ['2026-08-16 00:00:00', '2026-08-22 23:59:59'] },
      { field: 'role', op: 'in', value: ['10', '20'] },
    ])
    const back = roundTrip(v)
    const byField = Object.fromEntries(back.basic.map((c) => [c.field, c]))
    expect(byField.username!.value).toBe('zhang')
    expect(byField.username!.op).toBe('like')
    // select 的值在条件里一律是字符串（见 types.ts 顶部那段）
    expect(String(byField.status!.value)).toBe('1')
    expect(byField.time!.value).toEqual(['2026-08-16 00:00:00', '2026-08-22 23:59:59'])
    expect(byField.role!.value).toEqual(['10', '20'])
  })

  it('🔴 接口入参往返后一模一样 —— 这是「刷新之后查出来的东西一样」的判据', () => {
    const v = basic([
      { field: 'time', op: 'between', value: ['2026-08-16 00:00:00', '2026-08-22 23:59:59'] },
      { field: 'status', value: '0' },
    ])
    expect(toQueryParams(roundTrip(v), FIELDS)).toEqual(toQueryParams(v, FIELDS))
  })

  it('date 字段（不带时分秒）往返不会凭空长出 00:00:00', () => {
    const v = basic([{ field: 'birthday', value: '1996-03-02' }])
    const back = roundTrip(v)
    expect(back.basic.find((c) => c.field === 'birthday')!.value).toBe('1996-03-02')
  })
})

describe('packQuery / unpackQuery', () => {
  it('空查询不产生 `{}`', () => {
    expect(packQuery(basic([]))).toBeUndefined()
  })

  it('高级树往返', () => {
    const v: QueryValue = {
      mode: 'advanced',
      basic: [],
      advanced: {
        id: 'g1',
        logic: 'or',
        children: [
          { id: 'c1', field: 'username', op: 'like', value: 'a' },
          {
            id: 'g2',
            logic: 'and',
            children: [{ id: 'c2', field: 'status', op: 'eq', value: '1' }],
          },
        ],
      },
    }
    const back = unpackQuery(packQuery(v)!, FIELDS, nextId)!
    expect(back.mode).toBe('advanced')
    expect(back.advanced.logic).toBe('or')
    expect(back.advanced.children).toHaveLength(2)
  })

  it('坏字符串返回 undefined，不抛', () => {
    expect(unpackQuery('{不是 json', FIELDS, nextId)).toBeUndefined()
    expect(unpackQuery('', FIELDS, nextId)).toBeUndefined()
    expect(unpackQuery(null, FIELDS, nextId)).toBeUndefined()
  })
})

describe('toFilterTree', () => {
  it('剪掉没填值的条件和空分组', () => {
    const v: QueryValue = {
      mode: 'advanced',
      basic: [],
      advanced: {
        id: 'g1',
        logic: 'and',
        children: [
          { id: 'c1', field: 'username', op: 'like', value: 'a' },
          { id: 'c2', field: 'username', op: 'like', value: '' },
          { id: 'g2', logic: 'or', children: [] },
        ],
      },
    }
    const out = toFilterTree(v, FIELDS)
    expect(out.children).toHaveLength(1)
  })
})

describe('urlParamKeys', () => {
  it('🔴 覆盖全部字段 key + f + adv —— 页面写回前要靠它把旧参数清干净', () => {
    const keys = urlParamKeys(FIELDS)
    for (const f of FIELDS) expect(keys).toContain(f.key)
    expect(keys).toContain(LAYOUT_PARAM)
    expect(keys).toContain(TREE_PARAM)
  })
})

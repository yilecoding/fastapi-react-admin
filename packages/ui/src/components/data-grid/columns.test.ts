import { describe, expect, it } from 'vitest'

import { facetedFilterFn, rangeFilterFn } from './column-filter'
import { cellStyle, getPinnedStyle, sizeStyle } from './columns'

/**
 * data-grid 里能脱开 React 测的两组：**列筛选谓词** 和 **列的尺寸 / 固定样式**。
 *
 * 为什么是这两组：它们的错法都是「表格照常渲染，只是结果悄悄不对」——
 * 筛选谓词的方向反了会「筛出全部行」，固定样式算错会让操作列
 * 叠在别的列上（不报错、只是看着怪）。
 *
 * `useGridView` 不在这里 —— 它是 hook，要挂 React 才能跑，
 * 而它的实质是 localStorage 读写，E2E 打真实页面验更实在。
 */

/** 假 row：只需要 getValue */
const row = (values: Record<string, unknown>) => ({ getValue: (k: string) => values[k] })

describe('facetedFilterFn（枚举多选列）', () => {
  it('🔴 方向是「筛选值的集合里包含单元格的值」，不是反过来', () => {
    // TanStack 对数组 filterValue 会自动挑 arrIncludes，那个是反的
    expect(facetedFilterFn(row({ status: 1 }), 'status', [1, 2])).toBe(true)
    expect(facetedFilterFn(row({ status: 3 }), 'status', [1, 2])).toBe(false)
  })

  it('没选任何值 = 不过滤（放行全部）', () => {
    expect(facetedFilterFn(row({ status: 9 }), 'status', [])).toBe(true)
    expect(facetedFilterFn(row({ status: 9 }), 'status', undefined)).toBe(true)
    expect(facetedFilterFn(row({ status: 9 }), 'status', 'not-an-array')).toBe(true)
  })

  it('⚠️ 用的是严格相等 —— 单元格是数字、筛选值是字符串就一条都不中', () => {
    // 这条钉住的是一个真实陷阱：选项 value 忘了转类型，界面上勾了却什么都没筛出来
    expect(facetedFilterFn(row({ status: 1 }), 'status', ['1'])).toBe(false)
  })
})

describe('rangeFilterFn（数值区间列）', () => {
  it('闭区间：两端都算命中', () => {
    expect(rangeFilterFn(row({ n: 10 }), 'n', [10, 20])).toBe(true)
    expect(rangeFilterFn(row({ n: 20 }), 'n', [10, 20])).toBe(true)
  })

  it('区间外的排除掉', () => {
    expect(rangeFilterFn(row({ n: 9 }), 'n', [10, 20])).toBe(false)
    expect(rangeFilterFn(row({ n: 21 }), 'n', [10, 20])).toBe(false)
  })

  it('只给一端时另一端不设限', () => {
    expect(rangeFilterFn(row({ n: 1000 }), 'n', [10, undefined])).toBe(true)
    expect(rangeFilterFn(row({ n: 1 }), 'n', [10, undefined])).toBe(false)
    expect(rangeFilterFn(row({ n: 1 }), 'n', [undefined, 10])).toBe(true)
    expect(rangeFilterFn(row({ n: 11 }), 'n', [undefined, 10])).toBe(false)
  })

  it('不是数组 = 不过滤', () => {
    expect(rangeFilterFn(row({ n: 5 }), 'n', undefined)).toBe(true)
  })

  it('单元格是数字字符串也能比 —— 内部走 Number()', () => {
    expect(rangeFilterFn(row({ n: '15' }), 'n', [10, 20])).toBe(true)
  })

  it('⚠️ 单元格不是数字时 Number() 得到 NaN，两个比较都是 false → **放行**', () => {
    // 钉住现状：NaN 的行不会被区间筛掉。想改成「筛掉」得显式判 Number.isNaN
    expect(rangeFilterFn(row({ n: '—' }), 'n', [10, 20])).toBe(true)
  })
})

/** 假 column：只实现被读到的那几个方法 */
const column = (o: {
  size?: number
  pinned?: 'start' | 'end' | false
  start?: number
  after?: number
}) => ({
  getSize: () => o.size,
  getIsPinned: () => o.pinned ?? false,
  getStart: () => o.start,
  getAfter: () => o.after,
})

describe('sizeStyle', () => {
  it('🔴 width 和 minWidth 一起给 —— table-fixed 下光有 width 在窄容器里还是会被压', () => {
    expect(sizeStyle(column({ size: 160 }))).toEqual({ width: 160, minWidth: 160 })
  })

  it('拿不到尺寸就什么都不给（而不是给 width: undefined 覆盖掉 CSS）', () => {
    expect(sizeStyle(column({}))).toEqual({})
    expect(sizeStyle(column({ size: 0 }))).toEqual({})
    expect(sizeStyle(undefined)).toEqual({})
  })
})

describe('getPinnedStyle', () => {
  it('没固定就返回 undefined', () => {
    expect(getPinnedStyle(column({ size: 100 }))).toBeUndefined()
  })

  it('🔴 用的是**逻辑方位**（insetInlineStart / End），不是 left / right —— RTL 下才不会翻', () => {
    expect(getPinnedStyle(column({ size: 100, pinned: 'start', start: 48 }))).toEqual({
      position: 'sticky',
      insetInlineStart: 48,
      zIndex: 2,
      width: 100,
    })
    expect(getPinnedStyle(column({ size: 80, pinned: 'end', after: 0 }))).toEqual({
      position: 'sticky',
      insetInlineEnd: 0,
      zIndex: 2,
      width: 80,
    })
  })

  it('拿不到累计偏移时回落到 0（没注册 columnSizingFeature 的情形）', () => {
    expect(getPinnedStyle(column({ size: 80, pinned: 'end' }))).toMatchObject({
      insetInlineEnd: 0,
    })
  })
})

describe('cellStyle', () => {
  it('尺寸 + 固定一次算完，渲染处不用记得拼两个', () => {
    expect(cellStyle(column({ size: 80, pinned: 'end', after: 0 }))).toEqual({
      width: 80,
      minWidth: 80,
      position: 'sticky',
      insetInlineEnd: 0,
      zIndex: 2,
    })
  })
})

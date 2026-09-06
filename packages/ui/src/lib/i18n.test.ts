import { describe, expect, it } from 'vitest'

import { __fallbackT } from './i18n'

/**
 * 兜底 `t` 的唯一职责：**没有 i18next 实例时也要做插值**。
 *
 * 本仓库「中文原文即 key」，所以没实例时满屏中文、看起来一切正常 ——
 * 唯一坏掉的是带 `{{var}}` 的那 20 条，它们会显示成模板源码
 * （分页条上真的出现过 `共 {{total}} 条`）。这几条测的就是那一个点。
 */
describe('__fallbackT', () => {
  it('没有插值参数时原样返回', () => {
    expect(__fallbackT('重试')).toBe('重试')
    expect(__fallbackT('重试', {})).toBe('重试')
  })

  it('🔴 替换 {{var}} —— 这是它存在的全部理由', () => {
    expect(__fallbackT('共 {{total}} 条', { total: 42 })).toBe('共 42 条')
  })

  it('多个占位符都换', () => {
    expect(__fallbackT('已选 {{n}} 项 / 共 {{total}} 条', { n: 3, total: 42 })).toBe(
      '已选 3 项 / 共 42 条'
    )
  })

  it('同一个占位符出现多次也都换', () => {
    expect(__fallbackT('{{a}} 和 {{a}}', { a: 'x' })).toBe('x 和 x')
  })

  it('容忍 i18next 允许的空格写法 `{{ n }}`', () => {
    expect(__fallbackT('第 {{ page }} 页', { page: 2 })).toBe('第 2 页')
  })

  it('数字 0 和空串要被替换，不能被当成「没给」', () => {
    expect(__fallbackT('共 {{total}} 条', { total: 0 })).toBe('共 0 条')
    expect(__fallbackT('前缀{{s}}后缀', { s: '' })).toBe('前缀后缀')
  })

  it('⚠️ 没给值的占位符**原样留着**，不换成空 —— 留着才看得出是漏传了', () => {
    expect(__fallbackT('{{name}} 上传失败：{{err}}', { name: 'a.png' })).toBe(
      'a.png 上传失败：{{err}}'
    )
    expect(__fallbackT('共 {{total}} 条', { total: undefined })).toBe('共 {{total}} 条')
    expect(__fallbackT('共 {{total}} 条', { total: null })).toBe('共 {{total}} 条')
  })

  it('多出来的参数无害', () => {
    expect(__fallbackT('重试', { unused: 1 })).toBe('重试')
  })

  it('单花括号不是占位符，不动它', () => {
    expect(__fallbackT('{n} 不是占位符', { n: 1 })).toBe('{n} 不是占位符')
  })

  it('点号 key 也认（i18next 支持 {{a.b}}）', () => {
    expect(__fallbackT('{{a.b}}', { 'a.b': 'v' })).toBe('v')
  })
})

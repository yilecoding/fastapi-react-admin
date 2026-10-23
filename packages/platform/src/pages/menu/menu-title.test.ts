import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { changeLanguage, hasBuiltinMenuTranslation, i18next, initI18n, menuTitle, t } from '@admin/i18n'

/**
 * #143：改了内置菜单的标题，界面上不变。原来所有语言都先按 path 查语言包，
 * 内置菜单两个语言包里都有 `menu:<path>`，库里的新标题永远轮不到。
 */
beforeAll(() => {
  initI18n([], 'zh-CN')
})
afterAll(async () => {
  await changeLanguage('zh-CN')
})

describe('menuTitle', () => {
  it('中文下就是库里的标题 —— 改了名马上看得到', async () => {
    await changeLanguage('zh-CN')
    // 前置：这条路径真有内置译名，否则下面那条断言什么都没测
    expect(i18next.getResource('zh-CN', 'translation', 'menu:/system/menu')).toBeTruthy()
    expect(menuTitle(t, '/system/menu', '菜单配置')).toBe('菜单配置')
  })

  it('其它语言下内置菜单用按 path 预置的译名，非内置的回落库里的标题', async () => {
    await changeLanguage('en-US')
    expect(menuTitle(t, '/system/menu', '菜单配置')).toBe(
      i18next.getResource('en-US', 'translation', 'menu:/system/menu')
    )
    expect(menuTitle(t, '/report/sales', '销售报表')).toBe('销售报表')
    // 按钮没有 path：回落到「标题本身即 key」
    expect(menuTitle(t, null, '新增')).toBe(i18next.getResource('en-US', 'translation', '新增'))
  })
})

describe('hasBuiltinMenuTranslation', () => {
  it('只认基准语言以外的译名，不被 fallbackLng 骗到', () => {
    // 只在基准语言里有的 key：`i18next.exists(key, { lng: 'en-US' })` 会经 fallbackLng 找到它，返回 true
    i18next.addResource('zh-CN', 'translation', 'menu:/only-zh', '只有中文')
    expect(hasBuiltinMenuTranslation('/only-zh')).toBe(false)
    expect(hasBuiltinMenuTranslation('/system/menu')).toBe(true)
    expect(hasBuiltinMenuTranslation('/report/sales')).toBe(false)
    expect(hasBuiltinMenuTranslation(null)).toBe(false)
  })
})

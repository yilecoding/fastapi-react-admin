import { describe, expect, it } from 'vitest'

import { ApiError, isPhoneNumber, normalizePhone, shouldReloadCaptcha } from '@admin/api'

/**
 * 登录页两端共用的三条判定（`@admin/api` 的 `login.ts`）。那个包没有测试运行器，
 * 和 `api-client/session-refresh.test.ts` 一样借 platform 的 vitest 测。
 */
describe('登录页两端共用的判定', () => {
  it('自动填充给的带格式 / 带国家码的号规整成 11 位', () => {
    expect(normalizePhone('+86 138 0013 8000')).toBe('13800138000')
    expect(normalizePhone('0086-138-0013-8000')).toBe('13800138000')
    expect(normalizePhone('8613800138000')).toBe('13800138000')
    expect(normalizePhone('(138) 0013-8000')).toBe('13800138000')
    // 正在输入、还没输完的号原样留着（只去掉非数字），不提前判错
    expect(normalizePhone('138 00')).toBe('13800')
    // 长度不对的不硬截：多出来的位要让格式校验看见，界面上才能说「格式不对」
    expect(normalizePhone('138001380001')).toBe('138001380001')
    expect(isPhoneNumber(normalizePhone('138001380001'))).toBe(false)
  })

  it('规整之后才过得了格式校验', () => {
    expect(isPhoneNumber('+86 138 0013 8000')).toBe(false)
    expect(isPhoneNumber(normalizePhone('+86 138 0013 8000'))).toBe(true)
    expect(isPhoneNumber('12800138000')).toBe(false)
  })

  it('只有撞了限流（429）才不换图形验证码', () => {
    expect(shouldReloadCaptcha(new ApiError(429, 429, '太频繁'))).toBe(false)
    expect(shouldReloadCaptcha(new ApiError(400, 40001, '验证码错误'))).toBe(true)
    expect(shouldReloadCaptcha(new ApiError(403, 403, '用户名或密码有误'))).toBe(true)
    expect(shouldReloadCaptcha(new ApiError(0, 0, '连不上服务器'))).toBe(true)
    expect(shouldReloadCaptcha(new Error('其他'))).toBe(true)
  })
})

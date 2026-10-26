import type { Channel, PolicyMode } from './api'

/** 写成函数里的字面量 `t('…')`：模块级常量再 `t(变量)` 的话 `i18n:check` 看不见这些 key */
export function channelLabel(t: (k: string) => string, c: Channel): string {
  switch (c) {
    case 'inapp':
      return t('站内')
    case 'email':
      return t('邮件')
    default:
      return t('短信')
  }
}

export function modeLabel(t: (k: string) => string, m: PolicyMode): string {
  switch (m) {
    case 'off':
      return t('不发')
    case 'default_on':
      return t('默认发，可关')
    case 'default_off':
      return t('默认不发，可开')
    default:
      return t('必发')
  }
}

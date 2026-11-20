import { describe, expect, it } from 'vitest'

import { normalizeLinkHref } from './link-href'

describe('normalizeLinkHref（#405）', () => {
  it('🔴 没写协议的域名补 https —— 原样写进去是相对地址，点开落在本站 404', () => {
    expect(normalizeLinkHref('www.example.com')).toBe('https://www.example.com')
    expect(normalizeLinkHref('  example.com/a?b=1#c ')).toBe('https://example.com/a?b=1#c')
    expect(normalizeLinkHref('example.com/a:b')).toBe('https://example.com/a:b')
  })

  it('主机:端口不是协议', () => {
    expect(normalizeLinkHref('localhost:8080/x')).toBe('https://localhost:8080/x')
    expect(normalizeLinkHref('10.0.0.1:443')).toBe('https://10.0.0.1:443')
  })

  it('已带协议 / 站内地址原样留着', () => {
    for (const href of ['https://a.com', 'http://a.com', 'mailto:a@b.com', 'tel:10086', '/notice/1', '#top', '?x=1', './a', '//cdn.a.com/x']) {
      expect(normalizeLinkHref(href)).toBe(href)
    }
  })

  it('javascript: 原样交给 Tiptap 拒，不被包成 https://javascript:…', () => {
    expect(normalizeLinkHref('javascript:alert(1)')).toBe('javascript:alert(1)')
  })

  it('邮箱补 mailto；空串还是空串', () => {
    expect(normalizeLinkHref('someone@example.com')).toBe('mailto:someone@example.com')
    expect(normalizeLinkHref('   ')).toBe('')
  })
})

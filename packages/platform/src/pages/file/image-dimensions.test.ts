import { describe, expect, it } from 'vitest'

import { exceedsPreviewPixels, IMAGE_PREVIEW_MAX_PIXELS, readImageDimensions } from './image-dimensions'

/**
 * 样本全是 Pillow 真编码出来的 37×23 小图（base64），不是手拼的文件头 ——
 * 手拼等于拿解析器自己的假设去验它自己。
 */
const SAMPLES: Record<string, string> = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAACUAAAAXCAIAAAADThHyAAAAKElEQVR4nGM8ISfHQEfARE/LRu0btW/UvlH7Ru0btW/UvlH7Ru0jCAApBwEyyIYoiAAAAABJRU5ErkJggg==',
  'jpeg baseline':
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAXACUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqAooooAKKKKACiiigAooooAKKKKAP/2Q==',
  'jpeg progressive':
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wgARCAAXACUDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAwX/2gAMAwEAAhADEAAAAYxDUAAAAA//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAEDAQE/AV//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAECAQE/AV//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEAAAAAAP/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPxBf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAgEBPxBf/8QAFBABAAAAAAAAAAAAAAAAAAAAMP/aAAgBAQABPxB//9k=',
  gif: 'R0lGODdhJQAXAIEAAMgeHgAAAAAAAAAAACwAAAAAJQAXAEAIMQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyg/BgQAOw==',
  bmp: 'Qk32AAAAAAAAAD4AAAAoAAAAJQAAABcAAAABAAEAAAAAALgAAADEDgAAxA4AAAIAAAACAAAAAAAAAP///wD/////+AAAAP/////4AAAA//////gAAAD/////+AAAAP/////4AAAA//////gAAAD/////+AAAAP/////4AAAA//////gAAAD/////+AAAAP/////4AAAA//////gAAAD/////+AAAAP/////4AAAA//////gAAAD/////+AAAAP/////4AAAA//////gAAAD/////+AAAAP/////4AAAA//////gAAAD/////+AAAAP/////4AAAA',
  'webp lossy (VP8)':
    'UklGRkgAAABXRUJQVlA4IDwAAAAwAwCdASolABcAPtFmrFCoJaQipWgBABoJZwDOsA8KmggAAP7qZf9VU9frW//jeP8l39u+yk8rGE8AAAA=',
  'webp lossless (VP8L)': 'UklGRh4AAABXRUJQVlA4TBEAAAAvJIAFAAdQjyLXo/+BiOh/AAA=',
  'webp extended (VP8X)':
    'UklGRmwAAABXRUJQVlA4WAoAAAAIAAAAJAAAFgAAVlA4IDwAAAAwAwCdASolABcAPtFmrFCoJaQipWgBABoJZwDOsA8KmggAAP7qZf9VU9frW//jeP8l39u+yk8rGE8AAABFWElGCgAAAE1NACoAAAAIAAA=',
}

/** 20000×20000 纯色 PNG（实测 76KB、预览卡主线程 5.2 秒）的前 33 字节 —— 头读得出来就够 */
const HUGE_PNG_HEAD = 'iVBORw0KGgoAAAANSUhEUgAATiAAAE4gAQAAAADLC3uU'

const bytes = (b64: string) => {
  const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return u8.buffer
}

describe('readImageDimensions', () => {
  for (const [name, b64] of Object.entries(SAMPLES)) {
    it(`${name} → 37×23`, () => {
      expect(readImageDimensions(bytes(b64))).toEqual({ width: 37, height: 23 })
    })
  }

  it('只读文件头：截断到 33 字节的 PNG 也读得出 20000×20000', () => {
    expect(readImageDimensions(bytes(HUGE_PNG_HEAD))).toEqual({ width: 20000, height: 20000 })
  })

  it('认不出的格式 / 截断的文件 → null，而不是抛错', () => {
    expect(readImageDimensions(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>').buffer)).toBeNull()
    expect(readImageDimensions(new ArrayBuffer(0))).toBeNull()
    // JPEG 只剩 SOI + 半个段头：段长度指向文件外
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer)).toBeNull()
  })
})

describe('exceedsPreviewPixels', () => {
  it('线画在 144MP（实测还能接受）和 400MP（实测卡 5 秒）之间', () => {
    expect(exceedsPreviewPixels({ width: 8000, height: 6000 })).toBe(false)
    expect(exceedsPreviewPixels({ width: 12000, height: 12000 })).toBe(false)
    expect(exceedsPreviewPixels({ width: 20000, height: 20000 })).toBe(true)
    expect(12000 * 12000).toBeLessThan(IMAGE_PREVIEW_MAX_PIXELS)
  })

  it('读不出尺寸不拦', () => {
    expect(exceedsPreviewPixels(null)).toBe(false)
  })
})

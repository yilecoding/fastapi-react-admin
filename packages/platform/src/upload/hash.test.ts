import { describe, expect, it } from 'vitest'

import { sha256File } from './hash'

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('sha256File', () => {
  it('和后端的 hashlib.sha256 同一个口径', async () => {
    expect(await sha256File(new Blob(['abc']))).toBe(ABC)
    expect(await sha256File(new Blob([]))).toBe(EMPTY)
  })

  it('分块大小不影响结果，进度走到 1', async () => {
    const data = new Uint8Array(100_003).map((_, i) => i % 251)
    const whole = await sha256File(new Blob([data]))
    const seen: number[] = []
    const chunked = await sha256File(new Blob([data]), { chunkSize: 1000, onProgress: (f) => seen.push(f) })
    expect(chunked).toBe(whole)
    expect(seen.at(-1)).toBe(1)
    expect(seen.every((f, i) => i === 0 || f >= seen[i - 1]!)).toBe(true)
  })

  it('取消信号 → AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sha256File(new Blob(['x']), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

import { describe, expect, it, vi } from 'vitest'

import { isRetryable, partRange, uploadChunked, type ChunkedApi, type MultipartSession } from './chunked'
import { createResumeStore, fingerprint } from './resume'
import { UploadSessionEndedError } from './errors'
import { deferred } from './test-utils'

/** 内存里的 localStorage（node 环境没有） */
function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  }
}

/** 一个假的服务端：记录收到的分片，complete 时按片号拼回来 */
function fakeServer(chunk: number) {
  const sessions = new Map<string, { size: number; parts: Map<number, Uint8Array> }>()
  const calls: string[] = []
  let fail: ((n: number, attempt: number) => unknown) | null = null
  const attempts = new Map<number, number>()
  let seq = 0
  const api: ChunkedApi<Uint8Array> = {
    init: async (file) => {
      const id = `s${++seq}`
      sessions.set(id, { size: file.size, parts: new Map() })
      calls.push(`init ${id}`)
      return view(id)
    },
    status: async (id) => {
      calls.push(`status ${id}`)
      return sessions.has(id) ? view(id) : null
    },
    putPart: async (id, n, blob, { onProgress }) => {
      const a = (attempts.get(n) ?? 0) + 1
      attempts.set(n, a)
      const err = fail?.(n, a)
      if (err) throw err
      const bytes = new Uint8Array(await blob.arrayBuffer())
      onProgress(bytes.length)
      sessions.get(id)!.parts.set(n, bytes)
      calls.push(`put ${n}`)
    },
    complete: async (id) => {
      calls.push(`complete ${id}`)
      const s = sessions.get(id)!
      const out = new Uint8Array(s.size)
      for (const [n, bytes] of s.parts) out.set(bytes, (n - 1) * chunk)
      sessions.delete(id)
      return out
    },
    abort: async (id) => {
      calls.push(`abort ${id}`)
      sessions.delete(id)
    },
  }
  function view(id: string): MultipartSession {
    const s = sessions.get(id)!
    return {
      upload_id: id,
      name: 'f',
      size: s.size,
      chunk_size: chunk,
      total_parts: Math.max(1, Math.ceil(s.size / chunk)),
      uploaded_parts: [...s.parts.keys()].sort((a, b) => a - b),
    }
  }
  return { api, calls, sessions, failWith: (fn: typeof fail) => (fail = fn) }
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)
const fileOf = (data: Uint8Array<ArrayBuffer>, name = 'big.zip') =>
  new File([data], name, { lastModified: 1700000000000 })
const noSleep = async () => {}

describe('partRange', () => {
  it('最后一片是余数', () => {
    expect(partRange(1, 10, 25)).toEqual([0, 10])
    expect(partRange(3, 10, 25)).toEqual([20, 25])
  })
})

describe('isRetryable', () => {
  it('断网 / 5xx / 408 / 429 重试，其余 4xx 和取消不重试', () => {
    expect(isRetryable({ httpStatus: 0 })).toBe(true)
    expect(isRetryable({ httpStatus: 502 })).toBe(true)
    expect(isRetryable({ httpStatus: 429 })).toBe(true)
    expect(isRetryable({ httpStatus: 400 })).toBe(false)
    expect(isRetryable({ httpStatus: 404 })).toBe(false)
    expect(isRetryable(new DOMException('x', 'AbortError'))).toBe(false)
  })
})

describe('uploadChunked', () => {
  it.each([
    { status: 413, retries: 3, attempts: 1 },
    { status: 503, retries: 1, attempts: 2 },
  ])(
    '单片 $status 最终失败会停止其余 worker，退出后不再推进进度，失败会话仍可续传',
    async ({ status, retries, attempts }) => {
      const server = fakeServer(10)
      const resume = createResumeStore('user-a', memoryStorage())
      const file = fileOf(bytes(100))
      const failure = Object.assign(new Error('part failed'), { httpStatus: status })
      const blocked = new Map<number, ReturnType<typeof deferred<void>>>()
      const signals: AbortSignal[] = []
      const progresses: Array<() => void> = []
      const onBytes = vi.fn()
      const failedPart = vi.fn(async () => {
        throw failure
      })
      const api = {
        ...server.api,
        putPart: vi.fn((_id: string, n: number, _blob: Blob, ctx: Parameters<typeof server.api.putPart>[3]) => {
          if (n === 2) return failedPart()
          const work = deferred<void>()
          blocked.set(n, work)
          signals.push(ctx.signal)
          progresses.push(() => ctx.onProgress(5))
          return work.promise
        }),
      }
      let finished = false
      const outcome = uploadChunked(file, api, {
        signal: new AbortController().signal,
        onBytes,
        resume,
        retries,
        sleep: noSleep,
      }).catch((error: unknown) => {
        finished = true
        return error
      })

      await vi.waitFor(() => expect(signals).toHaveLength(2))
      await vi.waitFor(() => expect(signals.every((s) => s.aborted)).toBe(true))
      expect(failedPart).toHaveBeenCalledTimes(attempts)
      expect(finished).toBe(false) // 要等正在取消的 PUT 退出，队列才能开始下一项
      const reports = onBytes.mock.calls.length
      for (const progress of progresses) progress() // 即使传输层晚到一条 progress，也不能再冒上去
      for (const work of blocked.values()) work.reject(new DOMException('aborted', 'AbortError'))
      expect(await outcome).toBe(failure)
      expect(api.putPart.mock.calls.map(([, n]) => n).every((n) => n <= 3)).toBe(true)
      expect(onBytes).toHaveBeenCalledTimes(reports)
      expect(server.calls).not.toContain('complete s1')
      expect(server.calls).not.toContain('abort s1')
      expect(resume.get(fingerprint(file))?.upload_id).toBe('s1')
    },
  )

  it('换身份中止会保留续传记录与服务端会话，用户主动取消仍会删除', async () => {
    const server = fakeServer(10)
    const resume = createResumeStore('user-a', memoryStorage())
    const controller = new AbortController()
    const file = fileOf(bytes(30))
    server.failWith(() => {
      controller.abort(new UploadSessionEndedError())
      return null
    })
    await expect(
      uploadChunked(file, server.api, {
        signal: controller.signal,
        onBytes: () => {},
        resume,
        concurrency: 1,
      }),
    ).rejects.toBeInstanceOf(UploadSessionEndedError)
    expect(resume.get(fingerprint(file))?.upload_id).toBe('s1')
    expect(server.sessions.has('s1')).toBe(true)
    expect(server.calls).not.toContain('abort s1')
  })

  it('某片在退避时另一片失败，退避也会中断，不等待下一轮重试', async () => {
    const server = fakeServer(10)
    const second = deferred<void>()
    const failure = Object.assign(new Error('too large'), { httpStatus: 413 })
    const sleep = vi.fn(() => new Promise<void>(() => {}))
    const api = {
      ...server.api,
      putPart: vi.fn(async (_id: string, n: number) => {
        if (n === 1) throw { httpStatus: 503 }
        return second.promise
      }),
    }
    const outcome = uploadChunked(fileOf(bytes(20)), api, {
      signal: new AbortController().signal,
      onBytes: () => {},
      sleep,
    }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce())
    second.reject(failure)
    expect(await outcome).toBe(failure)
    expect(api.putPart).toHaveBeenCalledTimes(2)
  })

  it('拼回来的字节和原文件一致，进度走到 total，续传记录用完就删', async () => {
    const server = fakeServer(10)
    const resume = createResumeStore('user-a', memoryStorage())
    const data = bytes(37)
    const seen: number[] = []
    const out = await uploadChunked(fileOf(data), server.api, {
      signal: new AbortController().signal,
      onBytes: (l) => seen.push(l),
      resume,
      sleep: noSleep,
    })
    expect([...out]).toEqual([...data])
    expect(seen.at(-1)).toBe(37)
    expect(resume.list()).toEqual([])
  })

  it('🔴 续传：同一个文件、会话还活着 → 只补缺的片，已经传过的不重传', async () => {
    const server = fakeServer(10)
    const storage = memoryStorage()
    const resume = createResumeStore('user-a', storage)
    const data = bytes(40)
    const file = fileOf(data)
    // 第一次：传到第 2 片时断网（重试用尽），会话和续传记录留着
    server.failWith((n) => (n >= 3 ? { httpStatus: 0 } : null))
    await expect(
      uploadChunked(file, server.api, {
        signal: new AbortController().signal,
        onBytes: () => {},
        resume,
        sleep: noSleep,
        concurrency: 1,
        retries: 0,
      }),
    ).rejects.toMatchObject({ httpStatus: 0 })
    expect(resume.get(fingerprint(file))?.upload_id).toBe('s1')

    // 「刷新」之后重新选同一个文件：status → 只 put 3、4 → complete
    server.failWith(null)
    server.calls.length = 0
    const out = await uploadChunked(file, server.api, {
      signal: new AbortController().signal,
      onBytes: () => {},
      resume: createResumeStore('user-a', storage),
      sleep: noSleep,
    })
    expect([...out]).toEqual([...data])
    expect(server.calls.filter((c) => c.startsWith('put')).sort()).toEqual(['put 3', 'put 4'])
    expect(server.calls).not.toContain('init s2')
  })

  it('会话已经过期（服务端 404）→ 重开一个，从头传', async () => {
    const server = fakeServer(10)
    const resume = createResumeStore('user-a', memoryStorage())
    const file = fileOf(bytes(15))
    resume.set(fingerprint(file), {
      upload_id: 'gone',
      name: file.name,
      size: 15,
      lastModified: file.lastModified,
      created_at: Date.now(),
    })
    await uploadChunked(file, server.api, {
      signal: new AbortController().signal,
      onBytes: () => {},
      resume,
      sleep: noSleep,
    })
    expect(server.calls).toContain('status gone')
    expect(server.calls).toContain('init s1')
  })

  it('网络错误按次重试，4xx 不重试', async () => {
    const server = fakeServer(10)
    server.failWith((n, attempt) => (n === 1 && attempt < 3 ? { httpStatus: 503 } : null))
    await uploadChunked(fileOf(bytes(5)), server.api, {
      signal: new AbortController().signal,
      onBytes: () => {},
      sleep: noSleep,
    })

    const strict = fakeServer(10)
    strict.failWith(() => ({ httpStatus: 400 }))
    let calls = 0
    const api = {
      ...strict.api,
      putPart: async (...args: Parameters<typeof strict.api.putPart>) => {
        calls++
        return strict.api.putPart(...args)
      },
    }
    await expect(
      uploadChunked(fileOf(bytes(5)), api, { signal: new AbortController().signal, onBytes: () => {}, sleep: noSleep }),
    ).rejects.toMatchObject({ httpStatus: 400 })
    expect(calls).toBe(1)
  })

  it('取消 = 放弃：删服务端会话、删续传记录', async () => {
    const server = fakeServer(10)
    const resume = createResumeStore('user-a', memoryStorage())
    const controller = new AbortController()
    server.failWith((n) => {
      if (n === 2) controller.abort()
      return null
    })
    const file = fileOf(bytes(30))
    await expect(
      uploadChunked(file, server.api, {
        signal: controller.signal,
        onBytes: () => {},
        resume,
        sleep: noSleep,
        concurrency: 1,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.calls).toContain('abort s1')
    expect(resume.list()).toEqual([])
  })
})
